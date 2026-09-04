// netlify/functions/create-deal.js
// ─────────────────────────────────────────────────────────────────────────────
// FirstLien — create a docOrder deal (server-side proxy)
//
// The borrower-upload flow needs a docOrder deal to attach files to. Creating a
// deal requires docOrder's operator (admin) credentials — which must NEVER touch
// the browser. This function holds them server-side and hands the browser back
// only the deal id + its per-deal upload token, which is all the browser needs
// to upload documents to docOrder's public, token-gated intake endpoints.
//
// SECURITY: set these on Netlify → Site settings → Environment variables:
//   DOCORDER_ADMIN_USER   docOrder operator username (ADMIN_USER on docOrder)
//   DOCORDER_ADMIN_PASS   docOrder operator password (ADMIN_PASS on docOrder)
// Optional:
//   DOCORDER_BASE_URL     defaults to https://docorder.app
//
// docOrder endpoint used: POST /api/deals/create  (HTTP Basic auth)
//   → { success, deal_id, file_num, intake_url, expires_at }
//   intake_url embeds the per-deal token as ?t=<link_token>; we parse it out.
// ─────────────────────────────────────────────────────────────────────────────

const BASE = (process.env.DOCORDER_BASE_URL || 'https://docorder.app').replace(/\/+$/, '');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

function reply(statusCode, obj) {
  return { statusCode, headers: CORS, body: JSON.stringify(obj) };
}

// FL-YYYYMMDD-XXXX  (date + 4 random base36 chars) — human-readable, collision-safe
function genFileNum() {
  const d = new Date();
  const ymd = d.toISOString().slice(0, 10).replace(/-/g, '');
  const rnd = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `FL-${ymd}-${rnd}`;
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return reply(405, { error: 'Method not allowed' });

  const user = process.env.DOCORDER_ADMIN_USER;
  const pass = process.env.DOCORDER_ADMIN_PASS;
  if (!user || !pass) {
    return reply(500, {
      error: 'docOrder admin credentials not configured on server',
      hint: 'Set DOCORDER_ADMIN_USER and DOCORDER_ADMIN_PASS in Netlify env vars.'
    });
  }

  let body = {};
  try { body = event.body ? JSON.parse(event.body) : {}; } catch (_) {
    return reply(400, { error: 'Invalid JSON body' });
  }

  // The borrower has nothing yet — that is the whole point. Only a file number is
  // required by docOrder; everything else is filled by the document reader or the
  // borrower later. We pass through a few optional hints if the page has them.
  const payload = {
    fileNum: (body.fileNum && String(body.fileNum).trim()) || genFileNum(),
    force: true // always a fresh deal for a new borrower session
  };
  if (body.entityName && String(body.entityName).trim()) payload.entityName = String(body.entityName).trim();
  if (body.state && String(body.state).trim()) payload.state = String(body.state).trim();
  if (body.brokerSlug && String(body.brokerSlug).trim()) payload.brokerSlug = String(body.brokerSlug).trim();

  const auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

  let resp, data;
  try {
    resp = await fetch(`${BASE}/api/deals/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': auth },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    return reply(502, { error: 'Could not reach docOrder', detail: String(e && e.message || e) });
  }

  const text = await resp.text();
  try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { raw: text }; }

  if (!resp.ok) {
    // Surface docOrder's own error (401 bad creds, 409 dup, etc.) without leaking creds.
    return reply(resp.status, {
      error: 'docOrder rejected the deal creation',
      status: resp.status,
      detail: data.error || data.message || data.warning || text.slice(0, 300)
    });
  }

  // Pull the per-deal token out of intake_url (?t=...). This token — not the
  // admin password — is what the browser uses to upload documents.
  let token = '';
  try {
    const u = new URL(data.intake_url);
    token = u.searchParams.get('t') || '';
  } catch (_) { /* intake_url may be relative or absent; token stays '' */ }

  // NOTE: we deliberately do NOT return the upstream base URL to the browser.
  // The browser uploads via the same-origin proxy path (/api/docs/*, see _redirects)
  // so the document engine's host is never exposed to end users.
  return reply(200, {
    success: true,
    deal_id: data.deal_id,
    file_num: data.file_num,
    token,
    expires_at: data.expires_at || null
  });
};
