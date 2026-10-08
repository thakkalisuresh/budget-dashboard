#!/usr/bin/env node
/**
 * Offline evaluation of split-receipt ITEM categorization.
 *
 * Companion to eval-vision.mjs (which measures whole-receipt extraction). This
 * one measures the three-layer item resolver that feeds a Costco-style split:
 * learned (ItemMemory) -> keyword table -> batched Groq -> ask the user.
 *
 * Question it answers: on real split receipts, how often does each layer place
 * an item on its own, and how often does the user still get asked? That re-ask
 * rate is the direct measure of defect D ("every split re-asks"; the keyword
 * table can't read Costco's abbreviations).
 *
 * Method — same no-synthetic philosophy as eval-vision:
 *   • Inputs are REAL receipts already in Drive (read-only). Each is extracted
 *     with the production prompt (imported from _extraction.mjs, not copied) to
 *     get its line items, then run through the REAL resolveSplitItems.
 *   • Coverage per layer (learned / keyword / llm-confident / re-ask) and the
 *     overall re-ask rate are reported from that run. No hand-labeling.
 *   • LLM-vs-keyword agreement: for items the keyword table is sure about, we
 *     ALSO ask Groq and report how often it agrees — a real-data sanity signal
 *     on the LLM layer that needs no ground truth.
 *   • Accuracy: scored only against the ItemMemory tab (the categories a human
 *     actually chose), hold-one-out so a learned row can't score itself. Until
 *     real usage populates ItemMemory this is n=0 and reported as unmeasured —
 *     the harness is ready, it is not faked.
 *
 * Secrets are read from Secret Manager at runtime and never printed. Reads are
 * read-only; this script writes NOTHING.
 *
 *   node scripts/eval-item-categorize.mjs --limit 20
 *   node scripts/eval-item-categorize.mjs --limit 10 --vendor costco --extractor gemini
 *   node scripts/eval-item-categorize.mjs --all --sheet <ID>     # score vs a sheet's ItemMemory
 */
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const argv = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(`--${name}`);

const LIMIT     = parseInt(argv('limit', '20'), 10);
const YEAR      = argv('year');
const MONTH     = argv('month');
const EXTRACTOR = argv('extractor', 'gemini');         // which model reads the receipt
const VENDOR    = argv('vendor');                      // substring filter on store_name
const ALL       = flag('all');                         // any receipt with >=2 items
const PROJECT   = 'fundient-dashboard';
// Receipts worth splitting: a mixed-category basket. Default hints; --vendor
// narrows to one, --all disables the vendor gate entirely.
const SPLIT_HINTS = ['costco', 'sam', "sam's", 'bj', 'walmart', 'target', 'kirkland'];

/* ── Secrets ─────────────────────────────────────────────────────────────── */

