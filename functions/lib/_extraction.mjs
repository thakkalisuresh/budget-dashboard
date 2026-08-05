/**
 * AI-powered receipt extraction — Gemini primary, Claude fallback.
 * Fallback chain: gemini-2.5-flash → gemini-2.5-pro
 *               → claude-sonnet-4-6 → claude-haiku-4-5
 * Files in lib/ are shared modules, not standalone deployed functions.
 */

const GEMINI_API_KEY    = process.env.GEMINI_API_KEY;
const GEMINI_URL        = 'https://generativelanguage.googleapis.com/v1beta/models';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_URL     = 'https://api.anthropic.com/v1/messages';

const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.5-pro'];  // flash = fast/cheap primary, pro = fallback
const CLAUDE_MODELS = ['claude-sonnet-4-6', 'claude-haiku-4-5'];
const PRIMARY_MODEL = GEMINI_MODELS[0];
const MAX_RETRIES   = 2;

const CATEGORIES = [
  'Grocery', 'Eating Out', 'Misc', 'Travel', 'Thakkali', 'Entertainment',
  'Investment', 'Car Payments', 'Utilities', 'Rent', 'Health', 'Furniture', 'Holiday', 'Wi-Fi',
];

const SYSTEM_PROMPT = `You are a transaction parser for a personal budget tracker. Extract structured data from images (receipt photos, wallet app screenshots like Apple Pay/Google Pay/Samsung Pay, bank app screenshots, SMS notification screenshots) and return ONLY valid JSON — no markdown, no explanation, no preamble.`;

