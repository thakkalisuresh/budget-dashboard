import { CATEGORIES, fetchDetailRows, fuzzyNamesMatch, getAllCategoryNames } from './sheetsApi.js';

export const CLAUDE_URL = '/api/claude';
const MAX_PX     = 1600;
const JPEG_Q     = 0.85;
const MAX_PDF_MB = 5;

// ── FX cache ────────────────────────────────────────────────────────────────

const FX_CACHE_KEY = 'budget_fx_rate_cache';
const FX_CACHE_TTL = 24 * 60 * 60 * 1000;

const FX_PLAUSIBLE = {
  USD: [1, 1],
  EUR: [0.7, 1.5],
  GBP: [0.6, 1.3],
  CAD: [1.0, 2.0],
  AUD: [1.0, 2.5],
  JPY: [80, 200],
  INR: [60, 120],
  CHF: [0.7, 1.5],
  CNY: [5, 9],
  MXN: [15, 30],
  SGD: [1.1, 2.0],
};

export function loadFxCache(currency) {
  try {
    const raw = localStorage.getItem(FX_CACHE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    const entry = obj?.[currency];
    if (entry && Date.now() - entry.t < FX_CACHE_TTL) return entry.r;
  } catch { /* ignore */ }
  return null;
}

export function saveFxCache(currency, rate) {
  try {
    const raw = localStorage.getItem(FX_CACHE_KEY) || '{}';
    const obj = JSON.parse(raw);
    obj[currency] = { r: rate, t: Date.now() };
    localStorage.setItem(FX_CACHE_KEY, JSON.stringify(obj));
  } catch { /* ignore */ }
}

export function isPlausibleRate(currency, rate) {
  if (typeof rate !== 'number' || !isFinite(rate) || rate <= 0) return false;
  const bounds = FX_PLAUSIBLE[currency];
  if (!bounds) return rate > 0 && rate < 1e6;
  return rate >= bounds[0] && rate <= bounds[1];
}

// ── MIME validation via magic bytes ─────────────────────────────────────────

export async function detectMimeType(file) {
  const buf   = await file.slice(0, 12).arrayBuffer();
  const bytes = new Uint8Array(buf);
  const b     = (i) => bytes[i];

  if (b(0) === 0xFF && b(1) === 0xD8 && b(2) === 0xFF) return 'image/jpeg';
  if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4E && b(3) === 0x47) return 'image/png';
  if (b(0) === 0x47 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x38) return 'image/gif';
  if (b(0) === 0x25 && b(1) === 0x50 && b(2) === 0x44 && b(3) === 0x46) return 'application/pdf';
  if (b(0) === 0x52 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x46 &&
      b(8) === 0x57 && b(9) === 0x45 && b(10) === 0x42 && b(11) === 0x50) return 'image/webp';
  if (b(4) === 0x66 && b(5) === 0x74 && b(6) === 0x79 && b(7) === 0x70) return 'image/heic';
  return null;
}

export const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif', 'application/pdf',
]);

// ── Image helpers ───────────────────────────────────────────────────────────

export function compressImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, MAX_PX / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width  = Math.round(img.width  * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Compression failed')), 'image/jpeg', JPEG_Q);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not load image')); };
    img.src = url;
  });
}

export function toBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ── Claude API extraction ───────────────────────────────────────────────────

// Fuzzy-match a raw card string from Vision against the known cards list.
// Returns the canonical card name or '' if no confident match.
export function resolveCardName(raw, cards = []) {
  if (!raw || !cards.length) return '';
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const r = norm(raw);
  if (!r) return '';
  // Exact normalized match first
  for (const c of cards) if (norm(c) === r) return c;
  // Substring either direction (Vision may return "Sapphire Reserve" for "Chase Sapphire Reserve").
  // Guard with a min length so short names like "Cash" don't match "...activecash".
  for (const c of cards) {
    const nc = norm(c);
    if (nc.length >= 5 && r.length >= 5 && (nc.includes(r) || r.includes(nc))) return c;
  }
  return '';
}

