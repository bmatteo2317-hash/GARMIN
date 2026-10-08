/**
 * api/activities.js — Serverless function di LETTURA (veloce, mai Garmin).
 * Il frontend chiama GET /api/activities?limit=20 e riceve JSON dal Neon DB.
 */
const { neon } = require('@neondatabase/serverless');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Usa GET' });
  }
  if (!process.env.DATABASE_URL) {
    return res.status(500).json({ error: 'DATABASE_URL mancante su Vercel.' });
  }
  const limit = Math.min(parseInt((req.query && req.query.limit) || '20', 10) || 20, 100);
  try {
    const sql = neon(process.env.DATABASE_URL);
    const rows = await sql`
      SELECT activity_id, name, activity_type, start_time,
             distance_m, duration_s, avg_pace_min_km, avg_hr, max_hr,
             calories, elevation_gain_m
      FROM activities
      ORDER BY start_time DESC NULLS LAST
      LIMIT ${limit}`;

    // Aggregato chilometraggio settimanale calcolato in JS (semplice, 20 righe)
    const weekly = {};
    for (const r of rows) {
      if (!r.start_time) continue;
      const d = new Date(r.start_time);
      // chiave ISO week semplificata: anno-mese-settimana
      const key = d.toISOString().slice(0, 10);
      weekly[key] = (weekly[key] || 0) + (Number(r.distance_m) || 0) / 1000;
    }

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    return res.status(200).json({ activities: rows, weekly_km: weekly });
  } catch (e) {
    console.error('ACTIVITIES ERROR:', e && e.message);
    return res.status(500).json({ error: (e && e.message) || 'db error' });
  }
};
