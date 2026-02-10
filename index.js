import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";

const app = express();
app.use(express.json());

/* ================== CONFIG ================== */

const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

/* ================== HELPERS ================== */

function verifyTelegramInitData(initData) {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort()
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const secretKey = crypto
    .createHash("sha256")
    .update(BOT_TOKEN)
    .digest();

  const hmac = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  return hmac === hash;
}

async function supabase(path, method = "GET", body) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation"
    },
    body: body ? JSON.stringify(body) : undefined
  });
}

/* ================== API ================== */

app.post("/api/me", async (req, res) => {
  const { initData } = req.body;

  if (!initData || !verifyTelegramInitData(initData)) {
    return res.status(403).json({ error: "Invalid Telegram signature" });
  }

  const params = new URLSearchParams(initData);
  const user = JSON.parse(params.get("user"));
  const telegramId = String(user.id);

  // get user
  const userRes = await supabase(
    `users?telegram_id=eq.${telegramId}`,
    "GET"
  );
  const users = await userRes.json();
  const dbUser = users[0];

  if (!dbUser) {
    return res.status(404).json({ error: "User not found" });
  }

  // get balance
  const balanceRes = await supabase(
    `user_balances?user_id=eq.${dbUser.id}`,
    "GET"
  );
  const balances = await balanceRes.json();

  return res.json({
    user: {
      id: dbUser.id,
      telegram_id: telegramId
    },
    balance: balances[0]?.balance ?? 0
  });
});

/* ================== WEBHOOK (BOT) ================== */

app.post("/webhook", async (req, res) => {
  // bot logic already implemented earlier
  return res.sendStatus(200);
});

/* ================== HEALTH ================== */

app.get("/", (req, res) => {
  res.send("Backend is running");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
