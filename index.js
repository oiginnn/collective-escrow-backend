import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";

const app = express();
app.use(express.json());

// CORS
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_TG_IDS = (process.env.ADMIN_TG_IDS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

async function sb(path, method = "GET", body) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation"
    },
    body: body ? JSON.stringify(body) : undefined
  });
  return r;
}

// Telegram initData verify
function verifyTelegramInitData(initData) {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return false;
  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const secretKey = crypto.createHash("sha256").update(BOT_TOKEN).digest();
  const computedHash = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  return computedHash === hash;
}

function getTelegramIdFromInitData(initData) {
  const params = new URLSearchParams(initData);
  const userRaw = params.get("user");
  if (!userRaw) return null;
  const tgUser = JSON.parse(userRaw);
  return String(tgUser.id);
}

async function getUserByTelegramId(telegramId) {
  const r = await sb(`users?telegram_id=eq.${telegramId}&select=id,telegram_id,role`, "GET");
  const arr = await r.json();
  return arr[0] || null;
}

async function getLotById(lotId) {
  const r = await sb(`lots?id=eq.${lotId}&select=id,creator_id,status,currency,goal_amount,price_per_participation,ends_at,title`, "GET");
  const arr = await r.json();
  return arr[0] || null;
}

function isAdminTelegramId(telegramId) {
  return ADMIN_TG_IDS.includes(String(telegramId));
}

app.get("/", (_, res) => res.send("Backend OK"));

/**
 * Public lots feed (NO donated totals shown)
 */
app.get("/api/lots", async (req, res) => {
  try {
    const lotsRes = await sb(
      "lots?status=eq.active&select=id,title,description,media,price_per_participation,goal_amount,ends_at,currency,created_at&order=created_at.desc&limit=50",
      "GET"
    );
    if (!lotsRes.ok) return res.status(500).json({ error: await lotsRes.text() });

    const lots = await lotsRes.json();

    const enriched = [];
    for (const lot of lots) {
      // collected from participants only
      const partsRes = await sb(
        `lot_participants?lot_id=eq.${lot.id}&status=eq.reserved&select=amount`,
        "GET"
      );
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
 * - fee 1%
 * - insert donations row
 * - insert ledger rows: donation (to seller) + platform_fee
 */
app.post("/api/donate", async (req, res) => {
  try {
    const { initData, lotId, amount } = req.body;

    if (!initData || !verifyTelegramInitData(initData)) {
      return res.status(403).json({ error: "Access denied" });
    }

    const telegramId = getTelegramIdFromInitData(initData);
    if (!telegramId) return res.status(403).json({ error: "Access denied" });

    const user = await getUserByTelegramId(telegramId);
    if (!user) return res.status(404).json({ error: "user_not_found" });

    const lot = await getLotById(lotId);
    if (!lot) return res.status(404).json({ error: "lot_not_found" });
    if (lot.status !== "active") return res.status(400).json({ error: "lot_not_active" });

    const a = Number(amount);
    if (!Number.isFinite(a) || a < 1) {
      return res.status(400).json({ error: "amount_min_1" });
    }

    // fee 1%
    const fee = Math.round(a * 0.01 * 100) / 100; // 2 decimals
    const sellerAmount = Math.round((a - fee) * 100) / 100;

    // 1) donation record
    const insDonation = await sb("donations", "POST", {
      lot_id: lot.id,
      user_id: user.id,
      amount: a,
      platform_fee: fee,
      seller_amount: sellerAmount,
      status: "confirmed"
    });
    if (!insDonation.ok) return res.status(500).json({ error: await insDonation.text() });

    // 2) ledger: donation to seller
    await sb("ledger", "POST", {
      actor_user_id: user.id,
      counterparty_user_id: lot.creator_id,
      lot_id: lot.id,
      type: "donation",
      amount: sellerAmount,
      status: "confirmed",
      meta: { currency: lot.currency }
    });

    // 3) ledger: platform fee
    if (fee > 0) {
      await sb("ledger", "POST", {
        actor_user_id: user.id,
        counterparty_user_id: null,
        lot_id: lot.id,
        type: "platform_fee",
        amount: fee,
        status: "confirmed",
        meta: { currency: lot.currency }
      });
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
      return res.status(403).json({ error: "Access denied" });
    }

    const telegramId = getTelegramIdFromInitData(initData);
    const user = await getUserByTelegramId(telegramId);
    if (!user) return res.status(404).json({ error: "user_not_found" });

    const r = await sb(
      `donations?user_id=eq.${user.id}&select=id,lot_id,amount,platform_fee,seller_amount,created_at,status&order=created_at.desc&limit=200`,
      "GET"
    );
    if (!r.ok) return res.status(500).json({ error: await r.text() });

    const items = await r.json();

    // add lot titles (small join-like)
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
      currency: lotMap[i.lot_id]?.currency || "USDT"
    }));

    return res.json({ donations: out });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "server_error" });
  }
});

/**
 * Seller history (private): donations for my lots
 * body: { initData }
 */
app.post("/api/seller/donations", async (req, res) => {
  try {
    const { initData } = req.body;
    if (!initData || !verifyTelegramInitData(initData)) {
      return res.status(403).json({ error: "Access denied" });
    }

    const telegramId = getTelegramIdFromInitData(initData);
    const user = await getUserByTelegramId(telegramId);
    if (!user) return res.status(404).json({ error: "user_not_found" });

    // find lots where creator_id=user.id
    const lotsRes = await sb(`lots?creator_id=eq.${user.id}&select=id,title,currency&limit=500`, "GET");
    const lots = await lotsRes.json();
    const lotIds = lots.map(l => l.id);

    if (!lotIds.length) return res.json({ donations: [] });

    const inList = `(${lotIds.map(id => `"${id}"`).join(",")})`;
    const r = await sb(
      `donations?lot_id=in.${encodeURIComponent(inList)}&select=id,lot_id,user_id,amount,platform_fee,seller_amount,created_at,status&order=created_at.desc&limit=500`,
      "GET"
    );
    if (!r.ok) return res.status(500).json({ error: await r.text() });

    const items = await r.json();
    const lotMap = Object.fromEntries(lots.map(l => [l.id, l]));

    const out = items.map(i => ({
      ...i,
      lot_title: lotMap[i.lot_id]?.title || "Lot",
      currency: lotMap[i.lot_id]?.currency || "USDT"
    }));

    return res.json({ donations: out });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "server_error" });
  }
});

/**
 * Admin: all donations
 * body: { initData }
 */
app.post("/api/admin/donations", async (req, res) => {
  try {
    const { initData } = req.body;
    if (!initData || !verifyTelegramInitData(initData)) {
      return res.status(403).json({ error: "Access denied" });
    }

    const telegramId = getTelegramIdFromInitData(initData);
    if (!isAdminTelegramId(telegramId)) {
      return res.status(403).json({ error: "admin_only" });
    }

    const r = await sb(
      `donations?select=id,lot_id,user_id,amount,platform_fee,seller_amount,created_at,status&order=created_at.desc&limit=500`,
      "GET"
    );
    if (!r.ok) return res.status(500).json({ error: await r.text() });

    const items = await r.json();
    return res.json({ donations: items });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "server_error" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on ${PORT}`));
