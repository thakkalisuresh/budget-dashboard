import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.stubEnv('GEMINI_API_KEY', 'test-gemini-key');
vi.stubEnv('ANTHROPIC_API_KEY', 'test-anthropic-key');

const mockFetch = vi.fn();
global.fetch = mockFetch;

const { sanitizeExtraction, extractReceipt, CATEGORIES, normalizePurchaseDate, repairPurchaseYear } = await import('../../functions/lib/_extraction.mjs');

/* ── Response helpers ── */

function geminiResponse(text, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve({
      candidates: [{ content: { parts: [{ text }] } }],
    }),
  };
}

function claudeResponse(text, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve({ content: [{ type: 'text', text }] }),
  };
}

function errorResponse(message, status = 500) {
  return {
    ok: false,
    status,
    json: () => Promise.resolve({ error: { message } }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

/* ── sanitizeExtraction (unchanged) ── */

describe('sanitizeExtraction', () => {
  it('passes through valid data unchanged', () => {
    const input = {
      store_name: 'Walmart',
      purchase_date: '2026-05-20',
      total_amount: 45.23,
      tax_amount: 3.50,
      currency: 'USD',
      items: [{ name: 'Bananas', amount: 2.99, item_category: 'Grocery' }],
      reward_category: 'Grocery',
      is_transfer: false,
    };
    const result = sanitizeExtraction(input);
    expect(result).toEqual(input);
  });

  it('normalizes a missing/invalid per-item category to null', () => {
    const result = sanitizeExtraction({
      store_name: 'Costco',
      total_amount: 50,
      currency: 'USD',
      items: [
        { name: 'Milk', amount: 3.99 },                              // no hint → null
        { name: 'Mystery', amount: 9.99, item_category: 'NotReal' }, // invalid → null
        { name: 'Shirt', amount: 12.0, item_category: 'Misc' },      // valid → kept
      ],
      reward_category: 'Grocery',
      is_transfer: false,
    });
    expect(result.items[0].item_category).toBe(null);
    expect(result.items[1].item_category).toBe(null);
    expect(result.items[2].item_category).toBe('Misc');
  });

  it('sanitizes formula injection in store_name', () => {
    const result = sanitizeExtraction({ store_name: '=CMD()', reward_category: 'Misc' });
    expect(result.store_name).toBe("'=CMD()");
  });

  it('sanitizes formula injection with leading space', () => {
    const result = sanitizeExtraction({ store_name: ' +malicious', reward_category: 'Misc' });
    expect(result.store_name).toBe("' +malicious");
  });

  it('sanitizes item names', () => {
    const result = sanitizeExtraction({
      store_name: 'Store',
      items: [{ name: '@SUM(A1)', amount: 5 }],
      reward_category: 'Grocery',
    });
    expect(result.items[0].name).toBe("'@SUM(A1)");
  });

  it('forces total_amount to positive', () => {
    const result = sanitizeExtraction({ total_amount: -25.50, reward_category: 'Misc' });
    expect(result.total_amount).toBe(25.50);
  });

  it('forces item amounts to positive', () => {
    const result = sanitizeExtraction({
      items: [{ name: 'Refund', amount: -10 }],
      reward_category: 'Misc',
    });
    expect(result.items[0].amount).toBe(10);
  });

  it('replaces invalid category with Misc', () => {
    const result = sanitizeExtraction({ reward_category: 'InvalidCategory' });
    expect(result.reward_category).toBe('Misc');
  });

  it('accepts all valid categories', () => {
    for (const cat of CATEGORIES) {
      const result = sanitizeExtraction({ reward_category: cat });
      expect(result.reward_category).toBe(cat);
    }
  });

  it('handles null/undefined input gracefully', () => {
    expect(sanitizeExtraction(null)).toBe(null);
    expect(sanitizeExtraction(undefined)).toBe(undefined);
  });
});

/* ── extractReceipt with Gemini primary + Claude fallback ── */

describe('extractReceipt', () => {
  const validJson = JSON.stringify({
    store_name: 'Target',
    purchase_date: '2026-05-20',
    total_amount: 67.89,
    tax_amount: 5.12,
    currency: 'USD',
    items: [{ name: 'Shirt', amount: 29.99 }],
    reward_category: 'Misc',
  });

  it('returns extracted data on first try (gemini-2.5-flash)', async () => {
    mockFetch.mockResolvedValueOnce(geminiResponse(validJson));
    const result = await extractReceipt('base64data', 'image/jpeg');
    expect(result.ok).toBe(true);
    expect(result.data.store_name).toBe('Target');
    expect(result.data.total_amount).toBe(67.89);
    expect(result.model).toBe('gemini-2.5-flash');
  });

  it('retries gemini-2.5-flash up to 2 times then succeeds', async () => {
    mockFetch
      .mockResolvedValueOnce(errorResponse('overloaded', 529))
      .mockResolvedValueOnce(errorResponse('overloaded', 529))
      .mockResolvedValueOnce(geminiResponse(validJson));
    const result = await extractReceipt('base64data', 'image/jpeg');
    expect(result.ok).toBe(true);
    expect(result.model).toBe('gemini-2.5-flash');
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('falls back to gemini-2.5-pro after primary exhausts retries', async () => {
    // 3 Flash attempts fail, then 2.5-pro succeeds
    mockFetch
      .mockResolvedValueOnce(errorResponse('overloaded', 529))
      .mockResolvedValueOnce(errorResponse('overloaded', 529))
      .mockResolvedValueOnce(errorResponse('overloaded', 529))
      .mockResolvedValueOnce(geminiResponse(validJson));
    const result = await extractReceipt('base64data', 'image/jpeg');
    expect(result.ok).toBe(true);
    expect(result.model).toBe('gemini-2.5-pro');
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it('falls back to Claude sonnet when all Gemini models fail', async () => {
    // 3 Flash retries + 2.5-pro = 4 fails, then Claude sonnet succeeds
    mockFetch
      .mockResolvedValueOnce(errorResponse('fail', 500))
      .mockResolvedValueOnce(errorResponse('fail', 500))
      .mockResolvedValueOnce(errorResponse('fail', 500))
      .mockResolvedValueOnce(errorResponse('fail', 500))
      .mockResolvedValueOnce(claudeResponse(validJson));
    const result = await extractReceipt('base64data', 'image/jpeg');
    expect(result.ok).toBe(true);
    expect(result.model).toBe('claude-sonnet-4-6');
    expect(mockFetch).toHaveBeenCalledTimes(5);
  });

  it('falls back to Claude haiku as last resort', async () => {
    // 4 Gemini fails + Claude sonnet fail + Claude haiku succeeds
    mockFetch
      .mockResolvedValueOnce(errorResponse('fail', 500))
      .mockResolvedValueOnce(errorResponse('fail', 500))
      .mockResolvedValueOnce(errorResponse('fail', 500))
      .mockResolvedValueOnce(errorResponse('fail', 500))
      .mockResolvedValueOnce(errorResponse('fail', 500))
      .mockResolvedValueOnce(claudeResponse(validJson));
    const result = await extractReceipt('base64data', 'image/jpeg');
    expect(result.ok).toBe(true);
    expect(result.model).toBe('claude-haiku-4-5');
    expect(mockFetch).toHaveBeenCalledTimes(6);
  });

  it('returns error when all models fail', async () => {
    mockFetch.mockResolvedValue(errorResponse('service down', 500));
    const result = await extractReceipt('base64data', 'image/jpeg');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('illegible');
    // 3 Flash retries + 2.5-pro + sonnet + haiku = 6 calls
    expect(mockFetch).toHaveBeenCalledTimes(6);
  });

  it('sends correct Gemini inline_data for images', async () => {
    mockFetch.mockResolvedValueOnce(geminiResponse(validJson));
    await extractReceipt('imgbase64', 'image/png');
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const inlineData = body.contents[0].parts[0].inline_data;
    expect(inlineData.mime_type).toBe('image/png');
    expect(inlineData.data).toBe('imgbase64');
  });

  it('sends correct Gemini inline_data for PDF', async () => {
    mockFetch.mockResolvedValueOnce(geminiResponse(validJson));
    await extractReceipt('pdfbase64', 'application/pdf');
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const inlineData = body.contents[0].parts[0].inline_data;
    expect(inlineData.mime_type).toBe('application/pdf');
    expect(inlineData.data).toBe('pdfbase64');
  });

  it('requests JSON response mode from Gemini', async () => {
    mockFetch.mockResolvedValueOnce(geminiResponse(validJson));
    await extractReceipt('base64data', 'image/jpeg');
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.generationConfig.responseMimeType).toBe('application/json');
  });

  it('sanitizes extraction output', async () => {
    const malicious = JSON.stringify({
      store_name: '=IMPORTRANGE("url","Sheet1!A1")',
      total_amount: -50,
      reward_category: 'FakeCategory',
      items: [{ name: '+cmd', amount: -10 }],
    });
    mockFetch.mockResolvedValueOnce(geminiResponse(malicious));
    const result = await extractReceipt('base64data', 'image/jpeg');
    expect(result.ok).toBe(true);
    expect(result.data.store_name.startsWith("'")).toBe(true);
    expect(result.data.total_amount).toBe(50);
    expect(result.data.reward_category).toBe('Misc');
    expect(result.data.items[0].name).toBe("'+cmd");
    expect(result.data.items[0].amount).toBe(10);
  });

  it('handles non-JSON responses from all models', async () => {
    // All 6 models return non-JSON text (3 Flash + 2.5-pro + sonnet + haiku)
    mockFetch
      .mockResolvedValueOnce(geminiResponse('I cannot read this'))
      .mockResolvedValueOnce(geminiResponse('Still unclear'))
      .mockResolvedValueOnce(geminiResponse('No luck'))
      .mockResolvedValueOnce(geminiResponse('Cannot parse'))
      .mockResolvedValueOnce(claudeResponse('Sorry'))
      .mockResolvedValueOnce(claudeResponse('Unable to process'));
    const result = await extractReceipt('base64data', 'image/jpeg');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('illegible');
  });
});

describe('repairPurchaseYear — Amex BCP statement year guard', () => {
  const TODAY = '2026-07-25';

  it('remaps a stale model-invented year to the current year', async () => {
    const { repairPurchaseYear } = await import('../../functions/lib/_extraction.mjs');
    // The reported bug: Amex prints "01/05", model emits 2024.
    expect(repairPurchaseYear('2024-01-05', TODAY)).toBe('2026-01-05');
  });

  it('falls back to last year when this year would still be in the future', async () => {
    const { repairPurchaseYear } = await import('../../functions/lib/_extraction.mjs');
    // A December statement opened in July: 2026-12-14 is future → 2025-12-14.
    expect(repairPurchaseYear('2024-12-14', TODAY)).toBe('2025-12-14');
  });

  it('rewrites a future date back to the most recent past occurrence', async () => {
    const { repairPurchaseYear } = await import('../../functions/lib/_extraction.mjs');
    expect(repairPurchaseYear('2027-03-02', TODAY)).toBe('2026-03-02');
  });

  it('preserves a plausible printed year', async () => {
    const { repairPurchaseYear } = await import('../../functions/lib/_extraction.mjs');
    expect(repairPurchaseYear('2026-07-01', TODAY)).toBe('2026-07-01');
    expect(repairPurchaseYear('2025-11-30', TODAY)).toBe('2025-11-30'); // currentYear-1 is allowed
  });

  it('allows today and tolerates small clock skew', async () => {
    const { repairPurchaseYear } = await import('../../functions/lib/_extraction.mjs');
    expect(repairPurchaseYear('2026-07-25', TODAY)).toBe('2026-07-25');
    expect(repairPurchaseYear('2026-07-26', TODAY)).toBe('2026-07-26');
  });

  it('leaves malformed or non-string values untouched', async () => {
    const { repairPurchaseYear } = await import('../../functions/lib/_extraction.mjs');
    expect(repairPurchaseYear('not-a-date', TODAY)).toBe('not-a-date');
    expect(repairPurchaseYear(null, TODAY)).toBe(null);
    expect(repairPurchaseYear(undefined, TODAY)).toBe(undefined);
  });

  it('sanitizeExtraction applies the guard to purchase_date', async () => {
    const { sanitizeExtraction } = await import('../../functions/lib/_extraction.mjs');
    const out = sanitizeExtraction({ purchase_date: '2019-02-10', total_amount: 12 });
    expect(out.purchase_date.startsWith('2019')).toBe(false);
    expect(out.purchase_date.slice(5)).toBe('02-10');
  });
});

/* ── Date normalization: the gap that let a stale year reach the sheet ── */

describe('normalizePurchaseDate', () => {
  it('passes strict ISO through untouched', () => {
    expect(normalizePurchaseDate('2026-07-15')).toBe('2026-07-15');
  });

  it('pads sloppy ISO', () => {
    expect(normalizePurchaseDate('2024-7-5')).toBe('2024-07-05');
  });

  it('reads US slash and dash order', () => {
    expect(normalizePurchaseDate('07/15/2024')).toBe('2024-07-15');
    expect(normalizePurchaseDate('7/5/2024')).toBe('2024-07-05');
    expect(normalizePurchaseDate('07-15-2024')).toBe('2024-07-15');
  });

  it('expands a two-digit year', () => {
    expect(normalizePurchaseDate('7/5/24')).toBe('2024-07-05');
  });

  it('keeps the date half of a timestamp', () => {
    expect(normalizePurchaseDate('2024-07-15T10:30:00Z')).toBe('2024-07-15');
  });

  it('reads long form', () => {
    expect(normalizePurchaseDate('July 15, 2024')).toBe('2024-07-15');
  });

  it('returns unreadable input untouched rather than guessing', () => {
    // A wrong date silently written to a budget is worse than one that fails loudly.
    expect(normalizePurchaseDate('not a date')).toBe('not a date');
    expect(normalizePurchaseDate('13/45/2024')).toBe('13/45/2024');
    expect(normalizePurchaseDate('')).toBe('');
    expect(normalizePurchaseDate(null)).toBeNull();
  });
});

describe('normalization + year repair together', () => {
  const today = '2026-07-29';

  it('repairs a stale year in a NON-ISO date — the case that reached production', () => {
    // A real receipt on 2026-07-29 produced "July 2024" and failed with SHT-002:
    // repairPurchaseYear only matched strict ISO, so this bypassed it entirely.
    expect(repairPurchaseYear(normalizePurchaseDate('07/15/2024'), today)).toBe('2026-07-15');
  });

  it('repairs every format the model realistically emits', () => {
    for (const raw of ['2024-07-15', '07/15/2024', '7/15/24', '2024-7-15', 'July 15, 2024']) {
      expect(repairPurchaseYear(normalizePurchaseDate(raw), today), `failed on ${raw}`)
        .toBe('2026-07-15');
    }
  });

  it('leaves a plausible current-year date alone', () => {
    expect(repairPurchaseYear(normalizePurchaseDate('07/15/2026'), today)).toBe('2026-07-15');
  });

  it('sanitizeExtraction applies both', () => {
    const out = sanitizeExtraction({ purchase_date: '07/15/2024', total_amount: 10 });
    expect(out.purchase_date).toBe('2026-07-15');
  });
});
