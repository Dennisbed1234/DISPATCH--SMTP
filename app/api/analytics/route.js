const { query, hasDatabase, ensureEmailTrackingColumns } = require('../../../lib/db');

export const dynamic = 'force-dynamic';

function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? Math.trunc(x) : 0;
}

export async function GET(request) {
  if (!hasDatabase()) {
    return Response.json({
      success: false,
      error: 'DATABASE_URL not set',
      totals: null,
      byDay: [],
      topDomains: [],
      campaigns: [],
    });
  }

  try {
    await ensureEmailTrackingColumns();

    const url = new URL(request.url);
    const days = Math.min(Math.max(Number(url.searchParams.get('days') || 7), 1), 90);
    const campaignId = (url.searchParams.get('campaignId') || url.searchParams.get('campaign') || '').trim();
    const campSql = campaignId ? `AND campaign_id = $camp` : '';

    let totals = {
      total: 0,
      smtpAccepted: 0,
      sent: 0,
      failed: 0,
      bounced: 0,
      opened: 0,
      clicked: 0,
      unsubscribed: 0,
      today: 0,
      last7: 0,
      uniqueContacts: 0,
      openRate: 0,
      clickRate: 0,
      failRate: 0,
      unsubRate: 0,
    };

    try {
      const params = campaignId ? [campaignId] : [];
      const campClause = campaignId ? `AND campaign_id = $1` : '';
      const { rows } = await query(
        `
        SELECT
          COUNT(*)::int AS total,
          COALESCE(SUM(CASE
            WHEN status IS NULL OR lower(trim(status)) IN ('sent','delivered','opened','pending')
            THEN 1 ELSE 0 END), 0)::int AS sent,
          COALESCE(SUM(CASE WHEN lower(trim(COALESCE(status,''))) = 'failed' THEN 1 ELSE 0 END), 0)::int AS failed,
          COALESCE(SUM(CASE WHEN lower(trim(COALESCE(status,''))) = 'bounced' OR lower(COALESCE(bounce_type,'')) = 'hard' THEN 1 ELSE 0 END), 0)::int AS bounced,
          COALESCE(SUM(CASE
            WHEN lower(trim(COALESCE(status,''))) = 'opened' OR opened_at IS NOT NULL OR COALESCE(open_count,0) > 0
            THEN 1 ELSE 0 END), 0)::int AS opened,
          COALESCE(SUM(CASE
            WHEN lower(COALESCE(last_event,'')) = 'clicked' OR COALESCE(click_count, 0) > 0
            THEN 1 ELSE 0 END), 0)::int AS clicked,
          COALESCE(SUM(CASE WHEN lower(trim(COALESCE(status,''))) = 'unsubscribed' OR unsubscribed_at IS NOT NULL THEN 1 ELSE 0 END), 0)::int AS unsubscribed,
          COALESCE(SUM(CASE
            WHEN created_at >= NOW() - INTERVAL '24 hours'
              AND (status IS NULL OR lower(trim(status)) IN ('sent','delivered','opened','pending'))
            THEN 1 ELSE 0 END), 0)::int AS today,
          COALESCE(SUM(CASE
            WHEN created_at >= NOW() - INTERVAL '7 days'
              AND (status IS NULL OR lower(trim(status)) IN ('sent','delivered','opened','pending'))
            THEN 1 ELSE 0 END), 0)::int AS last7
        FROM emails
        WHERE 1=1 ${campClause}
      `,
        params
      );
      const r = rows[0] || {};
      totals = {
        total: n(r.total),
        smtpAccepted: n(r.sent),
        sent: n(r.sent),
        failed: n(r.failed),
        bounced: n(r.bounced),
        opened: n(r.opened),
        clicked: n(r.clicked),
        unsubscribed: n(r.unsubscribed),
        today: n(r.today),
        last7: n(r.last7),
        uniqueContacts: 0,
        openRate: 0,
        clickRate: 0,
        failRate: 0,
        unsubRate: 0,
      };
      totals.openRate =
        totals.smtpAccepted > 0
          ? Math.round((totals.opened / totals.smtpAccepted) * 1000) / 10
          : 0;
      totals.clickRate =
        totals.opened > 0
          ? Math.round((totals.clicked / totals.opened) * 1000) / 10
          : 0;
      totals.failRate =
        totals.total > 0
          ? Math.round(((totals.failed + totals.bounced) / totals.total) * 1000) / 10
          : 0;
      totals.unsubRate =
        totals.smtpAccepted > 0
          ? Math.round((totals.unsubscribed / totals.smtpAccepted) * 1000) / 10
          : 0;
    } catch (e) {
      console.warn('analytics overview', e.message);
    }

    try {
      const params = campaignId ? [campaignId] : [];
      const campClause = campaignId ? `AND campaign_id = $1` : '';
      const { rows } = await query(
        `
        SELECT COUNT(DISTINCT lower(trim(recipient)))::int AS c
        FROM emails
        WHERE recipient IS NOT NULL AND trim(recipient) <> ''
          AND (status IS NULL OR lower(trim(status)) IN ('sent','delivered','opened','pending'))
          ${campClause}
      `,
        params
      );
      totals.uniqueContacts = n(rows[0]?.c);
    } catch {
      /* ignore */
    }

    const byDayMap = new Map();
    const now = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      byDayMap.set(key, {
        date: key,
        sent: 0,
        opened: 0,
        clicked: 0,
        failed: 0,
        bounced: 0,
        unsubscribed: 0,
      });
    }

    try {
      const params = campaignId ? [String(days), campaignId] : [String(days)];
      const campClause = campaignId ? `AND campaign_id = $2` : '';
      const { rows } = await query(
        `
        SELECT
          to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
          COALESCE(SUM(CASE
            WHEN status IS NULL OR lower(trim(status)) IN ('sent','delivered','opened','pending')
            THEN 1 ELSE 0 END), 0)::int AS sent,
          COALESCE(SUM(CASE
            WHEN lower(trim(COALESCE(status,''))) = 'opened' OR opened_at IS NOT NULL
            THEN 1 ELSE 0 END), 0)::int AS opened,
          COALESCE(SUM(CASE
            WHEN lower(COALESCE(last_event,'')) = 'clicked' OR COALESCE(click_count, 0) > 0
            THEN 1 ELSE 0 END), 0)::int AS clicked,
          COALESCE(SUM(CASE WHEN lower(trim(COALESCE(status,''))) = 'failed' THEN 1 ELSE 0 END), 0)::int AS failed,
          COALESCE(SUM(CASE WHEN lower(trim(COALESCE(status,''))) = 'bounced' THEN 1 ELSE 0 END), 0)::int AS bounced,
          COALESCE(SUM(CASE WHEN lower(trim(COALESCE(status,''))) = 'unsubscribed' OR unsubscribed_at IS NOT NULL THEN 1 ELSE 0 END), 0)::int AS unsubscribed
        FROM emails
        WHERE created_at >= NOW() - ($1 || ' days')::interval
        ${campClause}
        GROUP BY 1
        ORDER BY 1 ASC
      `,
        params
      );
      for (const r of rows) {
        const key = String(r.day).slice(0, 10);
        if (byDayMap.has(key)) {
          byDayMap.set(key, {
            date: key,
            sent: n(r.sent),
            opened: n(r.opened),
            clicked: n(r.clicked),
            failed: n(r.failed),
            bounced: n(r.bounced),
            unsubscribed: n(r.unsubscribed),
          });
        }
      }
    } catch (e) {
      console.warn('analytics daily', e.message);
    }

    let topDomains = [];
    try {
      const { rows } = await query(
        `
        SELECT
          lower(split_part(trim(recipient), '@', 2)) AS domain,
          COUNT(*)::int AS c
        FROM emails
        WHERE created_at >= NOW() - ($1 || ' days')::interval
          AND recipient IS NOT NULL
          AND position('@' in recipient) > 0
        GROUP BY 1
        HAVING lower(split_part(trim(recipient), '@', 2)) <> ''
        ORDER BY c DESC
        LIMIT 12
      `,
        [String(days)]
      );
      topDomains = rows.map((r) => ({
        name: String(r.domain || 'unknown'),
        count: n(r.c),
      }));
    } catch (e) {
      console.warn('analytics domains', e.message);
    }

    let campaigns = [];
    try {
      const { rows } = await query(`
        SELECT campaign_id AS id, COUNT(*)::int AS count
        FROM emails
        WHERE campaign_id IS NOT NULL AND trim(campaign_id) <> ''
        GROUP BY campaign_id
        ORDER BY MAX(created_at) DESC
        LIMIT 30
      `);
      campaigns = rows.map((r) => ({ id: r.id, count: n(r.count) }));
    } catch {
      campaigns = [];
    }

    return Response.json({
      success: true,
      days,
      campaignId: campaignId || null,
      totals,
      byDay: Array.from(byDayMap.values()),
      topDomains,
      campaigns,
    });
  } catch (error) {
    console.error('Analytics error:', error);
    return Response.json(
      {
        success: false,
        error: error.message || 'Failed',
        totals: null,
        byDay: [],
        topDomains: [],
        campaigns: [],
      },
      { status: 500 }
    );
  }
}
