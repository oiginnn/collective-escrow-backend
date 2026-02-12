import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// --- CORS для Mini App / Vercel ---
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

async function sb(path) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
    },
  });
}

// health
app.get("/", (_, res) => res.send("Backend OK"));

// lots feed
app.get("/api/lots", async (req, res) => {
  try {
    const lotsRes = await sb(
      "lots?status=eq.active&select=id,title,description,media,price_per_participation,goal_amount,ends_at,currency,created_at&order=created_at.desc&limit=50"
    );

    if (!lotsRes.ok) {
      const t = await lotsRes.text();
      return res.status(500).json({ error: "supabase lots fetch failed", detail: t });
    }

    const lots = await lotsRes.json();

    const enriched = [];
    for (const lot of lots) {
      const partsRes = await sb(
        `lot_participants?lot_id=eq.${lot.id}&status=eq.reserved&select=amount`
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
    return res.status(500).json({ error: "server error" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on ${PORT}`));
