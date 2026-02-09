import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

async function supabaseRequest(path, method = "GET", body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      "apikey": SUPABASE_KEY,
      "Authorization": `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": "return=minimal"
    },
    body: body ? JSON.stringify(body) : undefined
  });

  return res;
}

app.post("/webhook", async (req, res) => {
  const message = req.body.message;
  if (!message) return res.sendStatus(200);

  const chatId = message.chat.id;
  const telegramId = String(message.from.id);
  const text = message.text || "";

  // create user if not exists
// create user
const userRes = await supabaseRequest(
  "users",
  "POST",
  {
    telegram_id: telegramId,
    role: "user"
  }
);

// create balance (ignore if already exists)
await supabaseRequest(
  "user_balances",
  "POST",
  {
    user_id: null,
    balance: 0
  }
);

  if (text === "/start") {
    await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text:
          "Welcome 👋\n\n" +
          "You are now registered on the platform.\n" +
          "This service allows collective acquisition of unique items."
      })
    });
  }
if (text === "/balance") {
  // get user
  const userRes = await fetch(
    `${SUPABASE_URL}/rest/v1/users?telegram_id=eq.${telegramId}`,
    {
      headers: {
        "apikey": SUPABASE_KEY,
        "Authorization": `Bearer ${SUPABASE_KEY}`
      }
    }
  );

  const users = await userRes.json();
  const user = users[0];

  if (!user) {
    await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: "User not found. Please send /start first."
      })
    });
    return res.sendStatus(200);
  }

  // get balance
  const balanceRes = await fetch(
    `${SUPABASE_URL}/rest/v1/user_balances?user_id=is.null&limit=1`,
    {
      headers: {
        "apikey": SUPABASE_KEY,
        "Authorization": `Bearer ${SUPABASE_KEY}`
      }
    }
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
