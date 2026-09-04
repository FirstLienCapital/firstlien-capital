// ─────────────────────────────────────────────────────────────────────────────
// extract-ai-patch.js
// FirstLien.ai — Doc Prep Engine AI Extraction Patch
//
// This script REPLACES the regex-based exExtractFields function at runtime
// with an AI-powered version that calls the Netlify function proxy.
//
// Why a patch file?
//   - Surgical: changes only the one function that's broken
//   - Zero risk: doesn't touch the 209KB admin.html
//   - Deployable: commit this file + one <script> line in admin.html
//
// Install:
//   1. Save this file to your repo at:     /extract-ai-patch.js
//   2. In admin.html, find this line near the bottom:
//        </script>
//        </body>
//        </html>
//      Replace it with:
//        </script>
//        <script src="/extract-ai-patch.js"></script>
//        </body>
//        </html>
//   3. Commit and deploy to Netlify
//   4. Make sure ANTHROPIC_API_KEY is set in Netlify environment variables
//
// After install, the "Extract Data" button in Step 1 will call Claude via
// the Netlify function instead of using regex patterns.
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  // Wait for the main admin script to define exExtractFields, then override.
  // Runs on DOMContentLoaded so all functions are already defined.
  function install() {

    if (typeof window.exSourceFiles === 'undefined') {
      console.warn('[AI Patch] exSourceFiles not found — admin script may not be loaded. Retrying in 500ms...');
      setTimeout(install, 500);
      return;
    }

    // ── Save reference to the helpers the original function used ────────────
    var exSetProg   = window.exSetProg;
    var exAddStep   = window.exAddStep;
    var exStepDone  = window.exStepDone;
    var exFillFields= window.exFillFields;
    var exLog       = window.exLog || function (m) { console.log('[exLog]', m); };

    // ── AI-powered replacement for exExtractFields ──────────────────────────
    window.exExtractFields = async function () {
      exSetProg(35, 'Sending documents to AI extraction engine...');
      exAddStep('Reading documents...', 'running', 'extract');

      // Collect all readable text from uploaded files
      var parts = [];
      var fileCount = 0;
      window.exSourceFiles.forEach(function (f) {
        if (f.text && f.text.length > 10) {
          parts.push('=== FILE: ' + f.name + ' ===\n' + f.text);
          fileCount++;
          exLog('  • ' + f.name + ' (' + Math.round(f.text.length / 100) / 10 + 'K chars)');
        } else {
          exLog('  ⚠ ' + f.name + ' has no readable text — skipped');
        }
      });

      if (fileCount === 0) {
        exAddStep('❌ No readable text in uploaded files', 'err', 'extract');
        exLog('\n❌ No text could be extracted from the uploaded files.');
        exLog('   Try uploading .docx or .pdf files with real content.');
        return;
      }

      var allText = parts.join('\n\n');
      exLog('\nSending ' + fileCount + ' file(s) to Claude for field extraction...');
      exSetProg(45, 'AI analyzing documents...');

      // ── Call the Netlify function proxy ───────────────────────────────────
      var resp, data;
      try {
        resp = await fetch('/.netlify/functions/extract-fields', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: allText })
        });
      } catch (netErr) {
        exAddStep('❌ Network error calling extraction service', 'err', 'extract');
        exLog('\n❌ Could not reach /.netlify/functions/extract-fields');
        exLog('   Error: ' + netErr.message);
        exLog('   Check that the function is deployed and Netlify env var ANTHROPIC_API_KEY is set.');
        return;
      }

      if (!resp.ok) {
        var errBody = '';
        try { errBody = await resp.text(); } catch (e) {}
        exAddStep('❌ Extraction service returned ' + resp.status, 'err', 'extract');
        exLog('\n❌ Server returned ' + resp.status);
        exLog('   ' + errBody.substring(0, 300));
        if (resp.status === 500 && errBody.indexOf('ANTHROPIC_API_KEY') >= 0) {
          exLog('\n   → Set ANTHROPIC_API_KEY in Netlify:');
          exLog('     Site settings → Environment variables → Add variable');
        }
        return;
      }

      try {
        data = await resp.json();
      } catch (parseErr) {
        exAddStep('❌ Invalid JSON from extraction service', 'err', 'extract');
        exLog('\n❌ Could not parse extraction service response as JSON');
        return;
      }

      if (data.error) {
        exAddStep('❌ ' + data.error, 'err', 'extract');
        exLog('\n❌ ' + data.error);
        if (data.detail) exLog('   ' + data.detail.substring(0, 300));
        return;
      }

      var fields = data.fields || {};
      exSetProg(65, 'Processing extracted fields...');

      // ── Convert JSON fields → exExtracted format expected by exFillFields ─
      // Original format:  exExtracted[key] = { value, confidence, source }
      // AI gives us high confidence since it reasons about context rather than
      // matching text. But the user should still verify — so we use 'high'
      // across the board (same as original regex first-match behavior).
      var found = {};
      var keyCount = 0;
      Object.keys(fields).forEach(function (k) {
        var val = fields[k];
        if (val === null || val === undefined || val === '') return;
        // Normalize to string — all downstream code expects .value as string
        var strVal = String(val).trim();
        if (!strVal) return;
        found[k] = { value: strVal, confidence: 'high', source: 'ai' };
        keyCount++;
      });

      // Log what AI found
      exLog('\n✓ AI extracted ' + keyCount + ' field(s):');
      Object.keys(found).forEach(function (k) {
        var v = found[k].value;
        var preview = v.length > 60 ? v.substring(0, 60) + '...' : v;
        exLog('  ✓ ' + k + ': "' + preview + '"');
      });

      // Check for missing critical fields (same list the original used)
      var must = ['loan', 'rate', 'entity', 'gname', 'county', 'titleco',
                  'titleoff', 'titleem', 'gaddr', 'gcsz', 'fileno'];
      var missing = must.filter(function (f) { return !found[f]; });

      exAddStep(
        (missing.length ? '⚠ ' : '✓ ') + keyCount + ' fields found' +
        (missing.length ? ' · Missing: ' + missing.join(', ') : ' · All key fields found'),
        missing.length > 3 ? 'warn' : 'done',
        'extract'
      );

      // Log usage stats if present (helps monitor cost)
      if (data.usage) {
        var usage = data.usage;
        var inTok = usage.input_tokens || 0;
        var outTok = usage.output_tokens || 0;
        exLog('\n  📊 Tokens: ' + inTok.toLocaleString() + ' in, ' +
              outTok.toLocaleString() + ' out');
      }

      // Hand off to the existing fill + calc pipeline
      window.exExtracted = found;
      exStepDone('extract');
      exFillFields();
    };

    console.log('[AI Patch] exExtractFields replaced with AI-powered version ✓');

    // ── Small helper: show AI is active in the UI ────────────────────────────
    // Add a subtle badge near the Extract button so Christina can see at a
    // glance that the patch is live.
    var btn = document.getElementById('ex-extract-btn');
    if (btn && !document.getElementById('ai-patch-badge')) {
      var badge = document.createElement('span');
      badge.id = 'ai-patch-badge';
      badge.textContent = '🤖 AI';
      badge.title = 'AI extraction patch is active';
      badge.style.cssText =
        'display:inline-block;margin-left:8px;font-size:9px;padding:2px 7px;' +
        'background:rgba(13,152,130,0.15);color:#0d9882;' +
        'border:1px solid rgba(13,152,130,0.3);border-radius:3px;' +
        'text-transform:uppercase;letter-spacing:0.06em;vertical-align:middle;';
      // Place badge next to the button (after it in DOM)
      if (btn.parentNode) btn.parentNode.insertBefore(badge, btn.nextSibling);
    }
  }

  // Install after page loaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install);
  } else {
    install();
  }

})();
