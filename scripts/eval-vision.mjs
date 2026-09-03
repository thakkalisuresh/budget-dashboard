#!/usr/bin/env node
/**
 * Offline provider comparison for receipt extraction.
 *
 * Question it answers: if Groq became the PRIMARY vision model and Gemini the
 * last-resort fallback, would the rows still come out right?
 *
 * Method — no synthetic data, no hand-labelling:
 *   • Receipts already in Drive are the inputs. They are filed as
 *     Receipts/<year>/<month>/<category>/, so the folder gives the category the
 *     user actually chose.
 *   • The month's History tab is the ground truth: the vendor, amount and date
 *     that were really logged.
 *   • Scoring reuses isSameTransaction from _duplicate-match.mjs — the same
 *     5¢ / fuzzy-vendor / ±3-day rule the bot already trusts to decide whether
 *     two records are the same purchase. Reusing it means "correct" here means
 *     the same thing it means in production.
 *   • Both providers run against the SAME images with the SAME prompt
 *     (imported from _extraction.mjs, not copied), so the only variable is the
 *     model.
 *
 * Secrets are read from Firebase at runtime and never printed.
 *
 *   node scripts/eval-vision.mjs --limit 25
 *   node scripts/eval-vision.mjs --limit 10 --year 2026 --month July
 *   node scripts/eval-vision.mjs --limit 25 --providers groq
 */
import { execFileSync } from 'node:child_process';
// _drive.mjs and _sheets.mjs read their credentials at MODULE LOAD time, so both
// are imported dynamically further down — after the secrets are in process.env.
// _duplicate-match.mjs has no config and is safe to import here.
import { isSameTransaction, fuzzyNamesMatch } from '../functions/lib/_duplicate-match.mjs';

const args = process.argv.slice(2);
const argv = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const LIMIT     = parseInt(argv('limit', '20'), 10);
const YEAR      = argv('year');
const MONTH     = argv('month');
const PROVIDERS = (argv('providers', 'groq,gemini')).split(',').map(s => s.trim());
const GROQ_VISION_MODEL = argv('groq-model', 'qwen/qwen3.6-27b');

/* ── Secrets ─────────────────────────────────────────────────────────────── */

