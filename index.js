import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

app.post("/webhook", async (req, res) => {
  const message = req.body.message;

  if (!message) {
    return res.sendStatus(200);
  }

  const chatId = message.chat.id;
  const text = message.text || "";

  if (text === "/start") {
    await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text:
          "Welcome.\n\n" +
          "This platform allows collective acquisition of unique items.\n" +
          "Please read the rules before participating."
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
