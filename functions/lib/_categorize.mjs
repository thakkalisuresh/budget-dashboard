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

const GROQ_URL   = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';

/**
 * Below this, the answer goes to the user instead of straight to the sheet.
 * Deliberately not 0.5: the cost of a wrong silent write is a mis-budgeted
 * month, while the cost of an unnecessary question is one tap.
 */
export const CONFIDENCE_THRESHOLD = 0.75;

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

function buildPrompt(vendor, amount, categories) {
  return [
    `Vendor: ${vendor}`,
    amount != null ? `Amount: $${amount}` : null,
    '',
    `Choose the single best category from this list: ${categories.join(', ')}.`,
    '',
    'Reply with ONLY a JSON object, no markdown and no explanation:',
    '{"category": "<one of the listed categories>", "confidence": <0 to 1>}',
    '',
    'Set confidence below 0.75 when the vendor name is ambiguous, unfamiliar,',
    'or could plausibly belong to more than one category.',
  ].filter(Boolean).join('\n');
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
        model: GROQ_MODEL,
        max_tokens: 80,
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
      return null;
    }

    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content?.trim();
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

/**
 * Decide the category for one expense.
 *
 * Returns { category, source, confidence, needsConfirm }:
 *   source 'rule'       — a smart rule matched; authoritative, never confirmed.
 *   source 'llm'        — Groq answered. needsConfirm is true below the
 *                         confidence threshold, meaning the caller should ask
 *                         before writing rather than guess silently.
 *   source 'extraction' — no rule, no usable LLM answer. Current behaviour.
 *
 * `enabled: false` short-circuits straight to the extractor so the whole
 * feature can be switched off without unpicking the call sites.
 */
export async function resolveCategory({
  vendor,
  amount,
  extractedCategory,
  categories,
  settings = {},
  enabled = true,
}) {
  const fallback = extractedCategory || 'Misc';

  const ruleCategory = applySmartRules(vendor, settings.smartRules);
  if (ruleCategory && categories.includes(ruleCategory)) {
    return { category: ruleCategory, source: 'rule', confidence: 1, needsConfirm: false };
  }

  if (!enabled) {
    return { category: fallback, source: 'extraction', confidence: 0, needsConfirm: false };
  }

  const guess = await categorizeWithGroq(vendor, amount, categories);
  if (!guess) {
    return { category: fallback, source: 'extraction', confidence: 0, needsConfirm: false };
  }

  // Agreeing with the extractor is corroboration, not a coin flip — take it
  // without asking even if the model hedged on its own confidence.
  if (guess.category === fallback) {
    return { category: guess.category, source: 'llm', confidence: guess.confidence, needsConfirm: false };
  }

  return {
    category: guess.category,
    source: 'llm',
    confidence: guess.confidence,
    needsConfirm: guess.confidence < CONFIDENCE_THRESHOLD,
  };
}
