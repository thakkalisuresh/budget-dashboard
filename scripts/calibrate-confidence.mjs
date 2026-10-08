#!/usr/bin/env node
/**
 * Measure how usable the categorizer's self-reported confidence is.
 * Live Groq, no secrets in the file: GROQ_API_KEY comes from the environment.
 *
 *   read -s GROQ_API_KEY && export GROQ_API_KEY
 *   node scripts/calibrate-confidence.mjs [--n 5] [--variants prod,rubric,rubric_med,top2]
 *        [--vendors extra.json] [--out results.json] [--list]
 *
 * extra.json: [{"vendor": "...", "label": "Grocery"}, ...]. A label is the
 * intended category, or "?" when the vendor is genuinely ambiguous and the
 * right behaviour is to ASK rather than write.
 *
 * Variants (all call the production model with the production request shape;
 * only the prompt and reasoning effort differ):
 *   prod        the shipped prompt (buildPrompt: the described rubric), effort low
 *   prod_med    same, effort medium
 *   legacy      the pre-calibration prompt that named "below 0.75" (kept for comparison)
 *   top2        the rubric + a runner_up category
 *
 * Output: a per-vendor summary, then one compact raw line per (vendor,variant)
 * — `RAW|vendor|variant|label|source|cat:conf,cat:conf,...` — which is all the
 * analysis needs. Everything is also written to --out as JSON.
 */
import fs from 'node:fs';
import { GROQ_URL, GROQ_TEXT_MODEL, groqContent } from '../functions/lib/_groq.mjs';
import { CATEGORIES } from '../functions/lib/_extraction.mjs';
import { buildPrompt } from '../functions/lib/_categorize.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const N = Number(opt('--n', 5));
const OUT = opt('--out', 'calibrate-results.json');
const VARIANTS = opt('--variants', 'prod,prod_med,legacy,top2').split(',');

// [vendor, amount, label]. "?" = should always ask.
const BUILTIN = [
  // clearly unambiguous
  ["TRADER JOE'S #123", 54.2, 'Grocery'], ['SAFEWAY #1841', 87.3, 'Grocery'],
  ['CHIPOTLE 2210', 14.5, 'Eating Out'], ['BLUE BOTTLE COFFEE', 6.75, 'Eating Out'],
  ['NETFLIX.COM', 15.49, 'Entertainment'], ['SHELL OIL 57444', 42.0, 'Car Payments'],
  ['UBER EATS', 28.4, 'Eating Out'], ['DELTA AIR LINES', 312.0, 'Travel'],
  ['CVS/PHARMACY #0412', 22.1, 'Health'], ['SPOTIFY USA', 11.99, 'Entertainment'],
  // ambiguous
  ['AMZN Mktp US*2K4TR8', 39.99, '?'], ['SQ *BLOOM', 18.0, '?'], ['TARGET 00021', 63.4, '?'],
  ['COSTCO WHSE #0117', 212.0, '?'], ['WALMART SUPERCENTER', 71.0, '?'],
  ['PAYPAL *DIGITALGOOD', 25.0, '?'], ['VENMO PAYMENT', 40.0, '?'],
  ['Zelle to J Smith', 100.0, '?'], ['APPLE.COM/BILL', 9.99, '?'], ['GOOGLE *SERVICES', 12.0, '?'],
  // odd / Misc-ish
  ['REAL-DEBRID*17886754', 16.0, '?'], ['GITHUB, INC.', 4.0, '?'], ['PADDLE.NET* NOTION', 10.0, '?'],
  ['ALIPAY SINGAPORE', 22.0, '?'], ['XJ4K9 LLC', 33.0, '?'], ['TST* 88213', 19.0, '?'],
  ['MERCADO LIBRE MX', 45.0, '?'], ['CLOUDFLARE', 5.0, '?'], ['WWW.SKLZ.IO', 29.0, '?'],
  ['DOORDASH*ORDER', 32.0, 'Eating Out'],
];

