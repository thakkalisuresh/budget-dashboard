/**
 * Category resolution for newly-added expenses.
 *
 * Three layers, cheapest and most trusted first:
 *   1. Smart rules   — the user's own "vendor X → category Y" mappings. Exact
 *                      intent, no network, never second-guessed.
 *   2. Groq          — an LLM opinion for vendors no rule covers, returning a
 *                      confidence with its answer.
 *   3. The extractor  — whatever reward_category the vision/text model already
 *                      produced. This is today's behaviour and stays the
 *                      fallback whenever the LLM is unavailable or unsure.
 *
 * Layer 1 is new on the server. `applySmartRules` had only ever run in the
 * browser (src/smartRules.js, used by useReceiptScanner), so expenses added
 * through Telegram or the wallet webhook silently ignored the user's category
 * rules. Mirroring it here fixes that as a side effect of adding layer 2.
 */

import { GROQ_URL, GROQ_TEXT_MODEL, groqParams, groqContent, reportGroqFailure } from './_groq.mjs';

/**
 * The confidence scale the model is asked to use. The prompt is generated from
 * this list, so the words the model sees and the threshold below stay together.
 *
 * Measured live (scripts/calibrate-confidence.mjs, 92 vendors x 5 runs): the
 * model does not produce a continuous confidence, it snaps to a few anchors
 * (0.2, 0.5, 0.7, 0.8, 0.9, 1.0). On this household's vendors 0.9 and above was
 * right about 95% of the time; 0.8 and below was not.
 */
export const CONFIDENCE_RUBRIC = [
  [1.0, 'a household-name merchant with one obvious category'],
  [0.7, 'probably this category, but a second one is plausible'],
  [0.5, 'could be several categories'],
  [0.2, 'essentially a guess'],
];

/**
 * Below this, the answer goes to the user instead of straight to the sheet:
 * silent at 0.9 and up, asks at 0.8 and below. The one place to move it (0.95
 * would ask on almost every first-time vendor and leak nothing measured).
 * A wrong silent write is a mis-budgeted month; an unnecessary question is one
 * tap, and the answer lands in history so it is only asked once.
 */
export const CONFIDENCE_THRESHOLD = 0.85;

/**
 * Vendors the model scores 0.8-0.9 while being wrong for a household's own
 * filing, because the right category depends on what was bought or who was paid:
 * warehouse and big-box stores, marketplaces, person-to-person payments and
 * app-store or platform billing. Always asked about on first sight; the answer
 * then lands in history. Word-anchored so "Targeted Marketing" or "Applebees"
 * never match.
 */
export const ALWAYS_ASK_VENDORS = [
  /\bcostco\b/i, /\btarget\b/i, /\bwalmart\b/i, /\b(?:amazon|amzn)\b/i,
  /\bzelle\b/i, /\bvenmo\b/i, /\bpaypal\b/i, /\bapple\.com\b/i, /^google\s*\*/i,
];

export function isAlwaysAsk(vendor) {
  return !!vendor && ALWAYS_ASK_VENDORS.some(re => re.test(vendor));
}

/**
 * The weekly audit flags rows the model disagrees with, and only when it is at
 * the top anchor: at any lower anchor the model was measured wrong about as often
 * as right on this household's categories, so a flag there is noise.
 */
export const AUDIT_CONFIDENCE = 1.0;

/** How much of a vendor's prior filings must agree before history settles it. */
const HISTORY_AGREEMENT = 0.75;

/**
 * How many agreeing prior rows history needs before it may skip the prompt:
 * a single row is one data point (one holiday purchase at a big-box store would
 * otherwise pin that store's category for good), so ordinary vendors need two
 * and the always-ask class needs three. With fewer, the charge goes on to the
 * LLM and the threshold like a first sighting.
 */
const HISTORY_MIN_ROWS = 2;
const HISTORY_MIN_ROWS_ALWAYS_ASK = 3;

