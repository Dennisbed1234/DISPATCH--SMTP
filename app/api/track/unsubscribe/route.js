const { query, hasDatabase, ensureEmailTrackingColumns } = require('../../../../lib/db');

export const dynamic = 'force-dynamic';

async function markUnsubscribed(id) {
  if (!id || !hasDatabase()) return false;
  await ensureEmailTrackingColumns();
  try {
    await query(
      `UPDATE emails SET
        status = 'unsubscribed',
        unsubscribed_at = COALESCE(unsubscribed_at, NOW()),
        last_event = 'unsubscribed'
       WHERE id = $1`,
      [id]
    );
    return true;
  } catch (e) {
    console.error('[track/unsubscribe]', e.message);
    return false;
  }
}

function okHtml() {
  return new Response(
    `<!DOCTYPE html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Unsubscribed</title></head>
<body style="margin:0;font-family:system-ui,sans-serif;background:#0b1220;color:#e2e8f0;display:flex;min-height:100vh;align-items:center;justify-content:center;">
  <div style="max-width:420px;padding:32px;text-align:center;">
    <h1 style="font-size:22px;margin:0 0 12px;">You're unsubscribed</h1>
    <p style="margin:0;color:#94a3b8;line-height:1.5;font-size:15px;">You will not receive further marketing emails from this sender on this address.</p>
  </div>
</body></html>`,
    {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    }
  );
}

export async function POST(request) {
  const url = new URL(request.url);
  let id = url.searchParams.get('id') || '';
  if (!id) {
    try {
      const fd = await request.formData();
      id = String(fd.get('id') || '');
    } catch {
      /* ignore */
    }
  }
  await markUnsubscribed(String(id).trim());
  return new Response(null, { status: 204 });
}

export async function GET(request) {
  const url = new URL(request.url);
  const id = (url.searchParams.get('id') || '').trim();
  await markUnsubscribed(id);
  return okHtml();
}
