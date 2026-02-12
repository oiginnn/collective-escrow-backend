import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

// --- helper: call Supabase REST ---
async function sb(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json"
    }
  });
  return r;
}

/**
 * GET /api/lots
 * Returns active lots with computed progress (collected + percent)
 * For MVP: public read.
 */
app.get("/api/lots", async (req, res) => {
  try {
    // 1) fetch active lots
    const lotsRes = await sb(
      "lots?status=eq.active&select=id,title,description,media,price_per_participation,goal_amount,ends_at,currency,created_at&order=created_at.desc&limit=50"
    );

    if (!lotsRes.ok) {
      const t = await lotsRes.text();
      return res.status(500).json({ error: "supabase lots fetch failed", detail: t });
    }

    const lots = await lotsRes.json();
    if (lots.length === 0) return res.json({ lots: [] });

    // 2) compute collected per lot (reserved only) by extra requests (MVP-simple)
    // NOTE: later optimize with SQL RPC or view
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

      enriched.push({
        ...lot,
        collected,
        progress // 0..1
      });
    }

    return res.json({ lots: enriched });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "server error" });
  }
});

// health
app.get("/", (_, res) => res.send("Backend OK"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on ${PORT}`));
