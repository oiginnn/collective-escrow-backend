import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";

const app = express();
app.use(express.json());

// ----- CORS -----
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const ADMIN_TG_IDS = (process.env.ADMIN_TG_IDS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const MINI_APP_URL = process.env.MINI_APP_URL || "https://collective-escrow-miniapp.vercel.app/";

// ----- supabase helper -----
async function sb(path, method = "GET", body) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r;
}

// ✅ Telegram Mini Apps initData verification (correct)
function verifyTelegramInitData(initData) {
  try {
    if (!BOT_TOKEN) return false;

    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    if (!hash) return false;
    params.delete("hash");

    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");

    const secretKey = crypto
      .createHmac("sha256", "WebAppData")
      .update(BOT_TOKEN)
      .digest();

    const computedHash = crypto
      .createHmac("sha256", secretKey)
      .update(dataCheckString)
      .digest("hex");

    return computedHash === hash;
  } catch {
    return false;
  }
}

function getTelegramIdFromInitData(initData) {
  const params = new URLSearchParams(initData);
  const userRaw = params.get("user");
  if (!userRaw) return null;
  const tgUser = JSON.parse(userRaw);
  return String(tgUser.id);
}

function isAdminTelegramId(telegramId) {
  return ADMIN_TG_IDS.includes(String(telegramId));
}

async function getUserByTelegramId(telegramId) {
  const r = await sb(`users?telegram_id=eq.${telegramId}&select=id,telegram_id,role`, "GET");
  const arr = await r.json();
  return arr[0] || null;
}

async function ensureUserExists(telegramId) {
  let user = await getUserByTelegramId(telegramId);
  if (user) return user;

  const cr = await sb("users", "POST", { telegram_id: telegramId, role: "user" });
  if (cr.ok) {
    const created = await cr.json();
    user = created[0];
  } else {
    user = await getUserByTelegramId(telegramId);
  }

  if (user?.id) {
    await sb("user_balances", "POST", { user_id: user.id, balance: 0 });
  }

  return user;
}

async function getLotById(lotId) {
  const r = await sb(`lots?id=eq.${lotId}&select=id,creator_id,status,currency,title`, "GET");
  const arr = await r.json();
  return arr[0] || null;
}

async function tgSendMessage(chatId, text, extra = {}) {
  return fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      ...extra,
    }),
  });
}

// ---------- routes ----------
app.get("/", (_, res) => res.send("Backend OK"));
app.get("/api/version", (_, res) => res.send("donate-v4"));

// --- Telegram webhook (бот) ---
app.post("/webhook", async (req, res) => {
  try {
    const message = req.body.message;
    if (!message) return res.sendStatus(200);

    const chatId = message.chat.id;
    const telegramId = String(message.from?.id || "");
    const text = (message.text || "").trim();

    // ensure user exists for any interaction
    if (telegramId) await ensureUserExists(telegramId);

    // /start or /app → send button to open mini app
    if (text.startsWith("/start") || text.startsWith("/app")) {
      await tgSendMessage(
        chatId,
        "Welcome 👋\n\nOpen the app to view lots, donate, and participate.",
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "Open app",
                  web_app: { url: MINI_APP_URL },
                },
              ],
            ],
          },
        }
      );

      return res.sendStatus(200);
    }

    // /help
    if (text.startsWith("/help")) {
      await tgSendMessage(
        chatId,
        "Commands:\n/start — show Open app button\n/app — open the app\n/help — this message"
      );
      return res.sendStatus(200);
    }

    return res.sendStatus(200);
  } catch (e) {
    console.error(e);
    return res.sendStatus(200);
  }
});

/**
 * Public lots feed (NO donation totals)
 */
app.get("/api/lots", async (req, res) => {
  try {
    const lotsRes = await sb(
      "lots?status=eq.active&select=id,title,description,media,price_per_participation,goal_amount,ends_at,currency,created_at&order=created_at.desc&limit=50",
      "GET"
    );
    if (!lotsRes.ok) {
      return res.status(500).json({ error: "supabase_lots_fetch_failed", detail: await lotsRes.text() });
    }

    const lots = await lotsRes.json();

    const enriched = [];
    for (const lot of lots) {
      const partsRes = await sb(`lot_participants?lot_id=eq.${lot.id}&status=eq.reserved&select=amount`, "GET");
      let collected = 0;
      if (partsRes.ok) {
        const parts = await partsRes.json();
        for (const p of parts) collected += Number(p.amount || 0);
      }

      const goal = Number(lot.goal_amount || 0);
      const progress = goal > 0 ? Math.min(1, collected / goal) : 0;
      enriched.push({ ...lot, collected, progress });
    }

    return res.json({ lots: enriched });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "server_error" });
  }
});