function loadSecret(name) {
  try {
    return execFileSync('firebase', ['functions:secrets:access', name], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

const NEEDED = [
  'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_DRIVE_REFRESH_TOKEN',
  'VITE_TEMPLATE_SHEET_ID', 'ALLOWED_EMAILS', 'GROQ_API_KEY', 'GEMINI_API_KEY',
];

console.log('Loading secrets from Firebase…');
for (const name of NEEDED) {
  if (!process.env[name]) process.env[name] = loadSecret(name);
}
const missing = NEEDED.filter(n => !process.env[n]);
if (missing.length) {
  console.error(`\nMissing secrets: ${missing.join(', ')}`);
  console.error('Run `firebase login` and check you are on the fundient-dashboard project.');
  process.exit(1);
}
console.log('  ✓ all secrets present\n');

// Imported AFTER the env is populated: these modules capture their credentials
// in module-scope consts, so a static import at the top of the file reads them
// before the secrets land and every Drive call fails "not configured".
const { getAccessToken } = await import('../functions/lib/_drive.mjs');
const { __evalInternals, sanitizeExtraction } = await import('../functions/lib/_extraction.mjs');
const { getCurrentMonthSheetId, getRecentExpenses } = await import('../functions/lib/_sheets.mjs');
const { SYSTEM_PROMPT, buildUserPrompt, parseJSON } = __evalInternals;

/* ── Drive walking ───────────────────────────────────────────────────────── */

async function drive(path) {
  const token = await getAccessToken();
  const res = await fetch(`https://www.googleapis.com/drive/v3/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Drive ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const listChildren = (parentId, extra = '') =>
  drive(`files?q=${encodeURIComponent(`'${parentId}' in parents and trashed=false${extra}`)}` +
        `&fields=files(id,name,mimeType,size)&pageSize=1000`);

async function downloadBase64(fileId) {
  const token = await getAccessToken();
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Drive download ${res.status}`);
  return Buffer.from(await res.arrayBuffer()).toString('base64');
}

/** Receipts/<year>/<month>/<category>/<file> → one record per image. */
async function collectReceipts() {
  const root = await drive(
    `files?q=${encodeURIComponent("name='Receipts' and mimeType='application/vnd.google-apps.folder' and trashed=false")}` +
    `&fields=files(id,name)`
  );
  if (!root.files?.length) throw new Error('No "Receipts" folder found in Drive.');

  const out = [];
  const years = (await listChildren(root.files[0].id)).files
    .filter(f => /^\d{4}$/.test(f.name))
    .filter(f => !YEAR || f.name === YEAR);

  for (const year of years) {
    const months = (await listChildren(year.id)).files.filter(m => !MONTH || m.name === MONTH);
    for (const month of months) {
      const categories = (await listChildren(month.id)).files;
      for (const category of categories) {
        const files = (await listChildren(category.id)).files || [];
        for (const file of files) {
          if (!/^image\/|application\/pdf/.test(file.mimeType || '')) continue;
          out.push({
            fileId: file.id, fileName: file.name, mimeType: file.mimeType,
            year: year.name, month: month.name, category: category.name,
          });
        }
      }
    }
  }
  return out;
}

/* ── Providers (same prompt, same image) ─────────────────────────────────── */

async function callGroqVision(base64, mediaType) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: GROQ_VISION_MODEL,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: [
          { type: 'text', text: buildUserPrompt() },
          { type: 'image_url', image_url: { url: `data:${mediaType};base64,${base64}` } },
        ] },
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Groq ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  return parseJSON(data.choices?.[0]?.message?.content || '');
}

async function callGeminiVision(base64, mediaType) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [
        { inline_data: { mime_type: mediaType, data: base64 } },
        { text: buildUserPrompt() },
      ] }],
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      generationConfig: { responseMimeType: 'application/json' },
    }),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return parseJSON(data.candidates?.[0]?.content?.parts?.[0]?.text || '');
}

const PROVIDER_FNS = { groq: callGroqVision, gemini: callGeminiVision };

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Production retries each model up to MAX_RETRIES and then falls back to another
 * model entirely, so transient truncation and rate limits are invisible there.
 * An eval without the same retries measures flakiness, not model quality — so it
 * mirrors the retry behaviour and reports how many attempts it needed.
 */
async function callWithRetry(provider, base64, mediaType, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return { raw: await PROVIDER_FNS[provider](base64, mediaType), attempt };
    } catch (e) {
      lastError = e;
      const rateLimited = /\b429\b/.test(e.message);
      if (rateLimited) {
        // Groq puts the wait in the message; back off long enough to respect it.
        const secs = Number(e.message.match(/try again in ([\d.]+)s/i)?.[1]) || 20;
        console.log(`         ${provider.padEnd(7)} · rate limited, waiting ${Math.ceil(secs)}s`);
        await sleep(Math.ceil(secs) * 1000 + 500);
      } else {
        await sleep(800 * (attempt + 1));
      }
    }
  }
  throw lastError;
}

/* ── Ground truth ────────────────────────────────────────────────────────── */

const truthCache = new Map();
async function truthRowsFor(monthName) {
  if (truthCache.has(monthName)) return truthCache.get(monthName);
  let rows = [];
  try {
    const sheetId = await getCurrentMonthSheetId(monthName);
    rows = (await getRecentExpenses(sheetId, 500)).map(r => ({
      vendor: r.vendor, amount: r.amount, date: r.txDate || r.timestamp, category: r.category,
    }));
  } catch (e) {
    console.warn(`  (no sheet for ${monthName}: ${e.message})`);
  }
  truthCache.set(monthName, rows);
  return rows;
}

