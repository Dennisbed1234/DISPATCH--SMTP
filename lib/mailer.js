const nodemailer = require('nodemailer');

let transporter = null;

function extractEmail(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const angle = s.match(/<([^>]+@[^>]+)>/);
  if (angle) return angle[1].trim().toLowerCase();
  const plain = s.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  return plain ? plain[0].toLowerCase() : s.includes('@') ? s.toLowerCase() : '';
}

function resolveFromName() {
  const raw =
    process.env.MAIL_FROM_NAME ||
    process.env.GMAIL_FROM_NAME ||
    process.env.ZOHO_FROM_NAME ||
    process.env.FROM_NAME ||
    process.env.SENDER_NAME ||
    'CryptoByt';
  const name = String(raw)
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/[<>]/g, '');
  if (!name || /^dispatch$/i.test(name)) return 'CryptoByt';
  return name;
}

function getMailConfig() {
  const user =
    extractEmail(
      process.env.SMTP_USER ||
        process.env.GMAIL_USER ||
        process.env.ZOHO_EMAIL ||
        ''
    ) || '';
  const pass = String(
    process.env.SMTP_PASS ||
      process.env.GMAIL_APP_PASS ||
      process.env.ZOHO_APP_PASS ||
      ''
  ).replace(/\s+/g, '');
  const host = (process.env.SMTP_HOST || 'smtp.gmail.com').trim();
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const fromEmail =
    extractEmail(process.env.MAIL_FROM || '') || user;
  const fromName = resolveFromName();
  return { user, pass, host, port, fromEmail, fromName };
}

function isMailConfigured() {
  const { user, pass } = getMailConfig();
  return Boolean(user && pass);
}

function getTransporter() {
  if (transporter) return transporter;
  const { user, pass, host, port } = getMailConfig();
  if (!user || !pass) {
    throw new Error(
      'SMTP not configured. Set SMTP_USER + SMTP_PASS (Gmail App Password).'
    );
  }
  transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
    pool: true,
    maxConnections: 2,
    maxMessages: 100,
    rateDelta: 1000,
    rateLimit: 8,
  });
  return transporter;
}

function personalize(template, vars) {
  return String(template || '').replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function sendEmail({ to, subject, html, text, fromName, attachments, listUnsubscribe }) {
  if (!isMailConfigured()) {
    return {
      success: false,
      error: 'Missing SMTP_USER / SMTP_PASS (Gmail App Password)',
    };
  }
  try {
    const cfg = getMailConfig();
    const t = getTransporter();
    let name = fromName || cfg.fromName;
    if (!name || /^dispatch$/i.test(String(name).trim())) {
      name = 'CryptoByt';
    }
    const from = name ? `"${name}" <${cfg.fromEmail}>` : cfg.fromEmail;
    const recipients = Array.isArray(to) ? to.join(', ') : to;
    const headers = {};
    if (listUnsubscribe) {
      headers['List-Unsubscribe'] = `<${listUnsubscribe}>`;
      headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
    }
    const info = await t.sendMail({
      from,
      to: recipients,
      subject,
      html: html || undefined,
      text: text || (html ? stripHtml(html) : '.'),
      replyTo: cfg.fromEmail,
      attachments,
      headers: Object.keys(headers).length ? headers : undefined,
    });
    return { success: true, messageId: info.messageId };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function verifyConnection() {
  if (!isMailConfigured()) {
    return { success: false, error: 'SMTP not configured' };
  }
  try {
    await getTransporter().verify();
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function sendDelayMs() {
  const base = parseInt(process.env.SMTP_SEND_DELAY_MS || '200', 10);
  if (!Number.isFinite(base) || base <= 0) return 0;
  return base + Math.floor(Math.random() * Math.min(150, base));
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = {
  sendEmail,
  verifyConnection,
  isMailConfigured,
  getMailConfig,
  personalize,
  sendDelayMs,
  delay,
};