/**
 * MIRROR of applySmartRules in src/smartRules.js — keep the two in step.
 * Returns the matching category, or null. Most specific (longest pattern) wins.
 */
export function applySmartRules(vendor, rules) {
  if (!vendor || !rules?.length) return null;
  const v = vendor.toLowerCase().trim();
  const matches = rules.filter(r =>
    r.pattern?.trim() && v.includes(r.pattern.toLowerCase().trim())
  );
  if (matches.length === 0) return null;
  matches.sort((a, b) => b.pattern.length - a.pattern.length);
  return matches[0].category;
}

export function buildPrompt(vendor, amount, categories) {
  return [
    `Vendor: ${vendor}`,
    amount != null ? `Amount: $${amount}` : null,
    '',
    `Choose the single best category from this list: ${categories.join(', ')}.`,
    '',
    'Reply with ONLY a JSON object, no markdown and no explanation:',
    '{"category": "<one of the listed categories>", "confidence": <0 to 1>}',
    '',
    'Report confidence as how sure you are that this single category is the right one for this vendor:',
    ...CONFIDENCE_RUBRIC.map(([score, meaning]) => `${score.toFixed(1)} = ${meaning};`),
    'Judge the vendor name, not how confident you feel.',
  ].filter(v => v !== null).join('\n');
}

/**
 * Ask Groq for a category. Returns { category, confidence } or null when the
 * call fails, the key is missing, or the answer isn't a category we recognise.
 * Never throws — every caller treats a null as "just use the extractor".
 */
export async function categorizeWithGroq(vendor, amount, categories, { fetchImpl = fetch } = {}) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey || !vendor) return null;

  try {
    const res = await fetchImpl(GROQ_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: GROQ_TEXT_MODEL,
        ...groqParams(GROQ_TEXT_MODEL),
        // Reasoning tokens count against this; 80 left a reasoning model with
        // nothing to say. The answer itself is ~20 tokens.
        max_tokens: 512,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You categorize personal-finance transactions. Reply with JSON only.' },
          { role: 'user', content: buildPrompt(vendor, amount, categories) },
        ],
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.warn('categorize: Groq API', err?.error?.message || res.status);
      await reportGroqFailure(GROQ_TEXT_MODEL, res.status, err?.error);
      return null;
    }

    const data = await res.json();
    const raw = groqContent(data);
    if (!raw) return null;

    const parsed = JSON.parse(raw);
    // A category outside the list is unusable — the sheet has no tab for it.
    if (!categories.includes(parsed.category)) {
      console.warn(`categorize: Groq returned unknown category "${parsed.category}"`);
      return null;
    }
    const confidence = typeof parsed.confidence === 'number'
      ? Math.max(0, Math.min(1, parsed.confidence))
      : 0;
    return { category: parsed.category, confidence };
  } catch (e) {
    console.warn('categorize: Groq failed', e.message);
    return null;
  }
}

/** Lowercased word list with store numbers and punctuation dropped. */
function vendorTokens(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ')
    .filter(t => t && !/^\d+$/.test(t));
}

/**
 * Same vendor, tolerant of store numbers, a longer legal name, and the
 * truncation card feeds apply ("DAILY GROCERY BEER AND WI"). Deliberately
 * stricter than fuzzyNamesMatch: sharing one word ("Market", "Amazon") is not
 * the same vendor, and a false match here would file a charge silently.
 */
function sameVendor(a, b) {
  const ta = vendorTokens(a);
  const tb = vendorTokens(b);
  return startsWith(ta, tb) || startsWith(tb, ta);
}

/** `short` is a leading run of `long`'s words, its last word possibly cut off. */
function startsWith(short, long) {
  if (!short.length || short.length > long.length) return false;
  const last = short.length - 1;
  return short.every((tok, i) =>
    tok === long[i] || (i === last && short.length > 1 && tok.length >= 2 && long[i].startsWith(tok)));
}