/**
 * Did this extraction reproduce a row that really exists?
 * isSameTransaction is the bot's own definition of "same purchase".
 */
function score(extraction, rows, folderCategory) {
  const candidate = {
    vendor: extraction?.store_name,
    amount: extraction?.total_amount,
    date: extraction?.purchase_date,
  };
  if (!candidate.vendor || !(candidate.amount > 0)) {
    return { matched: false, reason: 'no usable vendor/amount' };
  }
  // A split receipt is logged as SEVERAL rows — one Costco trip becomes
  // $12.99 Misc + $25.94 Thakkali + $63.61 Grocery. The model correctly reads
  // the receipt TOTAL ($102.54), which equals no single row. Comparing only
  // against individual rows scores a perfect extraction as a miss, so rows are
  // also summed per vendor+date and the totals compared too.
  const grouped = new Map();
  for (const r of rows) {
    const key = `${String(r.vendor).toLowerCase().trim()}|${r.date}`;
    const g = grouped.get(key) || { vendor: r.vendor, date: r.date, amount: 0, category: r.category, parts: 0 };
    g.amount = Math.round((g.amount + Number(r.amount || 0)) * 100) / 100;
    g.parts++;
    grouped.set(key, g);
  }
  const splitTotals = [...grouped.values()].filter(g => g.parts > 1);

  const hit = rows.find(r => isSameTransaction(r, candidate))
           || splitTotals.find(g => isSameTransaction(g, candidate));
  if (hit) {
    return {
      matched: true,
      amountExact: Math.abs(Number(hit.amount) - Number(candidate.amount)) < 0.005,
      vendorExact: String(hit.vendor).toLowerCase().trim() === String(candidate.vendor).toLowerCase().trim(),
      categoryAgrees: (extraction.reward_category || '') === folderCategory,
      truth: hit,
    };
  }
  // Not a full match — say which part missed, which is the useful signal.
  const amountOnly = rows.find(r => Math.abs(Number(r.amount) - Number(candidate.amount)) < 0.05);
  const vendorOnly = rows.find(r => fuzzyNamesMatch(r.vendor, candidate.vendor));
  return {
    matched: false,
    reason: amountOnly ? 'amount right, vendor/date off'
          : vendorOnly ? 'vendor right, amount off'
          : 'no corresponding row',
    nearest: amountOnly || vendorOnly || null,
  };
}

/* ── Run ─────────────────────────────────────────────────────────────────── */

const all = await collectReceipts();
console.log(`Found ${all.length} receipt files in Drive.`);
if (!all.length) process.exit(0);

// Even spread rather than the newest N, so one heavy month cannot dominate.
const step    = Math.max(1, Math.floor(all.length / LIMIT));
const sample  = all.filter((_, i) => i % step === 0).slice(0, LIMIT);
console.log(`Evaluating ${sample.length} of them against ${PROVIDERS.join(' + ')}\n`);

const stats = Object.fromEntries(PROVIDERS.map(p => [p, {
  ok: 0, matched: 0, amountExact: 0, vendorExact: 0, categoryAgrees: 0,
  failed: 0, retried: 0, ms: 0, reasons: {},
}]));
const disagreements = [];

