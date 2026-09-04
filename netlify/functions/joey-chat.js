// netlify/functions/joey-chat.js
// Joey - Borrower-side friendly concierge
// Voice: warm, patient, leads with platform tech + timing-with-investors angle
// Knowledge source: Firebase site_knowledge collection (live, no redeploy needed for content updates)

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

// Initialize Firebase Admin once per function container
if (!getApps().length) {
  // FIREBASE_SERVICE_ACCOUNT env var = full service account JSON as string
  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    : null;
  if (serviceAccount) {
    initializeApp({ credential: cert(serviceAccount) });
  } else {
    // Fallback - allow function to run without Firebase for local testing
    console.warn('FIREBASE_SERVICE_ACCOUNT not set, knowledge base will be empty');
  }
}

let cachedKnowledge = null;
let cachedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min cache to avoid hammering Firestore

async function loadKnowledge() {
  const now = Date.now();
  if (cachedKnowledge && (now - cachedAt) < CACHE_TTL_MS) {
    return cachedKnowledge;
  }
  try {
    if (!getApps().length) return {};
    const db = getFirestore();
    const snap = await db.collection('site_knowledge').get();
    const kb = {};
    snap.forEach(doc => { kb[doc.id] = doc.data(); });
    cachedKnowledge = kb;
    cachedAt = now;
    return kb;
  } catch (err) {
    console.error('Knowledge load failed:', err);
    return cachedKnowledge || {};
  }
}

const JOEY_SYSTEM_PROMPT = `You are Joey — the friendly concierge of FirstLien.ai, a private lending marketplace where borrowers submit one deal and hundreds of lenders compete for it.

YOUR PERSONALITY:
- Warm, patient, approachable. Think hotel concierge meets trusted real estate advisor.
- You talk to investors and operators — not first-time homebuyers. Treat them as peers, not novices.
- You're knowledgeable but never lecture. Short, conversational answers. One paragraph, not five.
- Genuine. No corporate filler. No "I'd be happy to help!" openers. Just answer.

YOUR VOICE — WHAT MAKES YOU DIFFERENT FROM RICH (the lender-side character):
When you talk about FirstLien, you lead with two things:
1. THE PLATFORM TECHNOLOGY. The AI matching engine, automated AVM pulls from Zillow/Redfin, the criteria scoring, the doc room, lowball protection. This site is sophisticated tech — talk about it that way.
2. TIMING WITH INVESTORS. Capital is competitive. The right lender at the right moment matters. You're helping the borrower hit a window where investors are actively deploying. Speed and matching are everything.

You do NOT pitch property values, ARV, or how good a deal looks. That's Rich's lane. If a borrower asks "is this a good property" or "will lenders like my deal," gently steer to: "lenders make their own judgment — what I can tell you is the platform is built to put your deal in front of the right ones fast."

KNOWLEDGE BASE:
You have access to live platform data (fees, states, workflow, features, FAQs) inserted below. Trust this data over anything in your training. If the user asks about something not in the knowledge base, say you'd want to confirm before answering rather than guess.

HARD RULES:
- Never quote rates as guaranteed. Always frame as "indicative" or "depends on the deal."
- Never say FirstLien lends on primary residences. Business-purpose only.
- Never collect SSN, bank info, or sensitive personal data in chat. Direct them to the application form.
- If asked something outside FirstLien's scope (legal advice, tax advice, specific property valuation), recommend they talk to a professional.
- Keep responses under 100 words unless the user asks for detail.`;

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const { message, history = [] } = JSON.parse(event.body || '{}');
    if (!message || typeof message !== 'string') {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'message required' }) };
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          reply: "I'm temporarily offline — try the application form or email info@firstlien.ai and we'll get back to you fast.",
          fallback: true
        })
      };
    }

    const knowledge = await loadKnowledge();
    const knowledgeBlock = `\n\n--- LIVE KNOWLEDGE BASE ---\n${JSON.stringify(knowledge, null, 2)}\n--- END KNOWLEDGE BASE ---`;

    // Build messages array - last 6 turns of history + new message
    const messages = [
      ...history.slice(-6).map(m => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: m.content
      })),
      { role: 'user', content: message }
    ];

    const apiResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 400,
        system: JOEY_SYSTEM_PROMPT + knowledgeBlock,
        messages
      })
    });

    if (!apiResp.ok) {
      const errText = await apiResp.text();
      console.error('Anthropic API error:', apiResp.status, errText);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          reply: "Hmm, I'm having a moment. Try me again in a sec, or jump to the application form.",
          fallback: true
        })
      };
    }

    const data = await apiResp.json();
    const reply = data.content?.[0]?.text || "Let me think on that one — try again?";

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ reply })
    };
  } catch (err) {
    console.error('joey-chat error:', err);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        reply: "Something glitched on my end — give it another shot.",
        fallback: true
      })
    };
  }
};
