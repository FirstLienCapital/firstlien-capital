// netlify/functions/extract-fields.js
// ─────────────────────────────────────────────────────────────────────────────
// FirstLien.ai — AI-powered field extraction proxy
//
// Receives raw text from uploaded loan documents and asks Claude to return
// structured JSON with all deal fields. This replaces fragile regex patterns
// that broke due to browser/Python text extraction differences.
//
// SECURITY: The ANTHROPIC_API_KEY env var lives on Netlify server-side only.
// The browser never sees it. Set it at:
//   Netlify → Site settings → Environment variables → ANTHROPIC_API_KEY
//
// Model: claude-sonnet-4-20250514 (balanced speed/accuracy for this task)
// ─────────────────────────────────────────────────────────────────────────────

exports.handler = async function(event) {
  // CORS (allow same-origin calls from /admin.html)
  var headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  var apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: headers,
      body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured on server' })
    };
  }

  var body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers: headers, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  var docText = body.text;
  if (!docText || typeof docText !== 'string' || docText.length < 50) {
    return { statusCode: 400, headers: headers, body: JSON.stringify({ error: 'text field required (min 50 chars)' }) };
  }

  // Claude has a context window, but trim extreme cases to protect cost/latency
  // 200K chars is well under the model's limit while covering typical multi-doc batches
  if (docText.length > 200000) {
    docText = docText.substring(0, 200000);
  }

  // ── EXTRACTION PROMPT ──────────────────────────────────────────────────────
  // This is the instruction set Claude follows. Uses priority order to resolve
  // conflicts when multiple source docs disagree.
  var systemPrompt =
    'You are a mortgage document parser for a private lending marketplace. ' +
    'You extract structured fields from loan documents (escrow instructions, loan notes, ' +
    'loan quotes, doc order forms, term sheets, title commitments) and return them as JSON. ' +
    'You return ONLY valid JSON — no preamble, no markdown fences, no explanations. ' +
    'Use null for any field you cannot find or verify. Never guess or fabricate.';

  var userPrompt =
    'Extract the following fields from the loan documents below. ' +
    'Return ONLY a JSON object with these exact keys (use null if a field is not found):\n\n' +

    '// LOAN TERMS\n' +
    '"loan": numeric string like "99000" (just digits, no $ or commas)\n' +
    '"rate": numeric string like "12.99" (percent as decimal, no %)\n' +
    '"amortPeriod": number of amortization months like "480" (40 years = 480 months)\n' +
    '"loanTerm": number of loan term months like "24" (convert "2-Year" → "24")\n' +
    '"monthly": monthly P&I payment string like "1077.81" (no $ or commas)\n' +
    '"balloon": balloon payment string like "99910.70" (no $ or commas)\n' +
    '"reserve": interest reserve amount like "3233.43" (no $ or commas)\n' +
    '"perDiem": per diem interest string like "35.72" (no $)\n' +

    '// DATES (use format like "July 1, 2026")\n' +
    '"pdThru": per diem through date string\n' +
    '"firstPmt": first borrower payment date string\n' +
    '"maturityDate": maturity/balloon date string\n' +
    '"docDate": document date string\n' +

    '// IDENTIFIERS\n' +
    '"fileno": file number digits like "49821"\n' +
    '"escrow": escrow number like "PA-79427" or "GF#270100A"\n' +

    '// BROKER & FEES\n' +
    '"origbroker": originating broker name like "In & Out Solutions"\n' +
    '"origpct": origination percentage as decimal string like "2.00"\n' +
    '"origfee": lender origination fee dollar amount like "3465.00" (no $)\n' +

    '// BORROWER ENTITY\n' +
    '"entity": entity legal name like "Business Solutions"\n' +
    '"etype": entity type like "Sole Proprietorship" or "Texas limited liability company"\n' +

    '// GUARANTOR\n' +
    '"gname": guarantor full legal name like "Donna M. Moore"\n' +
    '"gaddr": guarantor street address like "10 Holloman AVE"\n' +
    '"gcsz": guarantor city/state/zip like "La Luz, NM 88337"\n' +

    '// PROPERTY\n' +
    '"propaddr": property street address\n' +
    '"propcsz": property city/state/zip\n' +
    '"propcommon": full property description\n' +
    '"county": county name without "County" suffix, like "Otero"\n' +
    '"state": state full name like "New Mexico"\n' +
    '"apn": APN/tax ID\n' +

    '// TITLE & SERVICING\n' +
    '"titleco": title company full name\n' +
    '"titleoff": closing officer name\n' +
    '"titleem": title officer email\n' +
    '"titleaddr": title company street address\n' +
    '"titleund": title insurance underwriter\n' +
    '"servicer": loan servicer name (often "Superior Loan Servicing")\n\n' +

    'CONFLICT RESOLUTION PRIORITY (when docs disagree):\n' +
    '1. Escrow instructions / loan docs (final executed amounts)\n' +
    '2. Doc order form (canonical party info)\n' +
    '3. Loan quote / term sheet (initial terms)\n' +
    '4. Title commitment (property info only)\n\n' +

    'IMPORTANT:\n' +
    '- If the batch contains documents from multiple deals (different file numbers), ' +
    'prefer the deal with the most documents and ignore contaminating docs.\n' +
    '- Do not invent values. Return null for anything you cannot verify.\n' +
    '- Return ONLY the JSON object. No markdown, no commentary.\n\n' +

    '=== DOCUMENTS ===\n\n' + docText;

  // ── Call Claude API ────────────────────────────────────────────────────────
  try {
    var response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        system: systemPrompt,
        messages: [
          { role: 'user', content: userPrompt }
        ]
      })
    });

    if (!response.ok) {
      var errText = await response.text();
      return {
        statusCode: response.status,
        headers: headers,
        body: JSON.stringify({
          error: 'Anthropic API returned ' + response.status,
          detail: errText.substring(0, 500)
        })
      };
    }

    var data = await response.json();

    // Extract text from response — may be multiple content blocks, concatenate text ones
    var rawText = (data.content || [])
      .filter(function (b) { return b.type === 'text'; })
      .map(function (b) { return b.text || ''; })
      .join('');

    // Strip markdown code fences if Claude wrapped the JSON despite instructions
    var cleaned = rawText
      .replace(/^\s*```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/i, '')
      .trim();

    // Parse JSON
    var extracted;
    try {
      extracted = JSON.parse(cleaned);
    } catch (parseErr) {
      // Last-resort: find the first balanced {...} block
      var m = cleaned.match(/\{[\s\S]*\}/);
      if (m) {
        try { extracted = JSON.parse(m[0]); }
        catch (e2) {
          return {
            statusCode: 502,
            headers: headers,
            body: JSON.stringify({
              error: 'Could not parse Claude response as JSON',
              raw: rawText.substring(0, 1000)
            })
          };
        }
      } else {
        return {
          statusCode: 502,
          headers: headers,
          body: JSON.stringify({
            error: 'No JSON found in Claude response',
            raw: rawText.substring(0, 1000)
          })
        };
      }
    }

    // Return the extracted fields plus some metadata for the client log
    return {
      statusCode: 200,
      headers: headers,
      body: JSON.stringify({
        fields: extracted,
        model: data.model || 'claude-sonnet-4-20250514',
        usage: data.usage || null
      })
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: headers,
      body: JSON.stringify({ error: 'Server error: ' + err.message })
    };
  }
};
