/**
 * api/profile.js — Profilo + login gate.
 *
 * GET  /api/profile?action=status → { pin_required, garmin_configured, email_masked }
 * POST /api/profile { action:'login', pin } → { ok:true } se PIN corretto
 * POST /api/profile { action:'save', pin, garmin_email, garmin_password }
 *   → salva credenziali Garmin nella tabella `profiles` (riga id=1)
 *
 * Env opzionale:
 *   PROFILE_PIN — se impostata, login e salvataggio richiedono il PIN.
 *   Se assente, nessun gate (uso personale / rete privata).
 */
const { neon } = require('@neondatabase/serverless');

async function ensureSchema(sql) {
  await sql`CREATE TABLE IF NOT EXISTS profiles (
    id INT PRIMARY KEY DEFAULT 1, garmin_email TEXT, garmin_password TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`;
}

function pinOk(req) {
  const required = process.env.PROFILE_PIN;
  if (!required) return true; // nessun PIN configurato → accesso libero
  const pin = (req.body && req.body.pin) || (req.query && req.query.pin) || '';
  return pin === required;
}

function maskEmail(email) {
  if (!email || email.indexOf('@') < 0) return email || null;
  const [user, domain] = email.split('@');
  return (user[0] || '') + '***@' + domain;
}

module.exports = async function handler(req, res) {
  if (!process.env.DATABASE_URL) {
    return res.status(500).json({ error: 'DATABASE_URL mancante su Vercel.' });
  }
  const sql = neon(process.env.DATABASE_URL);
  const action = (req.query && req.query.action) || (req.body && req.body.action) || 'status';

  try {
    await ensureSchema(sql);

    // --- Stato: serve al frontend per mostrare login gate e sezione Profilo ---
    if (req.method === 'GET' && action === 'status') {
      const rows = await sql`SELECT garmin_email FROM profiles WHERE id = 1`;
      return res.status(200).json({
        pin_required: Boolean(process.env.PROFILE_PIN),
        garmin_configured: Boolean(rows[0] && rows[0].garmin_email),
        email_masked: rows[0] ? maskEmail(rows[0].garmin_email) : null,
      });
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Usa GET (status) o POST (login/save).' });
    }

    // --- Login: verifica PIN ---
    if (action === 'login') {
      if (!pinOk(req)) return res.status(401).json({ error: 'PIN errato.' });
      return res.status(200).json({ ok: true });
    }

    // --- Save: memorizza credenziali Garmin ---
    if (action === 'save') {
      if (!pinOk(req)) return res.status(401).json({ error: 'PIN errato.' });
      const email = (req.body && req.body.garmin_email || '').trim();
      const password = (req.body && req.body.garmin_password || '').trim();
      if (!email || !password) {
        return res.status(400).json({ error: 'Inserisci sia email che password Garmin.' });
      }
      await sql`
        INSERT INTO profiles (id, garmin_email, garmin_password, updated_at)
        VALUES (1, ${email}, ${password}, NOW())
        ON CONFLICT (id) DO UPDATE
        SET garmin_email = EXCLUDED.garmin_email,
            garmin_password = EXCLUDED.garmin_password,
            updated_at = NOW()`;
      return res.status(200).json({ ok: true, email_masked: maskEmail(email) });
    }

    return res.status(400).json({ error: 'action non valida (status/login/save).' });
  } catch (e) {
    console.error('PROFILE ERROR:', e && e.message);
    return res.status(500).json({ error: (e && e.message) || 'profile error' });
  }
};