export async function extractFromFile(file, accessToken, cards = []) {
  const detectedMime = await detectMimeType(file);
  if (!detectedMime || !ALLOWED_MIME_TYPES.has(detectedMime)) {
    throw new Error('Unsupported file type. Please upload an image or PDF.');
  }

  let blob = file;
  let mediaType = detectedMime;

  if (detectedMime === 'application/pdf') {
    if (file.size > MAX_PDF_MB * 1024 * 1024) {
      throw new Error(`PDF is too large (max ${MAX_PDF_MB} MB). Try a screenshot instead.`);
    }
  } else {
    blob      = await compressImage(file);
    mediaType = 'image/jpeg';
  }

  const base64 = await toBase64(blob);
  const contentBlock = file.type === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
    : { type: 'image',    source: { type: 'base64', media_type: mediaType,          data: base64 } };

  const cardHint = cards.length
    ? `\nKnown payment cards (match the visible card to the closest name from this list, return the matched name EXACTLY): ${cards.join(', ')}.`
    : '';

  const prompt = `You are a financial document parser. Analyse this image and determine if it is:
1. A RECEIPT — a single-vendor purchase document (grocery receipt, restaurant bill, invoice)
2. A BANK STATEMENT or transaction list — multiple rows of transactions from different merchants

If it is a RECEIPT, return exactly this JSON:
{"type":"receipt","vendor":"Store Name","amount":45.23,"category":"Grocery","currency":"USD","paymentMethod":"Chase Sapphire Reserve","items":[{"name":"Item name","amount":5.99,"item_category":"Grocery"}]}

If it is a BANK STATEMENT or transaction list, return exactly this JSON:
{"type":"statement","paymentMethod":"Chase Sapphire Reserve","transactions":[
  {"vendor":"Merchant Name","amount":12.34,"category":"Grocery","date":"04/27/2026","txType":"debit"},
  {"vendor":"Another Store","amount":56.78,"category":"Shopping","date":"04/26/2026","txType":"debit"}
]}

Categories to use (pick the closest match): ${CATEGORIES.join(', ')}
${cardHint}

Rules:
- RECEIPT: amount is the final total including tax. currency is the 3-letter ISO code visible on the receipt (e.g. USD, CAD, EUR, GBP). Default to USD if not shown.
- RECEIPT items: list each line item as {name, amount, item_category}. item_category is your best guess of that single item's budget category (one of the categories above), or null if ambiguous (e.g. clothing/electronics). Use [] if the receipt has no itemized lines. This lets mixed receipts (e.g. Costco) be split by category.
- STATEMENT: include ONLY debit/purchase transactions where money left the account. For each transaction set txType to "debit" or "credit".
- CRITICAL: If a transaction has a negative amount, a minus sign, is shown in red, or is labeled as refund/credit/return/reversal/payment, set txType to "credit". Do NOT include credits in the results.
- Clean up truncated bank merchant names (e.g. "SEATTLEYELLOWCA HOLD" → "Seattle Yellow Cab", "WF SUPERMARKET" → "Whole Foods")
- amount must be a positive number with no $ sign, or null if unclear
- category must be exactly one value from the list, or null if none fit
- date: use the date shown in the statement as-is, or null if not visible
- paymentMethod: if this is an Apple Wallet / mobile wallet screenshot, the card name appears prominently near the top — extract it. For statements, use the card/account shown in the header. Match to the known cards list when one is provided. Use null if no card is visible.
- If the image is unreadable, return {"type":"receipt","vendor":null,"amount":null,"category":null,"currency":"USD","paymentMethod":null,"items":[]}
- Respond with ONLY valid JSON — no extra text`;

  const headers = { 'content-type': 'application/json' };
  if (accessToken) headers['authorization'] = `Bearer ${accessToken}`;
  const res = await fetch(CLAUDE_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 1024,
      stream: true,
      messages: [{ role: 'user', content: [contentBlock, { type: 'text', text: prompt }] }],
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    console.error('Anthropic API error:', JSON.stringify(err));
    throw new Error(err?.error?.message || JSON.stringify(err));
  }

  const reader  = res.body.getReader();
  const decoder = new TextDecoder();
  let fullText  = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    for (const line of chunk.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;
      try {
        const parsed = JSON.parse(data);
        if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
          fullText += parsed.delta.text;
        }
      } catch { /* skip malformed lines */ }
    }
  }

  try {
    const match = fullText.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
  } catch { /* fall through */ }

  return { type: 'receipt', vendor: null, amount: null, category: null, paymentMethod: null };
}

// ── Transaction helpers ─────────────────────────────────────────────────────

export function validateCategories(transactions) {
  const valid = new Set(CATEGORIES);
  return transactions.map(t => ({
    ...t,
    category: valid.has(t.category) ? t.category : 'Misc',
  }));
}

export async function checkDuplicates(transactions, accessToken, sheetId, allCategories = [], monthName) {
  const liveCategories = getAllCategoryNames();

  const categoriesToFetch = [...new Set([
    ...transactions.map(t => t.category).filter(Boolean),
    ...allCategories,
    ...liveCategories,
  ])];

  const existingMap = {};
  await Promise.all(categoriesToFetch.map(async (cat) => {
    try {
      const rows = await fetchDetailRows(cat, accessToken, sheetId, monthName);
      existingMap[cat] = rows;
    } catch { existingMap[cat] = []; }
  }));

  return transactions.map(t => {
    let isDuplicate = false;
    let matchedCategory = null;

    for (const [cat, rows] of Object.entries(existingMap)) {
      const found = rows.some(row => {
        const amountMatch = row.amounts?.some(a => Math.abs(a - t.amount) < 0.05);
        if (!amountMatch) return false;
        return fuzzyNamesMatch(row.description, t.vendor);
      });
      if (found) { isDuplicate = true; matchedCategory = cat; break; }
    }

    return {
      ...t,
      category: matchedCategory || t.category,
      selected: !isDuplicate,
      isDuplicate,
    };
  });
}
