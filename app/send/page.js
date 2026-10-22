'use client';

import { useMemo, useState } from 'react';

function countEmails(raw) {
  const seen = new Set();
  for (const part of String(raw || '').split(/[\s,;]+/)) {
    const e = part.trim().toLowerCase();
    if (e.includes('@') && e.includes('.')) seen.add(e);
  }
  return seen.size;
}

export default function SendPage() {
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('');
  const [html, setHtml] = useState(
    '<div style="font-family:system-ui,sans-serif;padding:20px;background:#0a0f1c;color:#e2e8f0"><h2 style="color:#22d3ee">Hello</h2><p>Your message goes here.</p></div>'
  );
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState('');

  const recipientCount = useMemo(() => countEmails(to), [to]);

  async function submit(e) {
    e.preventDefault();
    setSending(true);
    setResult('');
    try {
      const res = await fetch('/api/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, subject, html }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setResult(`Sent ${data.sent} · Failed ${data.failed} · Total ${data.total}`);
    } catch (err) {
      setResult(err.message);
    }
    setSending(false);
  }

  return (
    <main className="container">
      <h1>Transmit</h1>
      <p className="subtitle">Gmail SMTP · HTML + live preview</p>
      <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))' }}>
        <div className="card">
          <form onSubmit={submit}>
            <label>
              Recipients{' '}
              {recipientCount > 0 && (
                <span style={{ color: '#22d3ee', fontWeight: 700 }}>
                  ({recipientCount} {recipientCount === 1 ? 'email' : 'emails'})
                </span>
              )}
            </label>
            <textarea
              rows={4}
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder={"user@gmail.com\nclient@company.com"}
              required
            />
            <small style={{ color: '#94a3b8', display: 'block', marginTop: 4 }}>
              Separate with commas, spaces, or new lines. Count updates as you paste.
            </small>
            <label>Subject</label>
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Your subject"
              required
            />
            <label>HTML payload</label>
            <textarea rows={10} value={html} onChange={(e) => setHtml(e.target.value)} />
            <button type="submit" className="button" disabled={sending} style={{ marginTop: 14 }}>
              {sending
                ? 'Transmitting…'
                : recipientCount > 0
                  ? `Send to ${recipientCount} ${recipientCount === 1 ? 'email' : 'emails'}`
                  : 'Send via Google Workspace'}
            </button>
          </form>
          {result && <div className="result">{result}</div>}
        </div>
        <div className="card">
          <label style={{ marginTop: 0 }}>Preview</label>
          <iframe
            title="preview"
            srcDoc={html}
            style={{ width: '100%', minHeight: 360, border: '1px solid rgba(34,211,238,0.2)', marginTop: 8 }}
            sandbox=""
          />
        </div>
      </div>
    </main>
  );
}
