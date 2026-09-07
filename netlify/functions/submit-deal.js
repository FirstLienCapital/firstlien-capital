// netlify/functions/submit-deal.js
// ─────────────────────────────────────────────────────────────────────────────
// FirstLien — persist a submission to Firestore (server-side).
//
// Serves BOTH forms:
//   • borrower deal submission (borrower.html)  → collection "deals"
//   • lender access application (lender.html)    → collection "lender_applications"
//
// Writing happens with the Firebase Admin SDK using the same service-account
// credential joey-chat.js already uses, so no client-side Firestore rules need
// to be opened to the public. The browser never holds a database credential.
//
// SECURITY / SETUP (Netlify → Site settings → Environment variables):
//   FIREBASE_SERVICE_ACCOUNT   full service-account JSON as a string (already set
//                              for joey-chat). Without it, this returns 503 and
//                              the page falls back to a local reference so the
//                              user is never blocked.
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require('crypto');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

if (!getApps().length) {
  const sa = process.env.FIREBASE_SERVICE_ACCOUNT ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT) : null;
  if (sa) initializeApp({ credential: cert(sa) });
  else console.warn('[submit-deal] FIREBASE_SERVICE_ACCOUNT not set — writes will 503');
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};
const reply = (statusCode, obj) => ({ statusCode, headers: CORS, body: JSON.stringify(obj) });

// FL-XXXXXX reference (time-based, uppercase) — matches the on-page format.
function genRef() {
  return 'FL-' + Date.now().toString(36).toUpperCase().slice(-6);
}

// ── Email notification (Brevo) ───────────────────────────────────────────────
// Every submission pings the operator's inbox. Requires BREVO_API_KEY in
// Netlify env (and info@firstlien.ai verified as a sender in Brevo).
// Failures are swallowed — a broken email must never block a submission.
const NOTIFY_TO = process.env.NOTIFY_EMAIL || 'info@firstlien.ai';
const NOTIFY_FROM = process.env.NOTIFY_FROM || 'info@firstlien.ai';

function esc(s) { return String(s == null ? '' : s).replace(/</g, '&lt;'); }
function row(label, val) {
  if (val == null || String(val).trim() === '') return '';
  return `<tr><td style="padding:6px 14px 6px 0;color:#7a7060;font-size:13px;white-space:nowrap;">${esc(label)}</td><td style="padding:6px 0;font-size:14px;color:#0f0e0c;"><b>${esc(val)}</b></td></tr>`;
}

async function notifyByEmail(type, ref, body) {
  const key = process.env.BREVO_API_KEY;
  if (!key) return; // not configured — skip silently
  let subject, rows;
  if (type === 'lender') {
    subject = `New lender application — ${body.name || 'Unknown'} (${body.capital || 'capital n/a'})`;
    rows = row('Name', body.name) + row('Email', body.email) + row('Phone', body.phone) +
      row('Company / Fund', body.company) + row('Lender type', body.investorType) +
      row('Accredited', body.accredited) + row('Capital to deploy', body.capital) +
      row('Typical deal size', body.dealSize) + row('States', body.geography) +
      row('Loan types', Array.isArray(body.loanTypes) ? body.loanTypes.join(', ') : '') +
      row('Website', body.website);
  } else {
    const b = body.borrower || {}, p = body.property || {}, l = body.loan || {};
    subject = `New borrower deal ${ref} — ${l.amount || 'amount n/a'} · ${p.address || 'address n/a'}`;
    rows = row('Borrower', b.name) + row('Email', b.email) + row('Phone', b.phone) +
      row('Property', p.address) + row('Type', p.type) + row('Stated value', p.value) +
      row('Loan amount', l.amount) + row('Term', l.term) + row('LTV', l.ltv) +
      row('Purpose', p.purpose) + row('Exit', l.exit) + row('Timing', l.timing) +
      row('Experience', b.experience) + row('FICO', b.fico) + row('Story', l.story) +
      row('Documents', body.docorder && body.docorder.dealId ? 'Linked (' + (body.docorder.fileNum || body.docorder.dealId) + ')' : '');
  }
  const html = `<div style="font-family:Arial,sans-serif;max-width:560px;">
    <h2 style="font-size:18px;color:#0f0e0c;">${esc(subject)}</h2>
    <table style="border-collapse:collapse;">${rows}</table>
    <p style="margin-top:18px;"><a href="https://firstlien.ai/admin.html" style="color:#b08830;">Open the Submissions inbox →</a></p>
    <p style="color:#7a7060;font-size:11px;">Ref ${esc(ref)} · FirstLien.ai automated notification</p></div>`;
  try {
    const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': key },
      body: JSON.stringify({
        sender: { email: NOTIFY_FROM, name: 'FirstLien.ai' },
        to: [{ email: NOTIFY_TO }],
        subject,
        htmlContent: html
      })
    });
    if (!resp.ok) console.error('[submit-deal] notify failed:', resp.status, (await resp.text()).slice(0, 200));
  } catch (e) {
    console.error('[submit-deal] notify error:', e && e.message);
  }
}

