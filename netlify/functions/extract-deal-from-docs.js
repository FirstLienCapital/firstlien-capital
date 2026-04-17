// netlify/functions/extract-deal-from-docs.js
// Template-aware multi-state version.
// Extracts deal fields from uploaded supporting documents.
//
// Request body:
// {
//   docs: [{ name, mediaType, data(base64) }, ...],
//   state: "NC" | "AZ" | ... (optional),
//   placeholders: ["borrower_name", "guarantor_name", ...]  (the template's placeholders)
// }
//
// Returns: { fields: {...}, warnings: [...], source_notes: {...} }
//
// Requires: ANTHROPIC_API_KEY env var.

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-5';
const MAX_TOKENS = 4096;

function buildPrompt(placeholders, stateHint) {
  const stateClause = stateHint
    ? `\nThis is a ${stateHint} deal. Use ${stateHint}-appropriate legal terminology and defaults.`
    : '';

  return `You are extracting data from private-lending closing documents for FirstLien.Capital / Lender Funds (business-purpose / non-owner-occupied / investment loans only).${stateClause}

The attached documents may include: title commitment / ALTA report, commercial appraisal, 1003 loan application, broker doc order form, borrower ID, loan quote.

Extract the fields listed below. Return ONLY a JSON object — no markdown fences, no prose.

TEMPLATE PLACEHOLDERS (the current loan template expects these — fill whatever you can):
${placeholders.map(p => '  - ' + p).join('\n')}

UNIVERSAL FIELD DEFINITIONS (extract any that apply, matching placeholder names above):

Borrower (individual)
- borrower_name: Full legal name from title vesting (preferred) or 1003 or driver license.
- borrower_name_upper: Same, UPPERCASE.
- borrower_descriptor: Vesting descriptor. Examples: "a Single Man", "a Single Woman", "a Married Man", "a Married Woman, as her sole and separate property", "a North Carolina limited liability company", etc. If 1003 shows Married but title vests solely in one spouse, use "as [his/her] sole and separate property".
- borrower_street / borrower_city / borrower_state / borrower_zip: Borrower's HOME address (must differ from property). From 1003 Present Address → Doc Order → Driver License.
- borrower_mailing_address: "street, city, state zip"

Guarantor (for corporate/LLC templates only)
- guarantor_name: Individual guarantor's name if entity is borrower
- guarantor_name_upper: UPPERCASE
- guarantor_street / guarantor_city / guarantor_state / guarantor_zip: Guarantor home address
- guarantor_mailing_address: Full address

Property (subject collateral)
- property_street / property_city / property_state / property_zip: From ALTA Schedule A → appraisal → doc order. If title and appraisal disagree on zip, USE TITLE (it controls legal docs) and add to warnings.
- property_address: Full single-line.
- property_county: From title Schedule A Exhibit A ("County of X") or tax cert. No "County" suffix.
- property_apn: From title Parcel Number / Tax ID or appraisal. Format exactly as shown.

Title / Closing
- title_company: Underwriter on ALTA Schedule A.
- title_file_number: ALTA Commitment Number / File Number.
- title_effective_date: Commitment Date, formatted "Month D, YYYY".
- closing_agent_company: Issuing Agent / Settlement Agent.
- closing_agent_name: Settlement Officer / Closer.
- closing_agent_address: Settlement location.
- closing_agent_email: From Doc Order Form.
- trustee_name: For deed-of-trust states (NC/AZ/TX/NV/CA), usually the title company or specified trustee.

Loan terms (only if clearly in docs; admin enters these otherwise)
- loan_amount: "$X,XXX.XX" format. From ALTA Proposed Amount of Insurance or settlement statement.
- loan_amount_num: Plain number string like "145000".
- closing_date: "Month D, YYYY" from settlement statement if present.

Lender / Broker
- originating_broker: From Doc Order "BROKER INFORMATION" company/individual name. NOT Lender Funds itself.
- broker_license: If NMLS# or BRE# shown on doc order for originator, use it. Otherwise default to "02098388" (Lender Funds BRE).

OUTPUT FORMAT (JSON only, no fences):
{
  "fields": { "borrower_name": "...", ... },
  "warnings": [ "Zip mismatch: title=28312, appraisal=28303 — used title", ... ],
  "source_notes": { "borrower_name": "title commitment Schedule A", ... }
}

Rules:
- Unknown/uncertain → null (not empty string) and add a warning.
- Never invent rates, fees, or dates not shown.
- Borrower HOME address must differ from property. If they match, flag it.
- Only include fields present in the template's placeholder list above, plus universal ones (warnings, source_notes).`;
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST only' }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) }; }

  const docs = body.docs || [];
  const placeholders = Array.isArray(body.placeholders) ? body.placeholders : [];
  const stateHint = body.state || '';

  if (!Array.isArray(docs) || docs.length === 0) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'No docs provided' }) };
  }

  // Build content blocks
  const content = [];
  for (const d of docs) {
    if (!d.data || !d.mediaType) continue;
    if (d.mediaType === 'application/pdf') {
      content.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: d.data },
        title: d.name || 'document.pdf',
      });
    } else if (d.mediaType.startsWith('image/')) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: d.mediaType, data: d.data },
      });
    }
  }
  content.push({
    type: 'text',
    text: buildPrompt(placeholders, stateHint) +
      '\n\nAttached: ' + docs.map((d,i) => `${i+1}. ${d.name || 'unnamed'} (${d.mediaType})`).join('; '),
  });

  let apiResponse;
  try {
    const r = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, messages: [{ role: 'user', content }] }),
    });
    const text = await r.text();
    if (!r.ok) {
      return {
        statusCode: r.status, headers,
        body: JSON.stringify({ error: 'Anthropic API error', status: r.status, detail: text.slice(0, 1000) }),
      };
    }
    apiResponse = JSON.parse(text);
  } catch (e) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: 'Network/API error: ' + e.message }) };
  }

  const rawText = (apiResponse.content || [])
    .filter(b => b.type === 'text').map(b => b.text).join('\n').trim();

  const cleaned = rawText
    .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

  let parsed;
  try { parsed = JSON.parse(cleaned); }
  catch {
    return {
      statusCode: 502, headers,
      body: JSON.stringify({ error: 'Model returned non-JSON', raw: rawText.slice(0, 2000) }),
    };
  }

  // Default broker license if not set
  if (parsed.fields && !parsed.fields.broker_license) {
    parsed.fields.broker_license = '02098388';
  }

  return { statusCode: 200, headers, body: JSON.stringify(parsed) };
};