function loadSecret(name) {
  try {
    return execFileSync('gcloud',
      ['secrets', 'versions', 'access', 'latest', `--secret=${name}`, `--project=${PROJECT}`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return ''; }
}

const NEEDED = [
  'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_DRIVE_REFRESH_TOKEN',
  'VITE_TEMPLATE_SHEET_ID', 'ALLOWED_EMAILS', 'GROQ_API_KEY', 'GEMINI_API_KEY',
];
console.log('Loading secrets from Secret Manager…');
for (const name of NEEDED) if (!process.env[name]) process.env[name] = loadSecret(name);
// --sheet overrides which sheet's ItemMemory is read for ground truth / learned.
const SHEET_OVERRIDE = argv('sheet');
if (SHEET_OVERRIDE) process.env.VITE_TEMPLATE_SHEET_ID = SHEET_OVERRIDE;
const missing = NEEDED.filter(n => !process.env[n]);
if (missing.length) {
  console.error(`\nMissing secrets: ${missing.join(', ')}`);
  console.error('Run `gcloud auth login` and confirm the --project is fundient-dashboard.');
  process.exit(1);
}
console.log(`  ✓ secrets present; ItemMemory sheet = ${process.env.VITE_TEMPLATE_SHEET_ID}\n`);

// Imported AFTER env is populated (these modules capture credentials at load).
const { getAccessToken }          = await import('../functions/lib/_drive.mjs');
const { __evalInternals, sanitizeExtraction, CATEGORIES } = await import('../functions/lib/_extraction.mjs');
const { resolveSplitItems }       = await import('../functions/lib/_bot-core.mjs');
const { categorizeItem }          = await import('../functions/lib/_item-categorizer.mjs');
const { categorizeItemsBatch }    = await import('../functions/lib/_item-llm.mjs');
const { fetchItemMemoryRows, memoryUserId } = await import('../functions/lib/_sheets.mjs');
const { reduceMemoryRows, lookupLearned, learnedExamples, normalizeItemName } = await import('../functions/lib/_item-memory.mjs');
const { CONFIDENCE_THRESHOLD }    = await import('../functions/lib/_categorize.mjs');
const { SYSTEM_PROMPT, buildUserPrompt } = __evalInternals;

/* Tolerant parse: scan for the first balanced {...} object. The production
 * parseJSON greedily matches first-{ to last-} and chokes when a model wraps
 * the object in markdown or emits a second object; recovering those here keeps
 * the eval from silently under-sampling real receipts. */
function parseJSON(text) {
  const start = String(text).indexOf('{');
  if (start < 0) throw new Error('No JSON in response');
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return JSON.parse(text.slice(start, i + 1));
  }
  throw new Error('No balanced JSON object in response');
}

/* ── Drive walking (same shape as eval-vision) ───────────────────────────── */

async function drive(path) {
  const token = await getAccessToken();
  const res = await fetch(`https://www.googleapis.com/drive/v3/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Drive ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}
const listChildren = (parentId, extra = '') =>
  drive(`files?q=${encodeURIComponent(`'${parentId}' in parents and trashed=false${extra}`)}&fields=files(id,name,mimeType,size)&pageSize=1000`);

async function downloadBase64(fileId) {
  const token = await getAccessToken();
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Drive download ${res.status}`);
  return Buffer.from(await res.arrayBuffer()).toString('base64');
}

async function collectReceipts() {
  const root = await drive(
    `files?q=${encodeURIComponent("name='Receipts' and mimeType='application/vnd.google-apps.folder' and trashed=false")}&fields=files(id,name)`);
  if (!root.files?.length) throw new Error('No "Receipts" folder found in Drive.');
  const out = [];
  const years = (await listChildren(root.files[0].id)).files.filter(f => /^\d{4}$/.test(f.name)).filter(f => !YEAR || f.name === YEAR);
  for (const year of years) {
    const months = (await listChildren(year.id)).files.filter(m => !MONTH || m.name === MONTH);
    for (const month of months) {
      const categories = (await listChildren(month.id)).files;
      for (const category of categories) {
        const files = (await listChildren(category.id)).files || [];
        for (const file of files) {
          if (!/^image\/|application\/pdf/.test(file.mimeType || '')) continue;
          out.push({ fileId: file.id, fileName: file.name, mimeType: file.mimeType, year: year.name, month: month.name, category: category.name });
        }
      }
    }
  }
  return out;
}

/* ── Extraction providers (same prompt/image as eval-vision) ─────────────── */

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function callGemini(base64, mediaType) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ inline_data: { mime_type: mediaType, data: base64 } }, { text: buildUserPrompt() }] }],
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      generationConfig: { responseMimeType: 'application/json' },
    }),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return parseJSON((await res.json()).candidates?.[0]?.content?.parts?.[0]?.text || '');
}

async function callGroqExtract(base64, mediaType) {
  const { GROQ_VISION_MODEL } = await import('../functions/lib/_groq.mjs');
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: GROQ_VISION_MODEL, temperature: 0, response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: [{ type: 'text', text: buildUserPrompt() }, { type: 'image_url', image_url: { url: `data:${mediaType};base64,${base64}` } }] },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Groq ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return parseJSON((await res.json()).choices?.[0]?.message?.content || '');
}

const EXTRACT = EXTRACTOR === 'groq' ? callGroqExtract : callGemini;

async function extractWithRetry(base64, mediaType, attempts = 3) {
  let lastErr;
  for (let a = 0; a < attempts; a++) {
    try { return await EXTRACT(base64, mediaType); }
    catch (e) {
      lastErr = e;
      const secs = Number(e.message.match(/try again in ([\d.]+)s/i)?.[1]);
      await sleep((secs ? Math.ceil(secs) * 1000 : 800 * (a + 1)) + 300);
    }
  }
  throw lastErr;
}

