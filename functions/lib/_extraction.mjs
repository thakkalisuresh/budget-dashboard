/**
 * AI-powered receipt extraction — Gemini primary, Claude fallback.
 * Fallback chain: gemini-2.5-flash → gemini-2.5-pro
 *               → claude-sonnet-4-6 → claude-haiku-4-5
 * Files starting with "_" are NOT deployed as functions by Netlify.
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

function buildUserPrompt() {
  return `Extract data from this transaction image. The image could be:
- A physical receipt photo
- A wallet app screenshot (Apple Pay, Google Pay, Samsung Pay, Venmo, Zelle, PayPal, etc.)
- A bank app or SMS notification screenshot showing a charge or transfer

Return EXACTLY this JSON structure:

{"store_name":"Store Name","purchase_date":"YYYY-MM-DD","total_amount":45.23,"tax_amount":3.50,"currency":"USD","items":[{"name":"Item name","amount":5.99}],"reward_category":"Grocery","is_transfer":false,"payment_method":"Chase Sapphire Reserve"}

Rules:
- store_name: The merchant/vendor name (for transfers, use the recipient name)
- purchase_date: Date in YYYY-MM-DD format. If unclear, use null
- total_amount: Final total/charge amount. Must be a positive number, no currency symbol
- tax_amount: Tax amount if shown, else null
- currency: 3-letter ISO code visible (USD, INR, EUR, GBP, etc.). Default "USD" if not shown
- items: Array of line items with name and amount. Empty array [] for non-receipt images
- reward_category: MUST be exactly one of: ${CATEGORIES.join(', ')}. Pick the closest match. Use "Misc" if none fit. For transfers (is_transfer=true), set to null (user will pick).
- is_transfer: true if this is a peer-to-peer payment, money transfer, or sending money (Zelle, Venmo, PayPal P2P, bank transfer, "sent to" someone). false for purchases at merchants.
- payment_method: The card or account name if visible. On Apple Pay / Google Pay / Samsung Pay wallet screenshots the card name appears prominently near the top (e.g. "Sapphire Reserve", "Blue Cash Preferred") — extract it exactly as shown. Use null if no card is visible.

If the image is completely unreadable, return:
{"store_name":null,"purchase_date":null,"total_amount":null,"tax_amount":null,"currency":"USD","items":[],"reward_category":null,"is_transfer":false,"payment_method":null}

Respond with ONLY the JSON object. No other text.`;
}

function buildTextPrompt(text) {
  return `Extract transaction data from this text (likely a bank SMS, payment notification, or transaction alert):

"""
${text}
"""

Return EXACTLY this JSON structure:
{"store_name":"...","purchase_date":"YYYY-MM-DD","total_amount":45.23,"tax_amount":null,"currency":"USD","items":[],"reward_category":"...","is_transfer":false,"payment_method":null}

Rules:
- store_name: Merchant/vendor name from the text (for transfers, use the recipient name)
- purchase_date: Date in YYYY-MM-DD if mentioned. If not, use null
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

export function sanitizeExtraction(data) {
  if (!data || typeof data !== 'object') return data;
  const result = { ...data };

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

  console.error('extractReceipt: all models exhausted:', lastError?.message);
  return { ok: false, error: 'illegible', message: lastError?.message };
}

/* ── Batch extraction (one image → multiple transactions) ── */

function buildBatchUserPrompt() {
  return `Analyze this image and extract ALL distinct transactions it contains. The image could be:
- A bank app transaction history or statement screenshot (may show many charges)
- An Apple Wallet, Google Pay, or Samsung Pay history screen (may show several payments)
- A single physical receipt photo (one transaction)
- A single wallet-app confirmation screen (one transaction)

Return EXACTLY this JSON structure — always a "transactions" array, even for a single transaction:

{"transactions":[{"store_name":"Store Name","purchase_date":"YYYY-MM-DD","total_amount":45.23,"tax_amount":null,"currency":"USD","items":[],"reward_category":"Grocery","is_transfer":false,"payment_method":"Chase Sapphire Reserve"}]}

Rules for each transaction object in the array:
- store_name: The merchant/vendor name (for transfers, use the recipient name)
- purchase_date: Date in YYYY-MM-DD format. If unclear, use null
- total_amount: Final charge/payment amount. Must be a positive number, no currency symbol
- tax_amount: Tax amount if shown, else null
- currency: 3-letter ISO code (USD, INR, EUR, GBP, etc.). Default "USD" if not shown
- items: Array of line items with name and amount. Use [] unless this is a physical receipt with itemized lines
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

  console.error('extractReceiptBatch: all models exhausted:', lastError?.message);
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

  console.error('extractTransactionText: all models exhausted:', lastError?.message);
  return { ok: false, error: 'illegible', message: lastError?.message };
}

export { CATEGORIES };
