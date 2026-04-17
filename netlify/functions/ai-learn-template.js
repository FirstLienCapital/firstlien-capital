// /netlify/functions/ai-learn-template.js
//
// Takes plain text from an uploaded loan document template and asks Claude
// to identify every deal-specific value that should be replaced when using
// this template for a new deal.
//
// This is the "smart" side of the auto-learn substitution engine. Regex
// patterns catch the obvious stuff (dollar amounts, dates, entity names in
// ALLCAPS). This function catches the rest — property descriptions, legal
// entity types, county names, addresses, license numbers, whatever the
// template happens to contain.
//
// Request body:  { text: "<plain text of template>", filename: "..." }
// Response:      JSON { values: [{ type, oldValue, category }], ... }
//
// Environment variable required: ANTHROPIC_API_KEY

exports.handler = async function(event, context) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' })
    };
  }

  let payload;
  try { payload = JSON.parse(event.body); }
  catch(e) { return { statusCode: 400, body: 'Invalid JSON' }; }

  const { text, filename } = payload;
  if (!text || text.length < 100) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [], note: 'Text too short to analyze' })
    };
  }

  // Sample the text — first 8000 chars, last 2000 chars, skip the middle
  // This keeps the prompt small while catching the signature pages at the
  // end which often contain different values (guarantor addresses, etc.)
  let sample = text;
  if (text.length > 12000) {
    sample = text.substring(0, 8000) + '\n\n[... middle omitted ...]\n\n' + text.substring(text.length - 2000);
  }

  const prompt =
`You are analyzing a loan document template to identify every deal-specific value that will need to be replaced when this template is used for a new borrower.

Below is the plain text of the template. Your job is to identify every specific value (names, addresses, amounts, dates, numbers) that is tied to a PARTICULAR past deal rather than being boilerplate legal language.

IMPORTANT:
- Boilerplate like "Borrower shall pay all fees" is NOT a deal-specific value
- Boilerplate like "This Agreement is governed by the laws of..." is NOT a deal-specific value
- Specific values like "JESONYA D. HARGROVE", "$299,000.00", "2947 Old Battleboro Road", "December 15, 2021", "3861-85-2765-00" ARE deal-specific
- Do NOT include values that refer to the lender/broker/servicer entity names (RUSHMYFILE, LENDER FUNDS, Superior Loan Servicing, Doc Service Pro) — those are handled separately
- Do NOT include standard legal citations (CERCLA, RCRA, statute numbers)
- Include ALL instances of the same value only once (dedupe)

Return ONLY a valid JSON object (no markdown fences, no prose) with this exact shape:
{
  "borrower_name": "<full legal name of borrower, exact spelling as in template>",
  "property_street": "<street address of subject property>",
  "property_csz": "<city, state, zip of subject property>",
  "county": "<county name without word 'County'>",
  "apn": "<APN or tax ID>",
  "file_no": "<broker file number or null>",
  "escrow_no": "<escrow / title order number or null>",
  "loan_amount_numeric": "<dollar amount like $299,000.00 or null>",
  "loan_amount_words": "<written-out amount like 'Two Hundred Ninety-Nine Thousand and 00/100 Dollars' or null>",
  "monthly_pmt_numeric": "<dollar amount or null>",
  "monthly_pmt_words": "<written amount or null>",
  "reserve_numeric": "<dollar amount or null>",
  "reserve_words": "<written amount or null>",
  "balloon_numeric": "<dollar amount or null>",
  "balloon_words": "<written amount or null>",
  "alta_numeric": "<dollar amount or null>",
  "alta_words": "<written amount or null>",
  "per_diem": "<dollar amount per day like $107.89 or null>",
  "interest_rate": "<percentage like 12.99% or null>",
  "interest_rate_words": "<written rate like 'Twelve and 99/100 Percent' or null>",
  "default_rate": "<percentage or null>",
  "doc_date": "<document date as 'Month D, YYYY' or null>",
  "maturity_date": "<maturity date or null>",
  "first_pmt_date": "<first borrower payment date or null>",
  "reserve_start_date": "<first reserve month or null>",
  "reserve_end_date": "<last reserve month or null>",
  "per_diem_thru_date": "<per diem through date or null>",
  "title_company": "<title company name or null>",
  "title_officer": "<closing officer/agent name or null>",
  "title_address": "<title company street address or null>",
  "title_csz": "<title company city/state/zip or null>",
  "title_email": "<title officer email or null>",
  "title_phone": "<title phone or null>",
  "title_underwriter": "<title insurance underwriter or null>",
  "orig_broker": "<originating broker name (if different from platform broker) or null>",
  "orig_fee": "<originating broker fee dollar amount or null>",
  "additional_values": [
    { "type": "descriptive label", "value": "exact text", "category": "parties|amounts|dates|property|other" }
  ]
}

Any field you cannot find in the template — use null. Do not invent values. For "additional_values", include anything deal-specific that doesn't fit the categories above (e.g. loan signing agent name, special endorsements, trustee name on deed of trust).

TEMPLATE TEXT:
${sample}`;

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2500,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return {
        statusCode: 502,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Claude API error: ' + resp.status, detail: errText })
      };
    }

    const data = await resp.json();
    const aiText = (data.content || []).map(b => b.text || '').join('');

    // Extract JSON — may or may not have markdown fences
    let jsonStr = aiText.trim();
    jsonStr = jsonStr.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
    const firstBrace = jsonStr.indexOf('{');
    const lastBrace = jsonStr.lastIndexOf('}');
    if (firstBrace < 0 || lastBrace < 0) {
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Could not parse AI response as JSON', raw: aiText })
      };
    }
    jsonStr = jsonStr.substring(firstBrace, lastBrace + 1);

    let parsed;
    try { parsed = JSON.parse(jsonStr); }
    catch(pe) {
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'JSON parse failed: ' + pe.message, raw: jsonStr.substring(0, 500) })
      };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(parsed)
    };

  } catch(err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message })
    };
  }
};
