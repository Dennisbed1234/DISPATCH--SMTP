const { Pool } = require('pg');

let pool;
let trackingColsReady = false;

function hasDatabase() {
  return Boolean(process.env.DATABASE_URL && process.env.DATABASE_URL.trim());
}

function getPool() {
  if (!hasDatabase()) {
    throw new Error('DATABASE_URL is not set');
  }
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 5,
    });
  }
  return pool;
}

async function query(text, params) {
  const p = getPool();
  return p.query(text, params);
}

/** Ensure open/click/unsub/bounce tracking columns exist (safe to call repeatedly). */
async function ensureEmailTrackingColumns() {
  if (!hasDatabase() || trackingColsReady) return trackingColsReady;
  try {
    await query(`ALTER TABLE emails ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ`);
    await query(`ALTER TABLE emails ADD COLUMN IF NOT EXISTS opened_at TIMESTAMPTZ`);
    await query(`ALTER TABLE emails ADD COLUMN IF NOT EXISTS open_count INT DEFAULT 0`);
    await query(`ALTER TABLE emails ADD COLUMN IF NOT EXISTS clicked_at TIMESTAMPTZ`);
    await query(`ALTER TABLE emails ADD COLUMN IF NOT EXISTS click_count INT DEFAULT 0`);
    await query(`ALTER TABLE emails ADD COLUMN IF NOT EXISTS last_event TEXT`);
    await query(`ALTER TABLE emails ADD COLUMN IF NOT EXISTS campaign_id TEXT`);
    await query(`ALTER TABLE emails ADD COLUMN IF NOT EXISTS unsubscribed_at TIMESTAMPTZ`);
    await query(`ALTER TABLE emails ADD COLUMN IF NOT EXISTS bounced_at TIMESTAMPTZ`);
    await query(`ALTER TABLE emails ADD COLUMN IF NOT EXISTS bounce_type TEXT`);
    trackingColsReady = true;
  } catch (e) {
    console.error('ensureEmailTrackingColumns', e.message);
  }
  return trackingColsReady;
}

module.exports = { getPool, hasDatabase, query, ensureEmailTrackingColumns };