/** Today in YYYY-MM-DD. Isolated so tests can freeze it. */
export function todayISO(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/**
 * Statement/receipt dates are often printed as MM/DD with no year (Amex BCP
 * does this). Without today's date in the prompt the model invents a year from
 * its training prior — historically 2024 — and `_bot-core` then routes the
 * expense to the wrong year tab. Every prompt builder gets this block.
 */
function dateRules(today) {
  const year = Number(today.slice(0, 4));
  return `- Today is ${today}. If a transaction date shows no year (e.g. "03/14" or "Mar 14"), use the most recent past occurrence of that month/day: never a future date, and never earlier than ${year - 1} unless the year is printed on the document.
- If a year IS printed, use it exactly as printed.`;
}

function buildUserPrompt(today = todayISO()) {
  return `Extract data from this transaction image. The image could be:
- A physical receipt photo
- A wallet app screenshot (Apple Pay, Google Pay, Samsung Pay, Venmo, Zelle, PayPal, etc.)
- A bank app or SMS notification screenshot showing a charge or transfer

Return EXACTLY this JSON structure:

{"store_name":"Store Name","purchase_date":"YYYY-MM-DD","total_amount":45.23,"tax_amount":3.50,"currency":"USD","items":[{"name":"Item name","amount":5.99,"item_category":"Grocery"}],"reward_category":"Grocery","is_transfer":false,"payment_method":"Chase Sapphire Reserve"}

Rules:
- store_name: The merchant/vendor name (for transfers, use the recipient name)
- purchase_date: Date in YYYY-MM-DD format. If unclear, use null
${dateRules(today)}
- total_amount: Final total/charge amount. Must be a positive number, no currency symbol
- tax_amount: Tax amount if shown, else null
- currency: 3-letter ISO code visible (USD, INR, EUR, GBP, etc.). Default "USD" if not shown
- items: Array of line items, each {name, amount, item_category}. Empty array [] for non-receipt images
- item_category (per line item): your best guess of which budget category that single item belongs to, exactly one of: ${CATEGORIES.join(', ')}. Use it for receipts that mix categories (e.g. a Costco run with groceries + clothing + electronics). If you cannot tell for an item (e.g. ambiguous clothing/electronics), use null and the user will be asked.
- reward_category: MUST be exactly one of: ${CATEGORIES.join(', ')}. Pick the closest match. Use "Misc" if none fit. For transfers (is_transfer=true), set to null (user will pick).
- is_transfer: true if this is a peer-to-peer payment, money transfer, or sending money (Zelle, Venmo, PayPal P2P, bank transfer, "sent to" someone). false for purchases at merchants.
- payment_method: The card or account name if visible. On Apple Pay / Google Pay / Samsung Pay wallet screenshots the card name appears prominently near the top (e.g. "Sapphire Reserve", "Blue Cash Preferred") — extract it exactly as shown. Use null if no card is visible.

If the image is completely unreadable, return:
{"store_name":null,"purchase_date":null,"total_amount":null,"tax_amount":null,"currency":"USD","items":[],"reward_category":null,"is_transfer":false,"payment_method":null}

Respond with ONLY the JSON object. No other text.`;
}

function buildTextPrompt(text, today = todayISO()) {
  return `Extract transaction data from this text (likely a bank SMS, payment notification, or transaction alert):

"""
${text}
"""

Return EXACTLY this JSON structure:
{"store_name":"...","purchase_date":"YYYY-MM-DD","total_amount":45.23,"tax_amount":null,"currency":"USD","items":[],"reward_category":"...","is_transfer":false,"payment_method":null}

Rules:
- store_name: Merchant/vendor name from the text (for transfers, use the recipient name)
- purchase_date: Date in YYYY-MM-DD if mentioned. If not, use null
${dateRules(today)}
- total_amount: The charge amount. Positive number, no currency symbol
- tax_amount: null (text usually doesn't mention tax separately)
- currency: 3-letter ISO code (USD, INR, EUR, GBP, etc.). Detect from symbols ($, \\u20b9, \\u20ac, \\u00a3) or text. Default "USD"
- items: Always empty []
- reward_category: MUST be exactly one of: ${CATEGORIES.join(', ')}. Pick closest match based on merchant. Use "Misc" if unclear. For transfers, set to null.
- is_transfer: true if this is a peer-to-peer payment (Zelle, Venmo, PayPal P2P, bank transfer "to" someone). false for merchant charges.
- payment_method: The card or account name if the text names it (e.g. "Chase Sapphire Reserve", "Card ending 1234", "Amex Gold"). Extract it exactly as shown. Use null if no card/account is mentioned.

If the text doesn't look like a transaction notification (e.g., random text, greetings), return:
{"store_name":null,"purchase_date":null,"total_amount":null,"tax_amount":null,"currency":"USD","items":[],"reward_category":null,"is_transfer":false,"payment_method":null}

Respond with ONLY the JSON object. No other text.`;
}

/* ── sanitization ── */

/**
 * Second line of defence for the missing-year problem (see `dateRules`).
 * If the model still returns an implausible year — a future date, or older than
 * last year — remap to the most recent past occurrence of that month/day.
 * Conservative by design: a plausible year is never rewritten, and an
 * unparseable value is left alone for the caller to reject.
 */
/**
 * Coerce whatever the model returned into YYYY-MM-DD.
 *
 * The prompt asks for YYYY-MM-DD, but models drift — and every guard
 * downstream assumed compliance. repairPurchaseYear matched strict ISO only,
 * so a receipt dated "07/15/2024" sailed past the stale-year check with its
 * wrong year intact, and then got written to the sheet in that shape too.
 * That is how a real receipt ended up routed at "July 2024" and failed with
 * SHT-002 (2026-07-29).
 *
 * Day/month order is read as US convention (MM/DD), matching the receipts this
 * app actually sees — dollars, US cards. A date that cannot be read confidently
 * is returned untouched rather than guessed at: a wrong date silently written
 * to a budget is worse than one that fails loudly.
 */
export function normalizePurchaseDate(value) {
  if (typeof value !== 'string') return value;
  const s = value.trim();
  if (!s) return value;

  const pad = (n) => String(n).padStart(2, '0');
  const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

  // Already strict ISO — the common, compliant case.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // Sloppy ISO: 2024-7-5
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return iso(m[1], m[2], m[3]);

  // ISO timestamp: keep the date half.
  m = /^(\d{4}-\d{2}-\d{2})[T ]/.exec(s);
  if (m) return m[1];

  // US slash/dash: 7/15/2024, 07-15-24
  m = /^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2}|\d{4})$/.exec(s);
  if (m) {
    const [, mo, d, rawY] = m;
    const y = rawY.length === 2 ? String(2000 + Number(rawY)) : rawY;
    if (Number(mo) >= 1 && Number(mo) <= 12 && Number(d) >= 1 && Number(d) <= 31) {
      return iso(y, mo, d);
    }
    return value; // out of range — do not guess
  }

  // Long form: "July 15, 2024" / "15 July 2024"
  const parsed = Date.parse(s);
  if (!Number.isNaN(parsed)) {
    const dt = new Date(parsed);
    return iso(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
  }

  return value;
}

