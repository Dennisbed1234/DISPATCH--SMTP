const crypto = require('crypto');
const {
  sendEmail,
  isMailConfigured,
  getMailConfig,
  sendDelayMs,
  delay,
} = require('../../../lib/mailer');
const { logEmail } = require('../../../lib/store');
const { hasDatabase } = require('../../../lib/db');

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
  const raw = (process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || '').trim();
  return raw.replace(/\/$/, '');
}

/** Append open pixel + rewrite http(s) links through /api/track/click */
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

  const pixel = `<img src="${base}/api/track/open?id=${encodeURIComponent(
    emailId
  )}" width="1" height="1" alt="" style="display:none;width:1px;height:1px;border:0;" />`;
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
    const recipients = parseRecipients(body.to).slice(0, 500);
    const subject = String(body.subject || '').trim();
    let html = body.html ? String(body.html) : undefined;
    const text =
      body.text || body.message
        ? String(body.text || body.message)
        : undefined;
    const dryRun = Boolean(body.dryRun);

    if (!recipients.length || !subject || (!html && !text)) {
      return Response.json(
        { error: 'to, subject, and html or text required' },
        { status: 400 }
      );
    }

    if (dryRun) {
      return Response.json({
        success: true,
        dryRun: true,
        wouldSend: recipients.length,
        recipients: recipients.map((r) => ({
          email: r.email,
          subject,
        })),
      });
    }

    const cfg = getMailConfig();
    const results = [];
    for (let i = 0; i < recipients.length; i++) {
      const r = recipients[i];
      const emailId = crypto.randomUUID();
      const trackedHtml = html ? injectTracking(html, emailId) : undefined;

      const result = await sendEmail({
        to: r.email,
        subject,
        html: trackedHtml,
        text,
        fromName: body.fromName,
      });
      if (result.success) {
        if (hasDatabase()) {
          await logEmail({
            id: emailId,
            sender: cfg.fromEmail || cfg.user,
            recipient: r.email,
            subject,
            html: trackedHtml,
            text,
            status: 'delivered',
            messageId: result.messageId,
          });
        }
        results.push({
          recipient: r.email,
          success: true,
          messageId: result.messageId,
        });
      } else {
        if (hasDatabase()) {
          await logEmail({
            id: emailId,
            sender: cfg.fromEmail || cfg.user,
            recipient: r.email,
            subject,
            html: trackedHtml,
            text,
            status: 'failed',
            error: result.error,
          });
        }
        results.push({
          recipient: r.email,
          success: false,
          error: result.error,
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
      results,
      tracking: Boolean(appBase()),
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
  });
}