/**
 * What the user themselves have filed this vendor under, from recent sheet rows
 * ({ vendor, category }). Returns null with no usable prior filing, otherwise
 * { category, count, agree, supported }: the most frequent category, whether at
 * least HISTORY_AGREEMENT of the rows share it, and whether enough rows agree
 * (HISTORY_MIN_ROWS, or more for an always-ask vendor) for it to settle the
 * charge. A vendor that is split across categories (a warehouse store) reports
 * agree: false and the caller asks; too little support just means "no answer yet".
 */
export function categoryFromHistory(vendor, rows, categories) {
  if (!vendor || !rows?.length) return null;
  const counts = new Map();
  let total = 0;
  for (const r of rows) {
    if (!categories.includes(r?.category) || !sameVendor(r.vendor, vendor)) continue;
    counts.set(r.category, (counts.get(r.category) || 0) + 1);
    total++;
  }
  if (!total) return null;
  const [category, top] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  const agree = top / total >= HISTORY_AGREEMENT;
  const needed = isAlwaysAsk(vendor) ? HISTORY_MIN_ROWS_ALWAYS_ASK : HISTORY_MIN_ROWS;
  return { category, count: total, agree, supported: agree && top >= needed };
}

/**
 * Decide the category for one expense.
 *
 * Returns { category, source, confidence, needsConfirm }:
 *   source 'rule'       — a smart rule matched; authoritative, never confirmed.
 *   source 'history'    — the user has filed this vendor before, consistently and
 *                         more than once. Their own decision beats a guess; never confirmed.
 *   source 'llm'        — Groq answered. needsConfirm is true below
 *                         CONFIDENCE_THRESHOLD, when the answer is Misc, for a vendor on
 *                         ALWAYS_ASK_VENDORS, or when the vendor's history is split, meaning the caller
 *                         should ask before writing rather than guess silently.
 *   source 'extraction' — no rule, no usable LLM answer. Current behaviour.
 *
 * `history` is recent sheet rows ({ vendor, category }); omit it to skip that layer.
 *
 * The extractor's category no longer lets Groq skip the threshold: both come
 * from the same model family and their errors correlate (both said Travel for a
 * car rental filed under Holiday). It only serves as the fallback answer.
 *
 * `enabled: false` short-circuits the LLM so the whole feature can be switched
 * off without unpicking the call sites; rules and history still apply.
 */
export async function resolveCategory({
  vendor,
  amount,
  extractedCategory,
  categories,
  settings = {},
  history,
  enabled = true,
}) {
  const fallback = extractedCategory || 'Misc';

  const ruleCategory = applySmartRules(vendor, settings.smartRules);
  if (ruleCategory && categories.includes(ruleCategory)) {
    return { category: ruleCategory, source: 'rule', confidence: 1, needsConfirm: false };
  }

  const prior = categoryFromHistory(vendor, history, categories);
  // A history of Misc says nothing: Misc is the unknown bucket, and the old
  // pipeline defaulted many rows there until the user moved them. Repeating it
  // silently would freeze those mistakes, so it goes on to the LLM, where the
  // Misc rule asks. A vendor that really is Misc is pinned with a smart rule.
  if (prior?.supported && prior.category !== 'Misc') {
    return { category: prior.category, source: 'history', confidence: 1, needsConfirm: false };
  }

  if (!enabled) {
    return { category: fallback, source: 'extraction', confidence: 0, needsConfirm: false };
  }

  const guess = await categorizeWithGroq(vendor, amount, categories);
  if (!guess) {
    return { category: fallback, source: 'extraction', confidence: 0, needsConfirm: false };
  }

  return {
    category: guess.category,
    source: 'llm',
    confidence: guess.confidence,
    // Misc is where an unfamiliar vendor lands, so a Misc answer is never proof
    // of anything, however sure the model sounds.
    needsConfirm: guess.confidence < CONFIDENCE_THRESHOLD
      || guess.category === 'Misc'
      || isAlwaysAsk(vendor)
      || (prior != null && !prior.agree),
  };
}