export function repairPurchaseYear(dateStr, today = todayISO()) {
  if (typeof dateStr !== 'string') return dateStr;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
  if (!m) return dateStr;

  const [, y, mo, d] = m;
  const todayMs = Date.parse(`${today}T00:00:00Z`);
  const asMs = Date.parse(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(asMs) || Number.isNaN(todayMs)) return dateStr;

  const currentYear = Number(today.slice(0, 4));
  const GRACE_MS = 2 * 24 * 60 * 60 * 1000; // clock skew / timezone slack
  const tooFuture = asMs > todayMs + GRACE_MS;
  const tooOld = Number(y) < currentYear - 1;
  if (!tooFuture && !tooOld) return dateStr;

  // Prefer this year; fall back to last year when that would still be future.
  for (const candidateYear of [currentYear, currentYear - 1]) {
    const candidate = `${candidateYear}-${mo}-${d}`;
    const ms = Date.parse(`${candidate}T00:00:00Z`);
    if (!Number.isNaN(ms) && ms <= todayMs + GRACE_MS) {
      if (candidate !== dateStr) {
        console.warn(`repairPurchaseYear: remapped ${dateStr} → ${candidate} (today ${today})`);
      }
      return candidate;
    }
  }
  return dateStr;
}

export function sanitizeExtraction(data) {
  if (!data || typeof data !== 'object') return data;
  const result = { ...data };

  if (typeof result.purchase_date === 'string') {
    // Normalize the shape BEFORE repairing the year — the year guard only
    // recognises YYYY-MM-DD, so anything else silently bypassed it.
    result.purchase_date = repairPurchaseYear(normalizePurchaseDate(result.purchase_date));
  }

  if (typeof result.store_name === 'string') {
    result.store_name = safeString(result.store_name);
  }
  if (typeof result.payment_method === 'string') {
    result.payment_method = safeString(result.payment_method);
  }
  if (typeof result.reward_category === 'string') {
    if (!CATEGORIES.includes(result.reward_category)) {
      result.reward_category = 'Misc';
    }
  }
  if (typeof result.total_amount === 'number') {
    result.total_amount = Math.abs(result.total_amount);
  }
  if (Array.isArray(result.items)) {
    result.items = result.items.map(item => ({
      ...item,
      name: typeof item.name === 'string' ? safeString(item.name) : item.name,
      amount: typeof item.amount === 'number' ? Math.abs(item.amount) : item.amount,
      // Per-item category hint: keep only if it's a known category, else null
      // (the deterministic categorizer + user picker handle the rest).
      item_category: CATEGORIES.includes(item.item_category) ? item.item_category : null,
    }));
  }
  if (typeof result.is_transfer !== 'boolean') {
    result.is_transfer = false;
  }
  if (typeof result.currency !== 'string' || result.currency.length !== 3) {
    result.currency = 'USD';
  } else {
    result.currency = result.currency.toUpperCase();
  }
  return result;
}

function safeString(value) {
  if (typeof value !== 'string' || value.length === 0) return value;
  const trimmed = value.trim();
  if (trimmed.length === 0) return value;
  const c = trimmed.charCodeAt(0);
  if (c === 0x3d || c === 0x2b || c === 0x2d || c === 0x40 ||
      c === 0x0d || c === 0x0a || c === 0x09) {
    return "'" + value;
  }
  return value;
}

function parseJSON(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON in response');
  return JSON.parse(match[0]);
}

/* ── Gemini API ── */

async function callGemini(model, base64, mediaType, userPrompt) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not configured');

  const url = `${GEMINI_URL}/${model}:generateContent?key=${GEMINI_API_KEY}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [
        { inline_data: { mime_type: mediaType, data: base64 } },
        { text: userPrompt ?? buildUserPrompt() },
      ] }],
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      generationConfig: { responseMimeType: 'application/json' },
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err?.error?.message || `HTTP ${res.status}`;
    throw new Error(`Gemini API (${model}): ${msg}`);
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  return parseJSON(text);
}

async function callGeminiText(model, text) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not configured');

  const url = `${GEMINI_URL}/${model}:generateContent?key=${GEMINI_API_KEY}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: buildTextPrompt(text) }] }],
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      generationConfig: { responseMimeType: 'application/json' },
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err?.error?.message || `HTTP ${res.status}`;
    throw new Error(`Gemini API (${model}): ${msg}`);
  }

  const data = await res.json();
  const responseText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  return parseJSON(responseText);
}

