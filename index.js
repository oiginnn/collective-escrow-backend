import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";

const app = express();
app.use(express.json());

/* ================= CONFIG ================= */

const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

/* ================= HELPERS ================= */

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

async function sendMessage(chatId, text, replyMarkup) {
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      reply_markup: replyMarkup
    })
  });
}

/* ============ TELEGRAM VERIFY ============ */

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

/* ================= BOT WEBHOOK ================= */

app.post("/webhook", async (req, res) => {
  try {
    const message = req.body.message;
    if (!message) return res.sendStatus(200);

    const chatId = message.chat.id;
    const telegramId = String(message.from.id);
    const text = (message.text || "").trim();

    if (text.startsWith("/start")) {
      // get or create user
      let user;
      const userRes = await supabase(
        `users?telegram_id=eq.${telegramId}`,
        "GET"
      );
      const users = await userRes.json();
      user = users[0];

      if (!user) {
        const createUserRes = await supabase("users", "POST", {
          telegram_id: telegramId,
          role: "user"
        });
        const created = await createUserRes.json();
        user = created[0];
      }

      // ensure balance
      const balRes = await supabase(
        `user_balances?user_id=eq.${user.id}`,
        "GET"
      );
      const balances = await balRes.json();
      if (balances.length === 0) {
        await supabase("user_balances", "POST", {
          user_id: user.id,
          balance: 0
        });
      }

      await sendMessage(
        chatId,
        "Welcome 👋\n\nOpen the app to continue.",
        {
          inline_keyboard: [[
            {
              text: "Open App",
              web_app: {
                url: "https://collective-escrow-miniapp.vercel.app"
              }
            }
          ]]
        }
      );
    }

    return res.sendStatus(200);
  } catch (e) {
    console.error("Webhook error:", e);
    return res.sendStatus(200);
  }
});

/* ================= API ================= */

app.post("/api/me", async (req, res) => {
  const { initData } = req.body;

  if (!initData || !verifyTelegramInitData(initData)) {
    return res.status(403).json({ error: "Invalid Telegram signature" });
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

  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }

  const balRes = await supabase(
    `user_balances?user_id=eq.${user.id}`,
    "GET"
  );
  const balances = await balRes.json();

  return res.json({
    telegram_id: telegramId,
    balance: balances[0]?.balance ?? 0
  });
});

/* ================= HEALTH ================= */

app.get("/", (_, res) => res.send("Backend OK"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