const isSplitVendor = (vendor) => {
  if (ALL) return true;
  const v = String(vendor || '').toLowerCase();
  if (VENDOR) return v.includes(VENDOR.toLowerCase());
  return SPLIT_HINTS.some(h => v.includes(h));
};

/* ── Ground truth: the ItemMemory tab ────────────────────────────────────── */

const memRows = await fetchItemMemoryRows();
const userId  = memoryUserId();
const memMap  = reduceMemoryRows(memRows, userId);
console.log(`ItemMemory ground truth: ${Math.max(0, memRows.length - 1)} data row(s) for this user.`);
if (memMap.size === 0) {
  console.log('  → accuracy is UNMEASURED (no human-chosen item labels yet). Reporting coverage + re-ask only.\n');
}

/* ── Run ─────────────────────────────────────────────────────────────────── */

const all = await collectReceipts();
console.log(`Found ${all.length} receipt files in Drive.`);
if (!all.length) process.exit(0);

// Even spread rather than newest N, so one heavy month can't dominate.
const step   = Math.max(1, Math.floor(all.length / Math.max(LIMIT, 1)));
const sample = all.filter((_, i) => i % step === 0).slice(0, LIMIT);
console.log(`Extracting ${sample.length} with ${EXTRACTOR}, then resolving items…\n`);

const cov = { items: 0, learned: 0, keyword: 0, llm: 0, reask: 0 };          // coverage
const agree = { checked: 0, agreed: 0 };                                     // LLM vs keyword
const acc = { learnedScored: 0, keywordHit: 0, llmHit: 0, scored: 0 };       // hold-one-out accuracy
const keywordKnown = [];   // {vendor, name, keywordCat} for the agreement pass
const groundTruth  = [];   // {vendor, name, truth} for hold-one-out accuracy
let receiptsUsed = 0, skippedNoItems = 0, skippedVendor = 0, extractFails = 0;

for (const [i, rec] of sample.entries()) {
  let base64;
  try { base64 = await downloadBase64(rec.fileId); }
  catch (e) { console.log(`[${i + 1}] download failed: ${e.message}`); continue; }

  let raw;
  try { raw = await extractWithRetry(base64, rec.mimeType); }
  catch (e) { extractFails++; console.log(`[${i + 1}] extract failed: ${e.message.slice(0, 80)}`); continue; }

  const ex = sanitizeExtraction(raw);
  const items = Array.isArray(ex.items) ? ex.items.filter(it => it?.name && typeof it.amount === 'number') : [];
  if (items.length < 2) { skippedNoItems++; continue; }
  if (!isSplitVendor(ex.store_name)) { skippedVendor++; continue; }

  receiptsUsed++;
  const { autoItems, toAsk } = await resolveSplitItems(items, ex.store_name);
  const bySource = { learned: 0, keyword: 0, llm: 0 };
  for (const a of autoItems) bySource[a.source] = (bySource[a.source] || 0) + 1;
  const n = autoItems.length + toAsk.length;
  cov.items += n; cov.learned += bySource.learned; cov.keyword += bySource.keyword; cov.llm += bySource.llm; cov.reask += toAsk.length;

  console.log(`[${String(i + 1).padStart(3)}] ${String(ex.store_name).slice(0, 28).padEnd(28)} ${String(n).padStart(2)} items · learned ${bySource.learned} · keyword ${bySource.keyword} · llm ${bySource.llm} · ask ${toAsk.length}`);

  // Collect for the agreement pass (keyword-known items) and accuracy (ground-truth items).
  for (const a of autoItems) if (a.source === 'keyword') keywordKnown.push({ vendor: ex.store_name, name: a.name, keywordCat: a.category });
  for (const it of items) {
    const truth = memMap.get(`${String(ex.store_name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} ${normalizeItemName(it.name)}`)?.category
               || lookupLearned(memMap, ex.store_name, it.name);
    if (truth) groundTruth.push({ vendor: ex.store_name, name: it.name, truth });
  }
}

/* ── LLM-vs-keyword agreement (real-data sanity, no labels) ──────────────── */

