/**
 * Claude receipt extraction for serverless (WhatsApp) context.
 * Calls Anthropic API directly — no edge function proxy needed.
 * Files starting with "_" are NOT deployed as functions by Netlify.
 */

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_URL     = 'https://api.anthropic.com/v1/messages';

const PRIMARY_MODEL  = 'claude-sonnet-4-6';
const FALLBACK_MODEL = 'claude-haiku-4-5';
const MAX_RETRIES    = 2;

const CATEGORIES = [
  'Grocery', 'Eating Out', 'Misc', 'Travel', 'Thakkali', 'Entertainment',
  'Investment', 'Car Payments', 'Utilities', 'Rent', 'Health', 'Furniture', 'Holiday', 'Wi-Fi',
];

const SYSTEM_PROMPT = `You are a receipt parser for a personal budget tracker. Extract structured data from receipt images and return ONLY valid JSON — no markdown, no explanation, no preamble.`;

function buildUserPrompt() {
  return `Extract data from this receipt image. Return EXACTLY this JSON structure:

{"store_name":"Store Name","purchase_date":"YYYY-MM-DD","total_amount":45.23,"tax_amount":3.50,"currency":"USD","items":[{"name":"Item name","amount":5.99}],"reward_category":"Grocery"}

Rules:
- store_name: The merchant/vendor name as shown on receipt
- purchase_date: Date in YYYY-MM-DD format. If unclear, use null
- total_amount: Final total including tax. Must be a positive number, no $ sign
- tax_amount: Tax amount if shown, else null
- currency: 3-letter ISO code visible on receipt (default "USD" if not shown)
- items: Array of line items with name and amount. Empty array [] if not legible
- reward_category: MUST be exactly one of: ${CATEGORIES.join(', ')}. Pick the closest match. Use "Misc" if none fit.

If the image is completely unreadable, return:
{"store_name":null,"purchase_date":null,"total_amount":null,"tax_amount":null,"currency":"USD","items":[],"reward_category":null}

Respond with ONLY the JSON object. No other text.`;
}

export function sanitizeExtraction(data) {
  if (!data || typeof data !== 'object') return data;
  const result = { ...data };

  if (typeof result.store_name === 'string') {
    result.store_name = safeString(result.store_name);
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

async function callClaude(model, base64, mediaType) {
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
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: [contentBlock, { type: 'text', text: buildUserPrompt() }],
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

  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON in Claude response');

  return JSON.parse(match[0]);
}

export async function extractReceipt(base64, mediaType) {
  let lastError;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const raw = await callClaude(PRIMARY_MODEL, base64, mediaType);
      return { ok: true, data: sanitizeExtraction(raw), model: PRIMARY_MODEL };
    } catch (e) {
      lastError = e;
      console.warn(`extractReceipt: ${PRIMARY_MODEL} attempt ${attempt + 1} failed:`, e.message);
    }
  }

  try {
    const raw = await callClaude(FALLBACK_MODEL, base64, mediaType);
    return { ok: true, data: sanitizeExtraction(raw), model: FALLBACK_MODEL };
  } catch (e) {
    console.error('extractReceipt: fallback failed:', e.message);
    return { ok: false, error: 'illegible', message: lastError?.message || e.message };
  }
}

export { CATEGORIES };
