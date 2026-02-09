import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

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

app.post("/webhook", async (req, res) => {
  const message = req.body.message;
  if (!message) return res.sendStatus(200);

  const chatId = message.chat.id;
  const telegramId = String(message.from.id);
  const text = (message.text || "").trim();

  /* ---------- /start ---------- */
  if (text.startsWith("/start")) {
    // create or get user
    const userRes = await supabase(
      "users",
      "POST",
      { telegram_id: telegramId, role: "user" }
    );

    let user;
    if (userRes.ok) {
      const users = await userRes.json();
      user = users[0];
    } else {
      // already exists → fetch
      const res2 = await supabase(
        `users?telegram_id=eq.${telegramId}`,
        "GET"
      );
      const users = await res2.json();
      user = users[0];
    }

    // create balance if not exists
    await supabase("user_balances", "POST", {
      user_id: user.id,
      balance: 0
    });

    await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text:
          "Welcome 👋\n\n" +
          "You are registered.\n" +
          "Use /balance to check your token balance."
      })
    });

    return res.sendStatus(200);
  }

  /* ---------- /balance ---------- */
  if (text.startsWith("/balance")) {
    // get user
    const userRes = await supabase(
      `users?telegram_id=eq.${telegramId}`,
      "GET"
    );
    const users = await userRes.json();
    const user = users[0];

    if (!user) {
      await fetch(`${TELEGRAM_API}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: "User not found. Send /start first."
        })
      });
      return res.sendStatus(200);
    }

    // get balance
    const balanceRes = await supabase(
      `user_balances?user_id=eq.${user.id}`,
      "GET"
    );
    const balances = await balanceRes.json();
    const balance = balances[0]?.balance ?? 0;

    await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: `Your balance: ${balance} tokens`
      })
    });

    return res.sendStatus(200);
  }

  res.sendStatus(200);
});

app.get("/", (req, res) => {
  res.send("Backend is running");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