/* ── Claude API ── */

async function callClaude(model, base64, mediaType, userPrompt) {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not configured');

  const contentBlock = mediaType === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
    : { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } };

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: [contentBlock, { type: 'text', text: userPrompt ?? buildUserPrompt() }],
      }],
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err?.error?.message || `HTTP ${res.status}`;
    throw new Error(`Claude API (${model}): ${msg}`);
  }

  const data = await res.json();
  const text = data.content?.[0]?.text || '';
  return parseJSON(text);
}

async function callClaudeText(model, text) {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not configured');

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: buildTextPrompt(text) }],
      }],
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err?.error?.message || `HTTP ${res.status}`;
    throw new Error(`Claude API (${model}): ${msg}`);
  }

  const data = await res.json();
  const responseText = data.content?.[0]?.text || '';
  return parseJSON(responseText);
}

/* ── public extraction with full fallback chain ── */

export async function extractReceipt(base64, mediaType) {
  let lastError;

  // 1. Gemini primary: gemini-2.0-flash with retries
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const raw = await callGemini(PRIMARY_MODEL, base64, mediaType);
      return { ok: true, data: sanitizeExtraction(raw), model: PRIMARY_MODEL };
    } catch (e) {
      lastError = e;
      console.warn(`extractReceipt: ${PRIMARY_MODEL} attempt ${attempt + 1} failed:`, e.message);
    }
  }

  // 2. Gemini fallbacks: gemini-1.5-pro, gemini-2.5-pro (one try each)
  for (const model of GEMINI_MODELS.slice(1)) {
    try {
      const raw = await callGemini(model, base64, mediaType);
      return { ok: true, data: sanitizeExtraction(raw), model };
    } catch (e) {
      lastError = e;
      console.warn(`extractReceipt: ${model} failed:`, e.message);
    }
  }

  // 3. Claude fallbacks: sonnet, haiku (one try each)
  for (const model of CLAUDE_MODELS) {
    try {
      const raw = await callClaude(model, base64, mediaType);
      return { ok: true, data: sanitizeExtraction(raw), model };
    } catch (e) {
      lastError = e;
      console.warn(`extractReceipt: ${model} failed:`, e.message);
    }
  }

  console.error('EXTR-005 — All extraction models exhausted (extractReceipt):', lastError?.message);
  return { ok: false, error: 'illegible', message: lastError?.message };
}

/* ── Batch extraction (one image → multiple transactions) ── */

function buildBatchUserPrompt(today = todayISO()) {
  return `Analyze this image and extract ALL distinct transactions it contains. The image could be:
- A bank app transaction history or statement screenshot (may show many charges)
- An Apple Wallet, Google Pay, or Samsung Pay history screen (may show several payments)
- A single physical receipt photo (one transaction)
- A single wallet-app confirmation screen (one transaction)

Return EXACTLY this JSON structure — always a "transactions" array, even for a single transaction:

{"transactions":[{"store_name":"Store Name","purchase_date":"YYYY-MM-DD","total_amount":45.23,"tax_amount":null,"currency":"USD","items":[{"name":"Item name","amount":5.99,"item_category":"Grocery"}],"reward_category":"Grocery","is_transfer":false,"payment_method":"Chase Sapphire Reserve"}]}

Rules for each transaction object in the array:
- store_name: The merchant/vendor name (for transfers, use the recipient name)
- purchase_date: Date in YYYY-MM-DD format. If unclear, use null
${dateRules(today)}
- total_amount: Final charge/payment amount. Must be a positive number, no currency symbol
- tax_amount: Tax amount if shown, else null
- currency: 3-letter ISO code (USD, INR, EUR, GBP, etc.). Default "USD" if not shown
- items: Array of line items, each {name, amount, item_category}. Use [] unless this is a physical receipt with itemized lines
- item_category (per line item): best guess of the budget category for that single item, exactly one of: ${CATEGORIES.join(', ')}, or null if ambiguous (e.g. clothing/electronics). Used to split mixed receipts.
- reward_category: MUST be exactly one of: ${CATEGORIES.join(', ')}. Pick the closest match. Use "Misc" if none fit. For transfers (is_transfer=true), set to null.
- is_transfer: true if this is a peer-to-peer payment (Zelle, Venmo, PayPal P2P, bank transfer "sent to" someone). false for merchant purchases.
- payment_method: Card or account name if visible, else null

If the image is completely unreadable or contains no transactions, return: {"transactions":[]}

Respond with ONLY the JSON object. No other text.`;
}

