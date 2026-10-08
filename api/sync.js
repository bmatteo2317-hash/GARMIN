/**
 * api/sync.js — Serverless function: Garmin Connect -> Neon PostgreSQL.
 *
 * Chiamala con:  POST /api/sync  oppure  GET /api/sync?limit=20
 * Vercel Cron la richiama ogni giorno alle 06:00 (vedi vercel.json).
 *
 * Credenziali Garmin (ordine di priorità):
 *   1. tabella `profiles` (riga id=1) impostata dalla sezione Profilo
 *   2. env vars GARMIN_EMAIL / GARMIN_PASSWORD (per Vercel Cron)
 *
 * Env richieste su Vercel:
 *   DATABASE_URL (+ GARMIN_EMAIL/GARMIN_PASSWORD come fallback,
 *   oppure PROFILE_PIN opzionale per proteggere login e Profilo)
 *
 * Nota serverless: il filesystem è effimero, quindi NON salviamo
 * token su disco come nel progetto Flask locale. Facciamo login
 * a ogni sync (1 volta/giorno = nessun rate-limit).
 */
const { GarminConnect } = require('@flow-js/garmin-connect');
const { neon } = require('@neondatabase/serverless');

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS activities (
  id SERIAL PRIMARY KEY,
  activity_id BIGINT UNIQUE NOT NULL,
  name TEXT,
  activity_type TEXT,
  start_time TIMESTAMPTZ,
  distance_m DOUBLE PRECISION DEFAULT 0,
  duration_s DOUBLE PRECISION DEFAULT 0,
  avg_pace_min_km DOUBLE PRECISION,
  avg_hr INT,
  max_hr INT,
  calories INT,
  elevation_gain_m DOUBLE PRECISION,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS daily_metrics (
  id SERIAL PRIMARY KEY,
  date DATE UNIQUE NOT NULL,
  steps INT,
  distance_m DOUBLE PRECISION,
  calories INT,
  resting_hr INT
);`;

function toPaceMinKm(a) {
  if (a.averagePace) return Number(a.averagePace);
  if (a.averageSpeed && Number(a.averageSpeed) > 0) {
    return 1000 / Number(a.averageSpeed) / 60;
  }
  return null;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Usa GET o POST' });
  }
  const { DATABASE_URL } = process.env;
  if (!DATABASE_URL) {
    return res.status(500).json({ error: 'Variabile mancante. Configura DATABASE_URL su Vercel.' });
  }

  const limit = Math.min(parseInt((req.query && req.query.limit) || '20', 10) || 20, 100);
  // Override manuale: POST { garmin_email, garmin_password } (usato dal pulsante sync
  // quando le credenziali sono salvate nel Profilo e non nelle env vars)
  // Body JSON (Vercel lo parsifica già; fallback se arriva come stringa)
  let body = req.body || {};
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  const bodyEmail = body.garmin_email || (req.query && req.query.garmin_email);
  const bodyPass = body.garmin_password || (req.query && req.query.garmin_password);
  const mfaCode = body.mfa_code || (req.query && req.query.mfa_code) || null;
  const sql = neon(DATABASE_URL);

  try {
    // 1. Assicura schema (idempotente, costo ~0 su Neon)
    // neon() non supporta multi-statement: esegui separatamente
    await sql`CREATE TABLE IF NOT EXISTS activities (
      id SERIAL PRIMARY KEY, activity_id BIGINT UNIQUE NOT NULL, name TEXT,
      activity_type TEXT, start_time TIMESTAMPTZ,
      distance_m DOUBLE PRECISION DEFAULT 0, duration_s DOUBLE PRECISION DEFAULT 0,
      avg_pace_min_km DOUBLE PRECISION, avg_hr INT, max_hr INT, calories INT,
      elevation_gain_m DOUBLE PRECISION, created_at TIMESTAMPTZ DEFAULT NOW()
    )`;
    await sql`CREATE TABLE IF NOT EXISTS daily_metrics (
      id SERIAL PRIMARY KEY, date DATE UNIQUE NOT NULL,
      steps INT, distance_m DOUBLE PRECISION, calories INT, resting_hr INT
    )`;
    // Tabella profili (anche token OAuth per saltare login+MFA alle sync successive)
    await sql`CREATE TABLE IF NOT EXISTS profiles (
      id INT PRIMARY KEY DEFAULT 1, garmin_email TEXT, garmin_password TEXT,
      oauth1_token TEXT, oauth2_token TEXT, updated_at TIMESTAMPTZ DEFAULT NOW()
    )`;
    await sql`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS oauth1_token TEXT`;
    await sql`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS oauth2_token TEXT`;

    // 2. Risolvi credenziali: body > tabella profiles > env vars
    let GARMIN_EMAIL = bodyEmail || null;
    let GARMIN_PASSWORD = bodyPass || null;
    let savedOauth1 = null;
    let savedOauth2 = null;
    if (!GARMIN_EMAIL || !GARMIN_PASSWORD) {
      try {
        const prof = await sql`SELECT garmin_email, garmin_password, oauth1_token, oauth2_token FROM profiles WHERE id = 1`;
        if (prof[0] && prof[0].garmin_email && prof[0].garmin_password) {
          GARMIN_EMAIL = prof[0].garmin_email;
          GARMIN_PASSWORD = prof[0].garmin_password;
          savedOauth1 = prof[0].oauth1_token || null;
          savedOauth2 = prof[0].oauth2_token || null;
        }
      } catch (e) { /* tabella assente alla prima sync: si usa il fallback env */ }
    }
    GARMIN_EMAIL = GARMIN_EMAIL || process.env.GARMIN_EMAIL;
    GARMIN_PASSWORD = GARMIN_PASSWORD || process.env.GARMIN_PASSWORD;
    if (!GARMIN_EMAIL || !GARMIN_PASSWORD) {
      return res.status(428).json({
        error: 'Credenziali Garmin non configurate.',
        hint: 'Apri la sezione Profilo nella dashboard e salva email + password Garmin.'
      });
    }

    // 3. Login Garmin (libreria @flow-js/garmin-connect)
    const GC = new GarminConnect({ username: GARMIN_EMAIL, password: GARMIN_PASSWORD });
    let activities = null;

    // 3a. Riuso token OAuth salvati (salta login e MFA se ancora validi)
    if (savedOauth1 && savedOauth2 && !mfaCode) {
      try {
        GC.loadToken(JSON.parse(savedOauth1), JSON.parse(savedOauth2));
        activities = (await GC.getActivities(0, limit)) || [];
      } catch (e) {
        activities = null; // token scaduti: si passa al login fresco
      }
    }

    // 3b. Login fresco; se Garmin chiede MFA serve mfa_code (dal body).
    // La libreria lo richiede via opzione mfaHandler: senza, lancia
    // "MFA required but no mfaHandler provided".
    if (!activities) {
      try {
        await GC.login(undefined, undefined,
          mfaCode ? { mfaHandler: async () => String(mfaCode).trim() } : undefined);
      } catch (e) {
        if (/mfa/i.test((e && e.message) || '')) {
          return res.status(428).json({
            mfa_required: true,
            error: 'Garmin richiede il codice MFA (inviato via email).',
            hint: 'Ripeti la sync passando il codice: POST /api/sync { "mfa_code": "123456" }.'
          });
        }
        throw e;
      }
      // Salva i token per le prossime sync (niente più MFA finché validi)
      try {
        const tokens = GC.exportToken();
        await sql`UPDATE profiles SET oauth1_token = ${JSON.stringify(tokens.oauth1)},
          oauth2_token = ${JSON.stringify(tokens.oauth2)}, updated_at = NOW() WHERE id = 1`;
      } catch (e) { /* salvataggio token non bloccante */ }
      activities = (await GC.getActivities(0, limit)) || [];
    }

    // 4. Upsert attività
    let saved = 0;
    for (const a of activities) {
      const pace = toPaceMinKm(a);
      const type =
        (a.activityType && (a.activityType.typeKey || a.activityType.typeId)) ||
        a.activityType ||
        null;
      await sql`
        INSERT INTO activities
          (activity_id, name, activity_type, start_time, distance_m, duration_s,
           avg_pace_min_km, avg_hr, max_hr, calories, elevation_gain_m)
        VALUES (
          ${a.activityId}, ${a.activityName || 'Attivita'},
          ${type ? String(type) : null},
          ${a.startTimeLocal ? new Date(a.startTimeLocal) : (a.startTimeGMT ? new Date(a.startTimeGMT) : null)},
          ${Number(a.distance) || 0}, ${Number(a.duration) || 0},
          ${pace}, ${a.averageHR || null}, ${a.maxHR || null},
          ${a.calories ? Math.round(Number(a.calories)) : null},
          ${a.elevationGain != null ? Number(a.elevationGain) : null}
        )
        ON CONFLICT (activity_id) DO NOTHING`;
      saved += 1;
    }

    return res.status(200).json({ ok: true, fetched: activities.length, upserted: saved });
  } catch (e) {
    console.error('SYNC ERROR:', e && e.message);
    const msg = (e && e.message) || 'sync failed';
    const status = /429|rate/i.test(msg) ? 429 : /mfa|MFA/i.test(msg) ? 428 : 500;
    return res.status(status).json({
      error: msg,
      hint:
        status === 429
          ? 'Rate-limit Garmin: riprova tra qualche ora, riduci la frequenza del Cron.'
          : status === 428
            ? 'Garmin chiede il codice MFA (email): ripeti la sync con { "mfa_code": "123456" } dal popup della dashboard.'
            : 'Controlla le env su Vercel e i log della function.'
    });
  }
};
