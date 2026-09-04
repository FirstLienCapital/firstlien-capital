// netlify/functions/list-submissions.js
// ─────────────────────────────────────────────────────────────────────────────
// FirstLien — admin inbox: list borrower deals + lender applications (server-side).
//
// This returns EVERY borrower's name/email/phone and every lender lead, so it is
// gated by a SECRET operator token that lives ONLY in a Netlify env var — never
// in the repo. (The admin.html login password is hardcoded in a public file and
// therefore provides no real protection; this token is the real gate.)
//
// SETUP (Netlify → Site settings → Environment variables):
//   ADMIN_DASH_TOKEN         a long random secret you choose; the admin inbox
//                            prompts the operator for it and sends it as a header.
//   FIREBASE_SERVICE_ACCOUNT full service-account JSON (already set for joey-chat).
//
// GET/POST /.netlify/functions/list-submissions
//   header X-Admin-Token: <ADMIN_DASH_TOKEN>   (or ?token= / body.token)
//   → 200 { deals:[...], lenders:[...], counts:{deals,lenders} }
//   → 401 wrong/missing token · 503 not configured
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require('crypto');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

if (!getApps().length) {
  const sa = process.env.FIREBASE_SERVICE_ACCOUNT ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT) : null;
  if (sa) initializeApp({ credential: cert(sa) });
  else console.warn('[list-submissions] FIREBASE_SERVICE_ACCOUNT not set');
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token',
  'Content-Type': 'application/json'
};
const reply = (statusCode, obj) => ({ statusCode, headers: CORS, body: JSON.stringify(obj) });

function safeEqual(a, b) {
  a = String(a || ''); b = String(b || '');
  const ab = Buffer.from(a), bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
function toIso(v) {
  if (!v) return null;
  if (typeof v === 'string') return v;
  if (typeof v.toDate === 'function') { try { return v.toDate().toISOString(); } catch (_) { return null; } }
  if (typeof v._seconds === 'number') return new Date(v._seconds * 1000).toISOString();
  return null;
}

// Pull recent docs from a collection, newest first, tolerant of a missing index.
async function recent(db, coll, limit) {
  try {
    const snap = await db.collection(coll).orderBy('createdAt', 'desc').limit(limit).get();
    return snap.docs.map(d => d.data());
  } catch (_) {
    const snap = await db.collection(coll).limit(limit).get();
    return snap.docs.map(d => d.data())
      .sort((a, b) => (toIso(b.createdAt) || '').localeCompare(toIso(a.createdAt) || ''));
  }
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  const h = event.headers || {};
  const q = event.queryStringParameters || {};
  let body = {};
  if (event.httpMethod === 'POST') { try { body = event.body ? JSON.parse(event.body) : {}; } catch (_) {} }
  const token = h['x-admin-token'] || h['X-Admin-Token'] || q.token || body.token || '';

  const secret = process.env.ADMIN_DASH_TOKEN;
  if (!secret || !getApps().length) {
    return reply(503, { error: 'submissions inbox not configured', needsToken: !secret });
  }
  if (!safeEqual(token, secret)) {
    return reply(401, { error: 'Invalid access token' });
  }

  const limit = Math.min(parseInt(q.limit || '200', 10) || 200, 500);

  try {
    const db = getFirestore();
    const [dealsRaw, lendersRaw] = await Promise.all([
      recent(db, 'deals', limit),
      recent(db, 'lender_applications', limit)
    ]);

    // Deals — strip the portal token; keep what the inbox shows.
    const deals = dealsRaw.map(d => ({
      ref: d.ref || null,
      createdAt: toIso(d.createdAt),
      status: d.status || 'new',
      borrower: d.borrower || {},
      property: d.property || {},
      loan: d.loan || {},
      docorder: d.docorder || null
    }));

    const lenders = lendersRaw.map(l => ({
      ref: l.ref || null,
      createdAt: toIso(l.createdAt),
      status: l.status || 'new',
      name: l.name || '',
      email: l.email || '',
      phone: l.phone || '',
      company: l.company || '',
      investorType: l.investorType || '',
      capital: l.capital || '',
      dealSize: l.dealSize || '',
      geography: l.geography || '',
      loanTypes: Array.isArray(l.loanTypes) ? l.loanTypes : [],
      website: l.website || '',
      accredited: l.accredited || ''
    }));

    return reply(200, { deals, lenders, counts: { deals: deals.length, lenders: lenders.length } });
  } catch (e) {
    console.error('[list-submissions] read failed:', e);
    return reply(500, { error: 'Could not load submissions.' });
  }
};