function parseBatchJSON(raw) {
  return Array.isArray(raw?.transactions) ? raw.transactions : [];
}

export async function extractReceiptBatch(base64, mediaType) {
  const prompt = buildBatchUserPrompt();
  let lastError;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const raw = await callGemini(PRIMARY_MODEL, base64, mediaType, prompt);
      const transactions = parseBatchJSON(raw).map(sanitizeExtraction).filter(t => t.total_amount != null);
      return { ok: true, transactions, model: PRIMARY_MODEL };
    } catch (e) {
      lastError = e;
      console.warn(`extractReceiptBatch: ${PRIMARY_MODEL} attempt ${attempt + 1} failed:`, e.message);
    }
  }

  for (const model of GEMINI_MODELS.slice(1)) {
    try {
      const raw = await callGemini(model, base64, mediaType, prompt);
      const transactions = parseBatchJSON(raw).map(sanitizeExtraction).filter(t => t.total_amount != null);
      return { ok: true, transactions, model };
    } catch (e) {
      lastError = e;
      console.warn(`extractReceiptBatch: ${model} failed:`, e.message);
    }
  }

  for (const model of CLAUDE_MODELS) {
    try {
      const raw = await callClaude(model, base64, mediaType, prompt);
      const transactions = parseBatchJSON(raw).map(sanitizeExtraction).filter(t => t.total_amount != null);
      return { ok: true, transactions, model };
    } catch (e) {
      lastError = e;
      console.warn(`extractReceiptBatch: ${model} failed:`, e.message);
    }
  }

  console.error('EXTR-005 — All extraction models exhausted (batch):', lastError?.message);
  return { ok: false, error: 'illegible', message: lastError?.message };
}

export async function extractTransactionText(text) {
  let lastError;

  // 1. Gemini primary: gemini-2.0-flash with retries
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const raw = await callGeminiText(PRIMARY_MODEL, text);
      return { ok: true, data: sanitizeExtraction(raw), model: PRIMARY_MODEL };
    } catch (e) {
      lastError = e;
      console.warn(`extractTransactionText: ${PRIMARY_MODEL} attempt ${attempt + 1} failed:`, e.message);
    }
  }

  // 2. Gemini fallbacks: gemini-1.5-pro, gemini-2.5-pro (one try each)
  for (const model of GEMINI_MODELS.slice(1)) {
    try {
      const raw = await callGeminiText(model, text);
      return { ok: true, data: sanitizeExtraction(raw), model };
    } catch (e) {
      lastError = e;
      console.warn(`extractTransactionText: ${model} failed:`, e.message);
    }
  }

  // 3. Claude fallbacks: sonnet, haiku (one try each)
  for (const model of CLAUDE_MODELS) {
    try {
      const raw = await callClaudeText(model, text);
      return { ok: true, data: sanitizeExtraction(raw), model };
    } catch (e) {
      lastError = e;
      console.warn(`extractTransactionText: ${model} failed:`, e.message);
    }
  }

  console.error('EXTR-005 — All extraction models exhausted (text):', lastError?.message);
  return { ok: false, error: 'illegible', message: lastError?.message };
}

export { CATEGORIES };

/* Exported for scripts/eval-vision.mjs so an offline provider comparison runs the
 * EXACT prompts production uses. An eval against a lookalike prompt measures the
 * lookalike, not the bot. Not used by any deployed code path. */
export const __evalInternals = { SYSTEM_PROMPT, buildUserPrompt, buildTextPrompt, parseJSON };