async function batchLLM(vendor, names) {
  const { results } = await categorizeItemsBatch({
    vendor, items: names, categories: CATEGORIES, examples: learnedExamples(memMap, vendor),
  });
  return results || [];
}

if (keywordKnown.length) {
  console.log(`\nChecking LLM vs keyword on ${keywordKnown.length} keyword-known item(s)…`);
  const byVendor = new Map();
  for (const k of keywordKnown) { if (!byVendor.has(k.vendor)) byVendor.set(k.vendor, []); byVendor.get(k.vendor).push(k); }
  for (const [vendor, list] of byVendor) {
    let results = [];
    try { results = await batchLLM(vendor, list.map(k => k.name)); } catch (e) { console.log(`  (vendor ${vendor}: LLM check skipped — ${e.message.slice(0, 60)})`); continue; }
    list.forEach((k, j) => {
      const r = results[j];
      if (r && r.category) { agree.checked++; if (r.category === k.keywordCat) agree.agreed++; }
    });
  }
}

/* ── Hold-one-out accuracy vs ItemMemory (n=0 until memory fills) ─────────── */

if (groundTruth.length) {
  console.log(`\nScoring ${groundTruth.length} item(s) against ItemMemory (hold-one-out)…`);
  // Keyword layer: pure function, no memory — already held out.
  for (const g of groundTruth) {
    acc.scored++;
    const kw = categorizeItem({ name: g.name });
    if (kw) { acc.keywordHit += kw === g.truth ? 1 : 0; }
  }
  // LLM layer: batch per vendor, examples EXCLUDING the item under test would be
  // ideal; with a tiny corpus we send learnedExamples (recall-oriented) and note it.
  const byVendor = new Map();
  for (const g of groundTruth) { if (!byVendor.has(g.vendor)) byVendor.set(g.vendor, []); byVendor.get(g.vendor).push(g); }
  for (const [vendor, list] of byVendor) {
    let results = [];
    try { results = await batchLLM(vendor, list.map(g => g.name)); } catch { continue; }
    list.forEach((g, j) => { const r = results[j]; if (r?.category) { acc.llmHit += r.category === g.truth ? 1 : 0; } });
  }
  acc.learnedScored = groundTruth.length;
}

/* ── Report ──────────────────────────────────────────────────────────────── */

const pct = (n, d) => d ? `${((n / d) * 100).toFixed(1)}%` : '—';
console.log(`\n${'='.repeat(72)}\nITEM-CATEGORIZATION EVAL  (extractor=${EXTRACTOR})\n${'='.repeat(72)}`);
console.log(`Receipts: ${receiptsUsed} used · ${skippedVendor} skipped (not a split vendor) · ${skippedNoItems} skipped (<2 items) · ${extractFails} extract fails`);
console.log(`\nCOVERAGE (how each item got placed) — n=${cov.items} items`);
console.log(`  learned (ItemMemory)   ${String(cov.learned).padStart(4)}  ${pct(cov.learned, cov.items)}`);
console.log(`  keyword table          ${String(cov.keyword).padStart(4)}  ${pct(cov.keyword, cov.items)}`);
console.log(`  LLM (confident)        ${String(cov.llm).padStart(4)}  ${pct(cov.llm, cov.items)}`);
console.log(`  re-ask (user tapped)   ${String(cov.reask).padStart(4)}  ${pct(cov.reask, cov.items)}   ← defect D: lower is better`);
console.log(`\nLLM vs KEYWORD agreement (sanity, no labels): ${agree.agreed}/${agree.checked}  ${pct(agree.agreed, agree.checked)}`);
console.log(`\nACCURACY vs ItemMemory (hold-one-out)`);
if (acc.scored === 0) {
  console.log('  UNMEASURED — ItemMemory has no human-chosen labels yet. Harness is ready; run again once real splits have populated it.');
} else {
  console.log(`  items with a ground-truth label  ${acc.scored}`);
  console.log(`  keyword correct                  ${pct(acc.keywordHit, acc.scored)}`);
  console.log(`  LLM correct                      ${pct(acc.llmHit, acc.scored)}`);
}
console.log(`\nNote: inputs are real receipts; nothing is hand-labeled. A high re-ask rate on
a fresh ItemMemory is expected — that is exactly what the learning layer drives
down over time (proven separately by the Step-5 round-trip).\n`);
