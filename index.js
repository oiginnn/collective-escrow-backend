import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

const MINI_APP_URL = "https://collective-escrow-miniapp.vercel.app";

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

function verifyTelegramInitData(initData) {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const secretKey = crypto
    .createHash("sha256")
    .update(BOT_TOKEN)
    .digest();

  const computedHash = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  return computedHash === hash;
}

app.post("/api/me", async (req, res) => {
  const { initData } = req.body;

  if (!initData || !verifyTelegramInitData(initData)) {
    return res.status(403).json({ error: "Access denied" });
  }

  const params = new URLSearchParams(initData);
  const tgUser = JSON.parse(params.get("user"));
  const telegramId = String(tgUser.id);

  const userRes = await supabase(
    `users?telegram_id=eq.${telegramId}`,
    "GET"
  );
  const users = await userRes.json();
  const user = users[0];

  const balRes = await supabase(
    `user_balances?user_id=eq.${user.id}`,
    "GET"
  );
  const balances = await balRes.json();

  res.json({ balance: balances[0]?.balance ?? 0 });
});

app.listen(process.env.PORT || 3000);
