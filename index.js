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
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
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

async function getBalanceRow(userId) {
  const r = await sb(`user_balances?user_id=eq.${userId}&select=user_id,balance`, "GET");
  const arr = await r.json();
  return arr[0] || null;
}

async function getLotById(lotId) {
  const r = await sb(
    `lots?id=eq.${lotId}&select=id,creator_id,status,currency,title,goal_amount,price_per_participation,ends_at,media,description,created_at`,
    "GET"
  );
  const arr = await r.json();
  return arr[0] || null;
}

async function tgSendMessage(chatId, text, extra = {}) {
  return fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, ...extra }),
  });
}

async function authInitData(req, res) {
  const { initData } = req.body || {};
  if (!initData || !verifyTelegramInitData(initData)) {
    res.status(403).json({ error: "access_denied_initdata" });
    return null;
  }
  const telegramId = getTelegramIdFromInitData(initData);
  if (!telegramId) {
    res.status(403).json({ error: "access_denied_user" });
    return null;
  }
  const user = await ensureUserExists(telegramId);
  if (!user) {
    res.status(500).json({ error: "user_create_failed" });
    return null;
  }
  return { initData, telegramId, user };
}

// ---------- routes ----------
app.get("/", (_, res) => res.send("Backend OK"));
app.get("/api/version", (_, res) => res.send("donate-v5"));

