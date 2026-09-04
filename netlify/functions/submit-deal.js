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
    const out = { success: true, ref, id: ref, collection };
    if (portalToken) out.portalToken = portalToken;
    return reply(200, out);
  } catch (e) {
    console.error('[submit-deal] write failed:', e);
    return reply(500, { error: 'Could not save submission', fallback: true, detail: String(e && e.message || e) });
  }
};