for (const [i, rec] of sample.entries()) {
  const label = `${rec.year}/${rec.month}/${rec.category}/${rec.fileName}`;
  process.stdout.write(`[${String(i + 1).padStart(3)}/${sample.length}] ${label.slice(0, 70)}\n`);

  let base64;
  try {
    base64 = await downloadBase64(rec.fileId);
  } catch (e) {
    console.log(`         download failed: ${e.message}`);
    continue;
  }

  const rows = await truthRowsFor(`${rec.month} ${rec.year}`);
  const perProvider = {};

  for (const provider of PROVIDERS) {
    const s = stats[provider];
    const started = Date.now();
    try {
      const { raw, attempt } = await callWithRetry(provider, base64, rec.mimeType);
      const extraction = sanitizeExtraction(raw);
      s.ms += Date.now() - started;
      s.ok++;
      if (attempt > 0) s.retried++;

      const result = score(extraction, rows, rec.category);
      perProvider[provider] = { extraction, result };
      if (result.matched) {
        s.matched++;
        if (result.amountExact) s.amountExact++;
        if (result.vendorExact) s.vendorExact++;
        if (result.categoryAgrees) s.categoryAgrees++;
        console.log(`         ${provider.padEnd(7)} ✓ ${extraction.store_name} $${extraction.total_amount}`);
      } else {
        s.reasons[result.reason] = (s.reasons[result.reason] || 0) + 1;
        console.log(`         ${provider.padEnd(7)} ✗ ${extraction.store_name || '?'} $${extraction.total_amount ?? '?'} — ${result.reason}`);
      }
    } catch (e) {
      s.ms += Date.now() - started;
      s.failed++;
      perProvider[provider] = { error: e.message };
      console.log(`         ${provider.padEnd(7)} ! ${e.message.slice(0, 90)}`);
    }
  }

  // The cases worth a human eye: the providers disagree about reality.
  if (PROVIDERS.length > 1) {
    const [a, b] = PROVIDERS;
    const am = perProvider[a]?.result?.matched, bm = perProvider[b]?.result?.matched;
    if (am !== bm) disagreements.push({ label, [a]: perProvider[a], [b]: perProvider[b] });
  }
}

/* ── Report ──────────────────────────────────────────────────────────────── */

const pct = (n, d) => d ? `${((n / d) * 100).toFixed(1)}%` : '—';

console.log(`\n${'='.repeat(72)}\nRESULTS  (n=${sample.length})\n${'='.repeat(72)}`);
for (const provider of PROVIDERS) {
  const s = stats[provider];
  const attempted = s.ok + s.failed;
  console.log(`\n${provider.toUpperCase()}  [${provider === 'groq' ? GROQ_VISION_MODEL : 'gemini-2.5-flash'}]`);
  console.log(`  API succeeded      ${s.ok}/${attempted}  (${pct(s.ok, attempted)})`);
  console.log(`  Reproduced the row ${s.matched}/${s.ok}  (${pct(s.matched, s.ok)})   ← the number that matters`);
  console.log(`  Amount exact       ${s.amountExact}/${s.matched}  (${pct(s.amountExact, s.matched)})`);
  console.log(`  Vendor string exact${String(s.vendorExact).padStart(4)}/${s.matched}  (${pct(s.vendorExact, s.matched)})`);
  console.log(`  Category agreed    ${s.categoryAgrees}/${s.matched}  (${pct(s.categoryAgrees, s.matched)})`);
  console.log(`  Mean latency       ${s.ok ? Math.round(s.ms / attempted) : 0} ms`);
  console.log(`  Needed a retry     ${s.retried}/${s.ok}`);
  if (Object.keys(s.reasons).length) {
    console.log('  Misses:');
    for (const [reason, n] of Object.entries(s.reasons).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(n).padStart(3)} × ${reason}`);
    }
  }
}

if (disagreements.length) {
  console.log(`\n${'─'.repeat(72)}\nDISAGREEMENTS (${disagreements.length}) — one provider got it, the other didn't\n`);
  for (const d of disagreements.slice(0, 15)) {
    console.log(`  ${d.label}`);
    for (const provider of PROVIDERS) {
      const p = d[provider];
      console.log(`    ${provider.padEnd(7)} ${p?.error ? `ERROR ${p.error.slice(0, 60)}`
        : `${p.extraction?.store_name || '?'} $${p.extraction?.total_amount ?? '?'} — ${p.result?.matched ? 'match' : p.result?.reason}`}`);
    }
  }
}

console.log(`\nNote: a "miss" can mean the model was wrong OR that the receipt was never
logged / was logged by hand. Read the disagreements before drawing conclusions.\n`);
