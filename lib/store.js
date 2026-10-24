const crypto = require('crypto');
const { query, hasDatabase, ensureEmailTrackingColumns } = require('./db');

function n(v) {
  const x = parseInt(String(v ?? 0), 10);
  return Number.isNaN(x) ? 0 : x;
}

async function logEmail(opts) {
  if (!hasDatabase()) return null;
  await ensureEmailTrackingColumns();
  const id = opts.id || crypto.randomUUID();
  let status = opts.status === 'sent' ? 'delivered' : opts.status;
  const delivered =
    status === 'delivered' || status === 'opened' || status === 'sent';
  const bounced = status === 'bounced';
  try {
    await query(
      `INSERT INTO emails (
        id, sender, recipient, subject, text_body, html_body,
        message_type, status, error_message, message_id, campaign_id,
        delivered_at, open_count, click_count, last_event,
        bounced_at, bounce_type
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,0,0,$13,$14,$15)`,
      [
        id,
        opts.sender || '',
        opts.recipient,
        opts.subject || '',
        opts.text || null,
        opts.html || null,
        opts.messageType || 'email',
        status,
        opts.error || null,
        opts.messageId || null,
        opts.campaignId || null,
        delivered ? new Date().toISOString() : null,
        status === 'bounced' ? 'bounced' : status,
        bounced ? new Date().toISOString() : null,
        opts.bounceType || null,
      ]
    );
  } catch (e) {
    console.error('logEmail', e.message);
    try {
      await query(
        `INSERT INTO emails (id, sender, recipient, subject, text_body, html_body, message_type, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          id,
          opts.sender || '',
          opts.recipient,
          opts.subject || '',
          opts.text || null,
          opts.html || null,
          opts.messageType || 'email',
          status,
        ]
      );
    } catch (e2) {
      console.error('logEmail fallback', e2.message);
      return null;
    }
  }
  if (delivered) {
    try {
      await upsertCustomer(opts.recipient, {
        note: opts.subject ? `Last: ${String(opts.subject).slice(0, 80)}` : '',
      });
    } catch {
      /* ignore */
    }
  }
  return id;
}

async function recordOpen(emailId) {
  if (!hasDatabase() || !emailId) return false;
  await ensureEmailTrackingColumns();
  try {
    await query(
      `UPDATE emails SET
        open_count = COALESCE(open_count, 0) + 1,
        opened_at = COALESCE(opened_at, NOW()),
        status = CASE WHEN lower(status) IN ('failed','bounced','unsubscribed') THEN status ELSE 'opened' END,
        last_event = 'opened'
       WHERE id = $1`,
      [emailId]
    );
    return true;
  } catch {
    return false;
  }
}

async function recordClick(emailId) {
  if (!hasDatabase() || !emailId) return false;
  await ensureEmailTrackingColumns();
  try {
    await query(
      `UPDATE emails SET
        open_count = COALESCE(open_count, 0) + 1,
        opened_at = COALESCE(opened_at, NOW()),
        click_count = COALESCE(click_count, 0) + 1,
        clicked_at = COALESCE(clicked_at, NOW()),
        status = CASE WHEN lower(status) IN ('failed','bounced','unsubscribed') THEN status ELSE 'opened' END,
        last_event = 'clicked'
       WHERE id = $1`,
      [emailId]
    );
    return true;
  } catch (e) {
    console.error('recordClick', e.message);
    try {
      await recordOpen(emailId);
    } catch {
      /* ignore */
    }
    return false;
  }
}

async function recordUnsubscribe(emailId) {
  if (!hasDatabase() || !emailId) return false;
  await ensureEmailTrackingColumns();
  try {
    await query(
      `UPDATE emails SET
        status = 'unsubscribed',
        unsubscribed_at = COALESCE(unsubscribed_at, NOW()),
        last_event = 'unsubscribed'
       WHERE id = $1`,
      [emailId]
    );
    return true;
  } catch {
    return false;
  }
}

async function getStats() {
  const empty = {
    total: 0,
    sent: 0,
    failed: 0,
    opened: 0,
    clicked: 0,
    today: 0,
    todaySent: 0,
  };
  if (!hasDatabase()) return empty;
  await ensureEmailTrackingColumns();
  try {
    const { rows } = await query(`
      SELECT
        COUNT(*)::int AS total,
        COALESCE(SUM(CASE WHEN status IS NULL OR lower(trim(status)) IN ('sent','delivered','opened','pending') THEN 1 ELSE 0 END),0)::int AS sent,
        COALESCE(SUM(CASE WHEN lower(trim(COALESCE(status,''))) = 'failed' THEN 1 ELSE 0 END),0)::int AS failed,
        COALESCE(SUM(CASE WHEN lower(trim(COALESCE(status,''))) = 'opened' OR opened_at IS NOT NULL THEN 1 ELSE 0 END),0)::int AS opened,
        COALESCE(SUM(CASE WHEN lower(COALESCE(last_event,'')) = 'clicked' OR COALESCE(click_count, 0) > 0 THEN 1 ELSE 0 END),0)::int AS clicked,
        COALESCE(SUM(CASE WHEN created_at >= date_trunc('day', NOW()) THEN 1 ELSE 0 END),0)::int AS today
      FROM emails
    `);
    const r = rows[0] || {};
    return {
      total: n(r.total),
      sent: n(r.sent),
      failed: n(r.failed),
      opened: n(r.opened),
      clicked: n(r.clicked),
      today: n(r.today),
      todaySent: n(r.today),
    };
  } catch (e) {
    console.error('getStats', e.message);
    return empty;
  }
}

async function listEmails({ limit = 200, q, status } = {}) {
  if (!hasDatabase()) return [];
  await ensureEmailTrackingColumns();
  try {
    const lim = Math.min(Math.max(Number(limit) || 200, 1), 2000);
    if (status === 'clicked') {
      const { rows } = await query(
        q
          ? `SELECT * FROM emails WHERE (lower(COALESCE(last_event,'')) = 'clicked' OR COALESCE(click_count, 0) > 0) AND (recipient ILIKE $1 OR subject ILIKE $1) ORDER BY created_at DESC LIMIT $2`
          : `SELECT * FROM emails WHERE lower(COALESCE(last_event,'')) = 'clicked' OR COALESCE(click_count, 0) > 0 ORDER BY created_at DESC LIMIT $1`,
        q ? [`%${q}%`, lim] : [lim]
      );
      return rows;
    }
    if (status === 'opened') {
      const { rows } = await query(
        q
          ? `SELECT * FROM emails WHERE (lower(status) = 'opened' OR opened_at IS NOT NULL) AND (recipient ILIKE $1 OR subject ILIKE $1) ORDER BY created_at DESC LIMIT $2`
          : `SELECT * FROM emails WHERE lower(status) = 'opened' OR opened_at IS NOT NULL ORDER BY created_at DESC LIMIT $1`,
        q ? [`%${q}%`, lim] : [lim]
      );
      return rows;
    }
    if (status === 'failed') {
      const { rows } = await query(
        q
          ? `SELECT * FROM emails WHERE lower(status) IN ('failed','bounced') AND (recipient ILIKE $1 OR subject ILIKE $1) ORDER BY created_at DESC LIMIT $2`
          : `SELECT * FROM emails WHERE lower(status) IN ('failed','bounced') ORDER BY created_at DESC LIMIT $1`,
        q ? [`%${q}%`, lim] : [lim]
      );
      return rows;
    }
    if (status === 'delivered' || status === 'sent') {
      const { rows } = await query(
        q
          ? `SELECT * FROM emails WHERE lower(status) IN ('sent','delivered','opened') AND (recipient ILIKE $1 OR subject ILIKE $1) ORDER BY created_at DESC LIMIT $2`
          : `SELECT * FROM emails WHERE lower(status) IN ('sent','delivered','opened') ORDER BY created_at DESC LIMIT $1`,
        q ? [`%${q}%`, lim] : [lim]
      );
      return rows;
    }
    if (q) {
      const { rows } = await query(
        `SELECT * FROM emails WHERE recipient ILIKE $1 OR subject ILIKE $1 ORDER BY created_at DESC LIMIT $2`,
        [`%${q}%`, lim]
      );
      return rows;
    }
    const { rows } = await query(
      `SELECT * FROM emails ORDER BY created_at DESC LIMIT $1`,
      [lim]
    );
    return rows;
  } catch (e) {
    console.error('listEmails', e.message);
    return [];
  }
}

async function ensureCustomers() {
  await query(`
    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      last_emailed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      send_count INT NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function upsertCustomer(email, opts = {}) {
  if (!hasDatabase()) return null;
  const em = String(email || '').trim().toLowerCase();
  if (!em.includes('@')) return null;
  await ensureCustomers();
  const existing = await query(
    `SELECT id, send_count FROM customers WHERE lower(email) = $1 LIMIT 1`,
    [em]
  );
  if (existing.rows.length) {
    const next = n(existing.rows[0].send_count) + 1;
    await query(
      `UPDATE customers SET last_emailed_at = NOW(), send_count = $1,
        note = COALESCE(NULLIF($2,''), note),
        name = COALESCE(NULLIF($3,''), name)
       WHERE id = $4`,
      [next, opts.note || '', opts.name || '', existing.rows[0].id]
    );
    return existing.rows[0].id;
  }
  const id = crypto.randomUUID();
  await query(
    `INSERT INTO customers (id, email, name, note, last_emailed_at, send_count)
     VALUES ($1,$2,$3,$4,NOW(),1)`,
    [id, em, opts.name || '', opts.note || '']
  );
  return id;
}

async function listCustomers(q) {
  if (!hasDatabase()) return [];
  try {
    await ensureCustomers();
    if (q) {
      const { rows } = await query(
        `SELECT * FROM customers
         WHERE email ILIKE $1 OR name ILIKE $1 OR note ILIKE $1
         ORDER BY last_emailed_at DESC LIMIT 5000`,
        [`%${q}%`]
      );
      return rows;
    }
    const { rows } = await query(
      `SELECT * FROM customers ORDER BY last_emailed_at DESC LIMIT 5000`
    );
    return rows;
  } catch {
    return [];
  }
}

async function listContacts({ q, limit = 5000 } = {}) {
  if (!hasDatabase()) return { contacts: [], totalUnique: 0, totalSentLogs: 0 };
  try {
    const lim = Math.min(Math.max(limit, 1), 10000);
    let rows;
    if (q) {
      const r = await query(
        `SELECT lower(trim(recipient)) AS email,
          COUNT(*)::int AS send_count,
          MAX(created_at) AS last_sent_at,
          MAX(subject) AS last_subject
         FROM emails
         WHERE (status IS NULL OR lower(trim(status)) IN ('sent','delivered','opened','pending'))
           AND (lower(recipient) LIKE $1 OR lower(COALESCE(subject,'')) LIKE $1)
         GROUP BY lower(trim(recipient))
         ORDER BY last_sent_at DESC
         LIMIT $2`,
        [`%${q.toLowerCase()}%`, lim]
      );
      rows = r.rows;
    } else {
      const r = await query(
        `SELECT lower(trim(recipient)) AS email,
          COUNT(*)::int AS send_count,
          MAX(created_at) AS last_sent_at,
          MAX(subject) AS last_subject
         FROM emails
         WHERE (status IS NULL OR lower(trim(status)) IN ('sent','delivered','opened','pending'))
           AND recipient IS NOT NULL AND trim(recipient) <> ''
         GROUP BY lower(trim(recipient))
         ORDER BY last_sent_at DESC
         LIMIT $1`,
        [lim]
      );
      rows = r.rows;
    }
    const contacts = rows
      .filter((r) => r.email && String(r.email).includes('@'))
      .map((r) => ({
        email: String(r.email).toLowerCase(),
        name: null,
        sendCount: n(r.send_count),
        lastSentAt: r.last_sent_at
          ? new Date(r.last_sent_at).toISOString()
          : '',
        lastSubject: r.last_subject || '',
      }));
    const tot = await query(
      `SELECT COUNT(*)::int AS c FROM emails
       WHERE status IS NULL OR lower(trim(status)) IN ('sent','delivered','opened','pending')`
    );
    return {
      contacts,
      totalUnique: contacts.length,
      totalSentLogs: n(tot.rows[0]?.c),
    };
  } catch (e) {
    console.error('listContacts', e.message);
    return { contacts: [], totalUnique: 0, totalSentLogs: 0, error: e.message };
  }
}

module.exports = {
  logEmail,
  recordOpen,
  recordClick,
  recordUnsubscribe,
  getStats,
  listEmails,
  upsertCustomer,
  listCustomers,
  listContacts,
};