/**
 * Donate (private)
 * body: { initData, lotId, amount }
 */
app.post("/api/donate", async (req, res) => {
  try {
    const { initData, lotId, amount } = req.body;

    if (!initData || !verifyTelegramInitData(initData)) {
      return res.status(403).json({ error: "access_denied_initdata" });
    }

    const telegramId = getTelegramIdFromInitData(initData);
    if (!telegramId) return res.status(403).json({ error: "access_denied_user" });

    const user = await ensureUserExists(telegramId);
    if (!user) return res.status(500).json({ error: "user_create_failed" });

    const lot = await getLotById(lotId);
    if (!lot) return res.status(404).json({ error: "lot_not_found" });
    if (lot.status !== "active") return res.status(400).json({ error: "lot_not_active" });

    const a = Number(amount);
    if (!Number.isFinite(a) || a < 1) return res.status(400).json({ error: "amount_min_1" });

    const fee = Math.round(a * 0.01 * 100) / 100;
    const sellerAmount = Math.round((a - fee) * 100) / 100;

    const insDonation = await sb("donations", "POST", {
      lot_id: lot.id,
      user_id: user.id,
      amount: a,
      platform_fee: fee,
      seller_amount: sellerAmount,
      status: "confirmed",
    });
    if (!insDonation.ok) return res.status(500).json({ error: "donation_insert_failed", detail: await insDonation.text() });

    const insLedger1 = await sb("ledger", "POST", {
      actor_user_id: user.id,
      counterparty_user_id: lot.creator_id,
      lot_id: lot.id,
      type: "donation",
      amount: sellerAmount,
      status: "confirmed",
      meta: { currency: lot.currency },
    });
    if (!insLedger1.ok) return res.status(500).json({ error: "ledger_donation_failed", detail: await insLedger1.text() });

    if (fee > 0) {
      const insLedger2 = await sb("ledger", "POST", {
        actor_user_id: user.id,
        counterparty_user_id: null,
        lot_id: lot.id,
        type: "platform_fee",
        amount: fee,
        status: "confirmed",
        meta: { currency: lot.currency },
      });
      if (!insLedger2.ok) return res.status(500).json({ error: "ledger_fee_failed", detail: await insLedger2.text() });
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "server_error" });
  }
});

/**
 * Donor history (private)
 * body: { initData }
 */
app.post("/api/me/donations", async (req, res) => {
  try {
    const { initData } = req.body;

    if (!initData || !verifyTelegramInitData(initData)) {
      return res.status(403).json({ error: "access_denied_initdata" });
    }

    const telegramId = getTelegramIdFromInitData(initData);
    if (!telegramId) return res.status(403).json({ error: "access_denied_user" });

    const user = await ensureUserExists(telegramId);
    if (!user) return res.status(500).json({ error: "user_create_failed" });

    const r = await sb(
      `donations?user_id=eq.${user.id}&select=id,lot_id,amount,created_at,status&order=created_at.desc&limit=200`,
      "GET"
    );
    if (!r.ok) return res.status(500).json({ error: "donations_fetch_failed", detail: await r.text() });

    const items = await r.json();

    const lotIds = [...new Set(items.map(i => i.lot_id))].filter(Boolean);
    let lotMap = {};
    if (lotIds.length) {
      const inList = `(${lotIds.map(id => `"${id}"`).join(",")})`;
      const lr = await sb(`lots?id=in.${encodeURIComponent(inList)}&select=id,title,currency`, "GET");
      if (lr.ok) {
        const lots = await lr.json();
        lotMap = Object.fromEntries(lots.map(l => [l.id, l]));
      }
    }

    const out = items.map(i => ({
      ...i,
      lot_title: lotMap[i.lot_id]?.title || "Lot",
      currency: lotMap[i.lot_id]?.currency || "USDT",
    }));

    return res.json({ donations: out });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "server_error" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on ${PORT}`));
