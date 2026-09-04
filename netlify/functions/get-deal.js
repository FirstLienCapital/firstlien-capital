// netlify/functions/get-deal.js
// ─────────────────────────────────────────────────────────────────────────────
// FirstLien — read a borrower deal for the portal (server-side).
//
// A deal reference (FL-XXXXXX) is guessable and a deal holds the borrower's
// name, email, phone, and property. So a deal is returned ONLY when the request
// carries the correct per-deal portal token (minted in submit-deal.js and
// delivered in the portal link as ?t=<token>). Constant-time compared.
//
// GET /.netlify/functions/get-deal?ref=FL-XXXXXX&t=<token>
//   → 200 { success, deal:{ ref, createdAt, status, property, loan, borrower, docorder } }
//   → 403 wrong/missing token · 404 no such deal · 503 store not configured
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require('crypto');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

if (!getApps().length) {
  const sa = process.env.FIREBASE_SERVICE_ACCOUNT ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT) : null;
  if (sa) initializeApp({ credential: cert(sa) });
  else console.warn('[get-deal] FIREBASE_SERVICE_ACCOUNT not set — reads will 503');
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};
const reply = (statusCode, obj) => ({ statusCode, headers: CORS, body: JSON.stringify(obj) });

// Constant-time string compare that never throws on length mismatch.
function safeEqual(a, b) {
  a = String(a || ''); b = String(b || '');
  const ab = Buffer.from(a), bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// Firestore Timestamp → ISO string (the portal does new Date(createdAt)).
function toIso(v) {
  if (!v) return null;
  if (typeof v === 'string') return v;
  if (typeof v.toDate === 'function') { try { return v.toDate().toISOString(); } catch (_) { return null; } }
  if (typeof v._seconds === 'number') return new Date(v._seconds * 1000).toISOString();
  return null;
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  const q = event.queryStringParameters || {};
  let body = {};
  if (event.httpMethod === 'POST') { try { body = event.body ? JSON.parse(event.body) : {}; } catch (_) {} }
  const ref = String(q.ref || q.deal || body.ref || body.deal || '').trim();
  const token = String(q.t || q.token || body.t || body.token || '').trim();

  if (!ref) return reply(400, { error: 'ref required' });
  if (!token) return reply(403, { error: 'This link is missing its security code. Use the full link we sent you.' });

  if (!getApps().length) return reply(503, { error: 'deal store not configured' });

  try {
    const db = getFirestore();
    const snap = await db.collection('deals').doc(ref).get();
    if (!snap.exists) return reply(404, { error: 'No such deal.' });
    const d = snap.data() || {};

    if (!d.portalToken || !safeEqual(token, d.portalToken)) {
      return reply(403, { error: 'This link’s security code is not valid.' });
    }

    // Return only what the portal renders — never the token or internal audit fields.
    const deal = {
      ref: d.ref || ref,
      createdAt: toIso(d.createdAt) || new Date().toISOString(),
      status: d.status || 'new',
      property: d.property || {},
      loan: d.loan || {},
      borrower: d.borrower || {},
      docorder: d.docorder || null
    };
    return reply(200, { success: true, deal });
  } catch (e) {
    console.error('[get-deal] read failed:', e);
    return reply(500, { error: 'Could not load the deal.' });
  }
};