// Keep only strings/numbers/booleans/plain nested objects; cap depth & string length.
function clean(v, depth) {
  if (depth > 4) return null;
  if (v == null) return null;
  const t = typeof v;
  if (t === 'string') return v.slice(0, 4000);
  if (t === 'number' || t === 'boolean') return v;
  if (Array.isArray(v)) return v.slice(0, 50).map(x => clean(x, depth + 1));
  if (t === 'object') {
    const o = {};
    Object.keys(v).slice(0, 60).forEach(k => { const c = clean(v[k], depth + 1); if (c !== null) o[k] = c; });
    return o;
  }
  return null;
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return reply(405, { error: 'Method not allowed' });

  let body = {};
  try { body = event.body ? JSON.parse(event.body) : {}; } catch (_) { return reply(400, { error: 'Invalid JSON body' }); }

  const type = body.type === 'lender' ? 'lender' : 'borrower';
  const collection = type === 'lender' ? 'lender_applications' : 'deals';

  // Minimal presence check so we don't store empty rows (honeypot too).
  if (body.company_url && String(body.company_url).trim()) return reply(200, { success: true, ref: 'received' });
  const contact = body.email || (body.borrower && body.borrower.email);
  if (!contact || !String(contact).trim()) return reply(400, { error: 'An email is required.' });

  if (!getApps().length) {
    // Not configured — tell the page to fall back to a local ref (never block the user).
    return reply(503, { error: 'submission store not configured', fallback: true });
  }

  const ref = (body.ref && String(body.ref).trim()) || genRef();
  const record = clean({ ...body }, 0) || {};
  delete record.type;
  record.ref = ref;
  record.kind = type;
  record.status = 'new';
  record.source = type === 'lender' ? 'lender_form' : 'borrower_form';
  record.userAgent = (event.headers && (event.headers['user-agent'] || event.headers['User-Agent']) || '').slice(0, 300);

  // Per-deal access token — the borrower's portal link carries this so a deal
  // (which holds name/email/phone/property) can never be read from its ref alone.
  let portalToken = '';
  if (type === 'borrower') {
    portalToken = crypto.randomBytes(24).toString('base64url');
    record.portalToken = portalToken;
  }

  try {
    const db = getFirestore();
    record.createdAt = FieldValue.serverTimestamp();
    await db.collection(collection).doc(ref).set(record, { merge: true });
    await notifyByEmail(type, ref, body); // never throws; skipped if BREVO_API_KEY unset
    const out = { success: true, ref, id: ref, collection };
    if (portalToken) out.portalToken = portalToken;
    return reply(200, out);
  } catch (e) {
    console.error('[submit-deal] write failed:', e);
    return reply(500, { error: 'Could not save submission', fallback: true, detail: String(e && e.message || e) });
  }
};
