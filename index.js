import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

/* ================== CONFIG ================== */

const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

/* ================== HELPERS ================== */

async function supabase(path, method = "GET", body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation"
    },
    body: body ? JSON.stringify(body) : undefined
  });

  return res;
}

async function sendMessage(chatId, text) {
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text
    })
  });
}

/* ================== WEBHOOK ================== */

app.post("/webhook", async (req, res) => {
  try {
    const message = req.body.message;
    if (!message) return res.sendStatus(200);

    const chatId = message.chat.id;
    const telegramId = String(message.from.id);
    const text = (message.text || "").trim();

    /* ---------- /start ---------- */
    if (text.startsWith("/start")) {
      // 1. GET user
      let user;
      const getUserRes = await supabase(
        `users?telegram_id=eq.${telegramId}`,
        "GET"
      );
      const users = await getUserRes.json();
      user = users[0];

      // 2. CREATE user if not exists
      if (!user) {
        const createUserRes = await supabase("users", "POST", {
          telegram_id: telegramId,
          role: "user"
        });
        const createdUsers = await createUserRes.json();
        user = createdUsers[0];
      }

      // 3. GET balance
      const balanceCheckRes = await supabase(
        `user_balances?user_id=eq.${user.id}`,
        "GET"
      );
      const balances = await balanceCheckRes.json();

      // 4. CREATE balance if not exists
      if (balances.length === 0) {
        await supabase("user_balances", "POST", {
          user_id: user.id,
          balance: 0
        });
      }

      await sendMessage(
        chatId,
        "Welcome 👋\n\n" +
          "You are registered on the platform.\n" +
          "Use /balance to check your token balance."
      );

      return res.sendStatus(200);
    }

    /* ---------- /balance ---------- */
    if (text.startsWith("/balance")) {
      // 1. GET user
      const userRes = await supabase(
        `users?telegram_id=eq.${telegramId}`,
        "GET"
      );
      const users = await userRes.json();
      const user = users[0];

      if (!user) {
        await sendMessage(chatId, "User not found. Send /start first.");
        return res.sendStatus(200);
      }

      // 2. GET balance
      const balanceRes = await supabase(
        `user_balances?user_id=eq.${user.id}`,
        "GET"
      );
      const balances = await balanceRes.json();
      const balance = balances[0]?.balance ?? 0;

      await sendMessage(chatId, `Your balance: ${balance} tokens`);
      return res.sendStatus(200);
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err);
    return res.sendStatus(200);
  }
});

/* ================== HEALTH ================== */

app.get("/", (req, res) => {
  res.send("Backend is running");
});

/* ================== START ================== */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
