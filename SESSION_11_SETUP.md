# FirstLien.Capital — Session 11 Deployment Guide

## What changed in Session 11

The extraction engine is now AI-powered. The old regex-based `exExtractFields` function has been replaced with a Claude API call that understands context, so it works regardless of the whitespace differences between Python and browser text extraction — which was the root cause of fields not populating.

---

## Files delivered

| File | Where it goes | Purpose |
|---|---|---|
| `extract-fields.js` | `netlify/functions/extract-fields.js` | Server-side proxy. Calls Claude with extraction prompt. Keeps API key secret. |
| `extract-ai-patch.js` | Root of repo (next to `admin.html`) | Browser-side patch that replaces the regex-based `exExtractFields` at runtime. |

Both files are complete, copy-paste-ready. No partial edits.

---

## Deployment — 5 steps

### Step 1 — Add both files to your GitHub repo

1. `extract-fields.js` → put in folder `netlify/functions/` (create the folder if it doesn't exist)
2. `extract-ai-patch.js` → put in the root of your repo (same folder as `admin.html`)

Commit both.

### Step 2 — Set the Anthropic API key on Netlify

The API key is the one private piece. It stays on Netlify's server, never in the browser.

1. Go to Netlify → your site → **Site settings** → **Environment variables**
2. Click **Add a variable** (or "Add a single variable")
3. Key: `ANTHROPIC_API_KEY`
4. Value: your Anthropic API key (starts with `sk-ant-...`)
5. Save

If you don't have an Anthropic API key yet, get one at: https://console.anthropic.com/settings/keys

### Step 3 — Add one line to admin.html

Find this near the bottom of `admin.html`:

```
</script>
</body>
</html>
```

Change it to:

```
</script>
<script src="/extract-ai-patch.js"></script>
</body>
</html>
```

That's the ONLY change to admin.html. One line added, nothing removed.

### Step 4 — Commit and push

Netlify will redeploy automatically. Takes about a minute.

### Step 5 — Test

1. Open `https://jazzy-pothos-7e7899.netlify.app/admin.html`
2. Log in
3. Go to Doc Prep Engine tab
4. Look near the "Extract Data" button — you should see a small teal **🤖 AI** badge. That confirms the patch loaded.
5. Upload the 3 deal 49821 docs (Loan Approval, Doc Order Form, NM Loan Docs v2)
6. Click **Extract Data**
7. The log should show "Sending 3 file(s) to Claude for field extraction..."
8. After a few seconds, fields should populate in Step 2

---

## How it works

```
 Browser (admin.html)                Netlify Function            Claude API
 ──────────────────────              ────────────────            ──────────

 User clicks Extract
         │
         ▼
 exExtractFields()  ─── POST ───▶   extract-fields.js  ─── + API key ───▶  claude-sonnet-4
 (the AI-patched                    reads ANTHROPIC_API_KEY                 returns JSON
  version)                          from env, forwards to Claude            with 28 fields
         │                                  │                                    │
         │                                  ◀─────────── JSON ──────────────────┘
         ◀────────── { fields: {...} } ─────┘
         │
         ▼
 exFillFields()
 populates form
```

---

## What the AI extracts

Same 28 fields the regex tried to handle, plus the AI can infer fields from context that regex can't. Fields returned as JSON:

- **Loan terms:** `loan`, `rate`, `amortPeriod`, `loanTerm`, `monthly`, `balloon`, `reserve`, `perDiem`
- **Dates:** `pdThru`, `firstPmt`, `maturityDate`, `docDate`
- **Identifiers:** `fileno`, `escrow`
- **Broker/Fees:** `origbroker`, `origpct`, `origfee`
- **Entity:** `entity`, `etype`
- **Guarantor:** `gname`, `gaddr`, `gcsz`
- **Property:** `propaddr`, `propcsz`, `propcommon`, `county`, `state`, `apn`
- **Title/Servicing:** `titleco`, `titleoff`, `titleem`, `titleaddr`, `titleund`, `servicer`

The AI is given priority rules (escrow instructions beat loan quotes for conflicts) and is told to return `null` rather than guess — so missing fields stay missing instead of being invented.

---

## Cost

Each extraction is one call to `claude-sonnet-4-20250514`. A typical 3-doc batch uses roughly:
- Input: ~15–25K tokens (the extracted text)
- Output: ~800–1500 tokens (the JSON)

At current Sonnet pricing (check https://www.anthropic.com/pricing for current rates) this is a few cents per extraction. The Netlify function logs token usage to the browser console, so you can monitor actual cost over time.

---

## Troubleshooting

### The AI badge doesn't appear

- Hard-refresh (Ctrl+Shift+R or Cmd+Shift+R) to bypass cache
- Check the browser console for any 404 on `/extract-ai-patch.js`
- Confirm the `<script src="/extract-ai-patch.js">` line is actually in admin.html and deployed

### "ANTHROPIC_API_KEY not configured on server"

- You missed Step 2. Set the env var in Netlify site settings.
- After adding the var, trigger a new deploy (Netlify → Deploys → Trigger deploy → Deploy site)

### "Network error calling extraction service"

- The function isn't deployed yet. Check Netlify deploy logs.
- Confirm the file is at `netlify/functions/extract-fields.js` (exact folder name)

### Some fields extract, some don't

- The AI returns `null` for fields it genuinely can't find. Check the browser log — it lists which fields came back.
- If a field should be in the docs but isn't being found, it may mean that doc wasn't uploaded, or the OCR quality is poor. Try re-uploading a cleaner PDF or the .docx original.

### The wrong deal's data is extracted

- The prompt already handles multi-deal contamination by preferring the deal with the most docs. But if you upload mostly wrong-deal docs, you'll get wrong-deal data. Best practice: upload only the target deal's files.

---

## What stays unchanged

- Everything else in admin.html
- The DOCX text extractor (already uses paragraph-split approach — was a secondary issue, the AI fix sidesteps it entirely by not caring about whitespace)
- `dpCalc`, `dpRun`, `dpAIFinalReview`, all generation logic
- Re-extract buttons, doc prep fee ($1,595), date formulas, RULES engine

The patch is additive. If you ever need to roll back, just remove the `<script src="/extract-ai-patch.js">` line from admin.html — the original regex function is still there underneath.

---

## Next session priorities (unchanged from Session 10 handoff)

1. ✅ **Fix extraction engine** — DONE (this session)
2. Wire generate-docs.js Netlify function for real .docx output
3. Firebase Storage for ZIP download links
4. NV, NY, MI state template sets (CA last — 24 docs)
5. Gemini AI scoring integration
6. AVM auto-population on borrower form
7. Port remaining modules from firstlien-homepage-v45.html