const LEGACY_PROMPT = (vendor, amount) => [
  `Vendor: ${vendor}`, `Amount: $${amount}`, '',
  `Choose the single best category from this list: ${CATEGORIES.join(', ')}.`, '',
  'Reply with ONLY a JSON object, no markdown and no explanation:',
  '{"category": "<one of the listed categories>", "confidence": <0 to 1>}', '',
  'Set confidence below 0.75 when the vendor name is ambiguous, unfamiliar,',
  'or could plausibly belong to more than one category.',
].join('\n');

function promptFor(variant, vendor, amount) {
  if (variant === 'legacy') return LEGACY_PROMPT(vendor, amount);
  const base = buildPrompt(vendor, amount, CATEGORIES);
  return variant === 'top2'
    ? base.replace('"confidence": <0 to 1>}', '"runner_up": "<second best, or null>", "confidence": <0 to 1>}')
    : base;
}

async function call(variant, vendor, amount) {
  const effort = variant === 'prod_med' ? 'medium' : 'low';
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: GROQ_TEXT_MODEL, reasoning_effort: effort, max_tokens: 512, temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You categorize personal-finance transactions. Reply with JSON only.' },
          { role: 'user', content: promptFor(variant, vendor, amount) },
        ],
      }),
    });
    if (res.status === 429) { await new Promise(r => setTimeout(r, 2000 * (attempt + 1))); continue; }
    if (!res.ok) return { error: res.status };
    try {
      const p = JSON.parse(groqContent(await res.json()));
      if (!CATEGORIES.includes(p.category)) return { error: 'unknown_category' };
      return { category: p.category, confidence: Number(p.confidence), runner_up: p.runner_up ?? null };
    } catch { return { error: 'parse' }; }
  }
  return { error: 429 };
}

const vendors = [...BUILTIN];
const extra = opt('--vendors');
if (extra) for (const v of JSON.parse(fs.readFileSync(extra, 'utf8'))) vendors.push([v.vendor, v.amount ?? 30, v.label ?? '?', v.source ?? 'mine']);

if (args.includes('--list')) { console.log(vendors.map(v => v.join(' | ')).join('\n')); process.exit(0); }
if (!process.env.GROQ_API_KEY) { console.error('GROQ_API_KEY not set'); process.exit(1); }

const results = [];
const jobs = [];
for (const [vendor, amount, label, source = 'builtin'] of vendors) for (const variant of VARIANTS) jobs.push({ vendor, amount, label, source, variant });

// Four workers keeps us well under the rate limit while finishing in minutes.
let next = 0;
await Promise.all(Array.from({ length: 4 }, async () => {
  while (next < jobs.length) {
    const job = jobs[next++];
    const runs = [];
    for (let i = 0; i < N; i++) runs.push(await call(job.variant, job.vendor, job.amount));
    results.push({ ...job, runs });
  }
}));

fs.writeFileSync(OUT, JSON.stringify(results, null, 1));
const order = new Map(vendors.map((v, i) => [v[0], i]));
results.sort((a, b) => order.get(a.vendor) - order.get(b.vendor) || VARIANTS.indexOf(a.variant) - VARIANTS.indexOf(b.variant));

const stat = (runs) => {
  const ok = runs.filter(r => r.category);
  const dist = {};
  for (const r of ok) dist[r.category] = (dist[r.category] || 0) + 1;
  const c = ok.map(r => r.confidence);
  const mean = c.reduce((s, x) => s + x, 0) / (c.length || 1);
  return `${Object.entries(dist).map(([k, v]) => `${k}x${v}`).join(' ')} conf ${mean.toFixed(2)} [${Math.min(...c).toFixed(2)}-${Math.max(...c).toFixed(2)}]${runs.length - ok.length ? ` ERR${runs.length - ok.length}` : ''}`;
};
for (const r of results) console.log(`${r.vendor.padEnd(24)} ${r.label.padEnd(12)} ${r.variant.padEnd(10)} ${stat(r.runs)}`);
console.log('\n--- RAW ---');
for (const r of results) {
  console.log(`RAW|${r.vendor}|${r.variant}|${r.label}|${r.source}|${r.runs.map(x => x.category ? `${x.category}:${x.confidence}${x.runner_up ? `>${x.runner_up}` : ''}` : `E${x.error}`).join(',')}`);
}
