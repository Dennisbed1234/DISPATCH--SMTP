const crypto = require('crypto');
const {
  sendEmail,
  isMailConfigured,
  getMailConfig,
  sendDelayMs,
  delay,
} = require('../../../lib/mailer');
const { logEmail } = require('../../../lib/store');
const { hasDatabase, query, ensureEmailTrackingColumns } = require('../../../lib/db');

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function parseRecipients(to) {
  let list = [];
  if (Array.isArray(to)) list = to.map(String);
  else list = String(to || '').split(/[,;\n]+/);
  const out = [];
  const seen = new Set();
  for (const part of list) {
    const p = part.trim();
    if (!p) continue;
    const angle = p.match(/^(.*?)\s*<\s*([^>]+)\s*>$/);
    let email = p;
    let name;
    if (angle) {
      name = angle[1].replace(/^["']|["']$/g, '').trim() || undefined;
      email = angle[2].trim();
    }
    email = email.toLowerCase();
    if (!email.includes('@') || seen.has(email)) continue;
    seen.add(email);
    out.push({ email, name: name || email.split('@')[0] });
  }
  return out;
}

function appBase() {
  const raw = (
    process.env.APP_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.VERCEL_PROJECT_PRODUCTION_URL ||
    process.env.VERCEL_URL ||
    ''
  ).trim();
  if (!raw) return '';
  let u = raw.replace(/\/$/, '');
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  return u;
}

function classifyFailure(message) {
  const m = String(message || '');
  if (
    /550|551|552|553|user unknown|mailbox unavailable|does not exist|no such user|invalid recipient|recipient rejected|address rejected/i.test(
      m
    )
  ) {
    return { bounceType: 'hard', status: 'bounced' };
  }
  if (
    /421|450|451|452|try again|temporarily|greylist|rate limit|too many|deferred/i.test(
      m
    )
  ) {
    return { bounceType: 'soft', status: 'failed' };
  }
  return { bounceType: null, status: 'failed' };
}

async function isSuppressed(email) {
  if (!hasDatabase()) return false;
  try {
    await ensureEmailTrackingColumns();
    const { rows } = await query(
      `SELECT 1 FROM emails
       WHERE lower(trim(recipient)) = $1
         AND (
           unsubscribed_at IS NOT NULL
           OR lower(status) = 'unsubscribed'
           OR lower(status) = 'bounced'
           OR lower(COALESCE(bounce_type,'')) = 'hard'
         )
       LIMIT 1`,
      [email.toLowerCase()]
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

/** Open pixel + click rewrite + unsubscribe footer */
function injectTracking(html, emailId) {
  if (!html || !emailId) return html;
  const base = appBase();
  if (!base) return html;

  let out = String(html);

  out = out.replace(
    /href\s*=\s*["'](https?:\/\/[^"']+)["']/gi,
    (match, url) => {
      if (/\/api\/track\//i.test(url)) return match;
      const tracked = `${base}/api/track/click?id=${encodeURIComponent(
        emailId
      )}&u=${encodeURIComponent(url)}`;
      return `href="${tracked}"`;
    }
  );

  if (!out.includes('/api/track/unsubscribe')) {
    const href = `${base}/api/track/unsubscribe?id=${encodeURIComponent(emailId)}`;
    const block = `<p style="margin:24px 0 0;font-size:11px;line-height:1.5;color:#6b7280;text-align:center;">If you no longer want these emails, <a href="${href}" style="color:#6b7280;text-decoration:underline;">unsubscribe</a>.</p>`;
    if (/<\/body>/i.test(out)) out = out.replace(/<\/body>/i, `${block}</body>`);
    else out = `${out}${block}`;
  }

  const pixel = `<img src="${base}/api/track/open?id=${encodeURIComponent(
    emailId
  )}&t=${Date.now()}" width="1" height="1" alt="" border="0" style="width:1px;height:1px;border:0;opacity:0;" />`;
  if (/<\/body>/i.test(out)) {
    out = out.replace(/<\/body>/i, `${pixel}</body>`);
  } else {
    out = `${out}${pixel}`;
  }
  return out;
}

export async function POST(request) {
  try {
    if (!isMailConfigured()) {
      return Response.json(
        {
          error:
            'Gmail SMTP not configured. Set SMTP_USER and SMTP_PASS (Google App Password).',
        },
        { status: 500 }
      );
    }
    const body = await request.json();
    let recipients = parseRecipients(body.to).slice(0, 500);
    const subject = String(body.subject || '').trim();
    let html = body.html ? String(body.html) : undefined;
    const text =
      body.text || body.message
        ? String(body.text || body.message)
        : undefined;
    const dryRun = Boolean(body.dryRun);
    const campaignId =
      String(body.campaignId || body.campaign || '').trim() ||
      `camp_${Date.now().toString(36)}`;

    if (!recipients.length || !subject || (!html && !text)) {
      return Response.json(
        { error: 'to, subject, and html or text required' },
        { status: 400 }
      );
    }

    let skippedSuppressed = 0;
    const kept = [];
    for (const r of recipients) {
      if (await isSuppressed(r.email)) {
        skippedSuppressed += 1;
        continue;
      }
      kept.push(r);
    }
    recipients = kept;

    if (dryRun) {
      return Response.json({
        success: true,
        dryRun: true,
        campaignId,
        wouldSend: recipients.length,
        skippedSuppressed,
        recipients: recipients.map((r) => ({
          email: r.email,
          subject,
        })),
      });
    }

    const cfg = getMailConfig();
    const base = appBase();
    const results = [];
    for (let i = 0; i < recipients.length; i++) {
      const r = recipients[i];
      const emailId = crypto.randomUUID();
      const unsubUrl = base
        ? `${base}/api/track/unsubscribe?id=${encodeURIComponent(emailId)}`
        : undefined;
      const trackedHtml = html ? injectTracking(html, emailId) : undefined;
      const textWithUnsub =
        text && unsubUrl ? `${text}\n\nUnsubscribe: ${unsubUrl}` : text;

      // Pass unsubscribe into mailer via headers if supported — extend sendEmail call
      const result = await sendEmail({
        to: r.email,
        subject,
        html: trackedHtml,
        text: textWithUnsub,
        fromName: body.fromName,
        listUnsubscribe: unsubUrl,
      });
      if (result.success) {
        if (hasDatabase()) {
          await logEmail({
            id: emailId,
            sender: cfg.fromEmail || cfg.user,
            recipient: r.email,
            subject,
            html: trackedHtml,
            text: textWithUnsub,
            status: 'delivered',
            messageId: result.messageId,
            campaignId,
          });
        }
        results.push({
          recipient: r.email,
          success: true,
          messageId: result.messageId,
        });
      } else {
        const { bounceType, status } = classifyFailure(result.error);
        if (hasDatabase()) {
          await logEmail({
            id: emailId,
            sender: cfg.fromEmail || cfg.user,
            recipient: r.email,
            subject,
            html: trackedHtml,
            text: textWithUnsub,
            status,
            error: result.error,
            campaignId,
            bounceType,
          });
        }
        results.push({
          recipient: r.email,
          success: false,
          error: result.error,
          status,
        });
      }
      if (i < recipients.length - 1) await delay(sendDelayMs());
    }

    const sent = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;
    return Response.json({
      success: sent > 0,
      total: results.length,
      sent,
      failed,
      skippedSuppressed,
      campaignId,
      results,
      tracking: Boolean(base),
      note:
        'SMTP accepted ≠ inbox delivery. Opens need HTML + APP_URL. Unsubscribes are tracked.',
    });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function GET() {
  const {
    verifyConnection,
    isMailConfigured,
    getMailConfig,
  } = require('../../../lib/mailer');
  const { hasDatabase } = require('../../../lib/db');
  const configured = isMailConfigured();
  let verified = false;
  let error;
  if (configured) {
    const r = await verifyConnection();
    verified = r.success;
    error = r.error;
  }
  const cfg = getMailConfig();
  return Response.json({
    service: 'Dispatch SMTP',
    provider: 'Gmail SMTP',
    configured,
    verified,
    error,
    host: cfg.host,
    from: cfg.fromEmail,
    database: hasDatabase(),
    appUrl: appBase() || null,
    features: ['open', 'click', 'unsubscribe', 'bounce_classify', 'campaignId'],
  });
}