// --- Telegram webhook (бот) ---
app.post("/webhook", async (req, res) => {
  try {
    const message = req.body.message;
    if (!message) return res.sendStatus(200);

    const chatId = message.chat.id;
    const telegramId = String(message.from?.id || "");
    const text = (message.text || "").trim();

    if (telegramId) await ensureUserExists(telegramId);

    if (text.startsWith("/start") || text.startsWith("/app")) {
      await tgSendMessage(
        chatId,
        "Welcome 👋\n\nOpen the app to view lots, donate, and participate.",
        {
          reply_markup: {
            inline_keyboard: [[{ text: "Open app", web_app: { url: MINI_APP_URL } }]],
          },
        }
      );
      return res.sendStatus(200);
    }

    if (text.startsWith("/help")) {
      await tgSendMessage(chatId, "Commands:\n/start — Open app button\n/app — Open app\n/help");
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
 * progress = participants only
 */
app.get("/api/lots", async (req, res) => {
  try {
    const lotsRes = await sb(
      "lots?status=eq.active&select=id,title,description,media,price_per_participation,goal_amount,ends_at,currency,created_at&order=created_at.desc&limit=50",
      "GET"
    );
    if (!lotsRes.ok) return res.status(500).json({ error: "supabase_lots_fetch_failed", detail: await lotsRes.text() });

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
 * /api/me (private)
 * returns: balance, role, isAdmin
 */
app.post("/api/me", async (req, res) => {
  try {
    const auth = await authInitData(req, res);
    if (!auth) return;

    const bal = await getBalanceRow(auth.user.id);
    const balance = Number(bal?.balance || 0);

    res.json({
      user: { id: auth.user.id, role: auth.user.role, telegram_id: auth.user.telegram_id },
      balance,
      isAdmin: isAdminTelegramId(auth.telegramId),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server_error" });
  }
});

/**
 * Donate (private)
 * body: { initData, lotId, amount }
 */
app.post("/api/donate", async (req, res) => {
  try {
    const auth = await authInitData(req, res);
    if (!auth) return;

    const { lotId, amount } = req.body;

    const lot = await getLotById(lotId);
    if (!lot) return res.status(404).json({ error: "lot_not_found" });
    if (lot.status !== "active") return res.status(400).json({ error: "lot_not_active" });

    const a = Number(amount);
    if (!Number.isFinite(a) || a < 1) return res.status(400).json({ error: "amount_min_1" });

    const fee = Math.round(a * 0.01 * 100) / 100;
    const sellerAmount = Math.round((a - fee) * 100) / 100;

    const insDonation = await sb("donations", "POST", {
      lot_id: lot.id,
      user_id: auth.user.id,
      amount: a,
      platform_fee: fee,
      seller_amount: sellerAmount,
      status: "confirmed",
    });
    if (!insDonation.ok) return res.status(500).json({ error: "donation_insert_failed", detail: await insDonation.text() });

    const insLedger1 = await sb("ledger", "POST", {
      actor_user_id: auth.user.id,
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
        actor_user_id: auth.user.id,
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
 * Participate (private) — A2
 * body: { initData, lotId }
 * - checks user balance >= price_per_participation
 * - inserts lot_participants (reserved)
 * - decreases user_balances.balance
 * - writes ledger participation_lock
 */
app.post("/api/participate", async (req, res) => {
  try {
    const auth = await authInitData(req, res);
    if (!auth) return;

    const { lotId } = req.body;

    const lot = await getLotById(lotId);
    if (!lot) return res.status(404).json({ error: "lot_not_found" });
    if (lot.status !== "active") return res.status(400).json({ error: "lot_not_active" });

    const price = Number(lot.price_per_participation || 0);
    if (!(price > 0)) return res.status(400).json({ error: "lot_price_invalid" });

    const balRow = await getBalanceRow(auth.user.id);
    const balance = Number(balRow?.balance || 0);

    if (balance < price) {
      return res.status(400).json({ error: "insufficient_balance", need: price, balance });
    }

    // 1) insert participant (unique index prevents duplicates)
    const insPart = await sb("lot_participants", "POST", {
      lot_id: lot.id,
      user_id: auth.user.id,
      amount: price,
      status: "reserved",
    });

    if (!insPart.ok) {
      const t = await insPart.text();
      // Unique violation -> already participated
      if (t.includes("duplicate key value") || t.includes("uq_lot_participants_lot_user")) {
        return res.status(400).json({ error: "already_participated" });
      }
      return res.status(500).json({ error: "participant_insert_failed", detail: t });
    }

    // 2) update balance (decrease)
    const newBalance = Math.round((balance - price) * 100) / 100;
    const updBal = await sb(`user_balances?user_id=eq.${auth.user.id}`, "PATCH", { balance: newBalance });
    if (!updBal.ok) return res.status(500).json({ error: "balance_update_failed", detail: await updBal.text() });

    // 3) ledger record
    const insLedger = await sb("ledger", "POST", {
      actor_user_id: auth.user.id,
      counterparty_user_id: null,
      lot_id: lot.id,
      type: "participation_lock",
      amount: price,
      status: "confirmed",
      meta: { currency: lot.currency },
    });
    if (!insLedger.ok) return res.status(500).json({ error: "ledger_participation_failed", detail: await insLedger.text() });

    return res.json({ ok: true, newBalance });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "server_error" });
  }
});

/**
 * My donations (private)
 */
app.post("/api/me/donations", async (req, res) => {
  try {
    const auth = await authInitData(req, res);
    if (!auth) return;

    const r = await sb(
      `donations?user_id=eq.${auth.user.id}&select=id,lot_id,amount,created_at,status&order=created_at.desc&limit=200`,
      "GET"
    );
    if (!r.ok) return res.status(500).json({ error: "donations_fetch_failed", detail: await r.text() });

    const items = await r.json();
    return res.json({ donations: items });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "server_error" });
  }
});

/**
 * My participations (private)
 */
app.post("/api/me/participations", async (req, res) => {
  try {
    const auth = await authInitData(req, res);
    if (!auth) return;

    const r = await sb(
      `lot_participants?user_id=eq.${auth.user.id}&select=id,lot_id,amount,status,created_at&order=created_at.desc&limit=200`,
      "GET"
    );
    if (!r.ok) return res.status(500).json({ error: "participations_fetch_failed", detail: await r.text() });

    const items = await r.json();
    return res.json({ participations: items });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "server_error" });
  }
});

/**
 * Admin test topup (private)
 * body: { initData, userTelegramId, amount }
 * adds amount to user's balance
 */
app.post("/api/admin/topup", async (req, res) => {
  try {
    const auth = await authInitData(req, res);
    if (!auth) return;

    if (!isAdminTelegramId(auth.telegramId)) {
      return res.status(403).json({ error: "admin_only" });
    }

    const { userTelegramId, amount } = req.body;
    const a = Number(amount);
    if (!Number.isFinite(a) || a <= 0) return res.status(400).json({ error: "amount_invalid" });

    const target = await getUserByTelegramId(String(userTelegramId));
    if (!target) return res.status(404).json({ error: "target_user_not_found" });

    const balRow = await getBalanceRow(target.id);
    const oldBal = Number(balRow?.balance || 0);
    const newBal = Math.round((oldBal + a) * 100) / 100;

    const updBal = await sb(`user_balances?user_id=eq.${target.id}`, "PATCH", { balance: newBal });
    if (!updBal.ok) return res.status(500).json({ error: "balance_update_failed", detail: await updBal.text() });

    await sb("ledger", "POST", {
      actor_user_id: auth.user.id,
      counterparty_user_id: target.id,
      lot_id: null,
      type: "admin_topup_test",
      amount: a,
      status: "confirmed",
      meta: {},
    });

    return res.json({ ok: true, newBalance: newBal });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "server_error" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on ${PORT}`));
