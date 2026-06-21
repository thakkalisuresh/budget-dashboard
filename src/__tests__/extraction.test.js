import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.stubEnv('GEMINI_API_KEY', 'test-gemini-key');
vi.stubEnv('ANTHROPIC_API_KEY', 'test-anthropic-key');

const mockFetch = vi.fn();
global.fetch = mockFetch;

const { sanitizeExtraction, extractReceipt, CATEGORIES } = await import('../../functions/lib/_extraction.mjs');

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
      items: [{ name: 'Bananas', amount: 2.99 }],
      reward_category: 'Grocery',
      is_transfer: false,
    };
    const result = sanitizeExtraction(input);
    expect(result).toEqual(input);
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

  it('returns extracted data on first try (gemini-2.0-flash)', async () => {
    mockFetch.mockResolvedValueOnce(geminiResponse(validJson));
    const result = await extractReceipt('base64data', 'image/jpeg');
    expect(result.ok).toBe(true);
    expect(result.data.store_name).toBe('Target');
    expect(result.data.total_amount).toBe(67.89);
    expect(result.model).toBe('gemini-2.0-flash');
  });

  it('retries gemini-2.0-flash up to 2 times then succeeds', async () => {
    mockFetch
      .mockResolvedValueOnce(errorResponse('overloaded', 529))
      .mockResolvedValueOnce(errorResponse('overloaded', 529))
      .mockResolvedValueOnce(geminiResponse(validJson));
    const result = await extractReceipt('base64data', 'image/jpeg');
    expect(result.ok).toBe(true);
    expect(result.model).toBe('gemini-2.0-flash');
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('falls back to gemini-1.5-pro after primary exhausts retries', async () => {
    mockFetch
      .mockResolvedValueOnce(errorResponse('overloaded', 529))
      .mockResolvedValueOnce(errorResponse('overloaded', 529))
      .mockResolvedValueOnce(errorResponse('overloaded', 529))
      .mockResolvedValueOnce(geminiResponse(validJson));
    const result = await extractReceipt('base64data', 'image/jpeg');
    expect(result.ok).toBe(true);
    expect(result.model).toBe('gemini-1.5-pro');
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it('falls back to gemini-2.5-pro when earlier Gemini models fail', async () => {
    mockFetch
      .mockResolvedValueOnce(errorResponse('fail', 500))
      .mockResolvedValueOnce(errorResponse('fail', 500))
      .mockResolvedValueOnce(errorResponse('fail', 500))
      .mockResolvedValueOnce(errorResponse('fail', 500))
      .mockResolvedValueOnce(geminiResponse(validJson));
    const result = await extractReceipt('base64data', 'image/jpeg');
    expect(result.ok).toBe(true);
    expect(result.model).toBe('gemini-2.5-pro');
    expect(mockFetch).toHaveBeenCalledTimes(5);
  });

  it('falls back to Claude sonnet when all Gemini models fail', async () => {
    // 3 Flash retries + 1.5-pro + 2.5-pro = 5 fails, then Claude sonnet succeeds
    mockFetch
      .mockResolvedValueOnce(errorResponse('fail', 500))
      .mockResolvedValueOnce(errorResponse('fail', 500))
      .mockResolvedValueOnce(errorResponse('fail', 500))
      .mockResolvedValueOnce(errorResponse('fail', 500))
      .mockResolvedValueOnce(errorResponse('fail', 500))
      .mockResolvedValueOnce(claudeResponse(validJson));
    const result = await extractReceipt('base64data', 'image/jpeg');
    expect(result.ok).toBe(true);
    expect(result.model).toBe('claude-sonnet-4-6');
    expect(mockFetch).toHaveBeenCalledTimes(6);
  });

  it('falls back to Claude haiku as last resort', async () => {
    // 5 Gemini fails + Claude sonnet fail + Claude haiku succeeds
    mockFetch
      .mockResolvedValueOnce(errorResponse('fail', 500))
      .mockResolvedValueOnce(errorResponse('fail', 500))
      .mockResolvedValueOnce(errorResponse('fail', 500))
      .mockResolvedValueOnce(errorResponse('fail', 500))
      .mockResolvedValueOnce(errorResponse('fail', 500))
      .mockResolvedValueOnce(errorResponse('fail', 500))
      .mockResolvedValueOnce(claudeResponse(validJson));
    const result = await extractReceipt('base64data', 'image/jpeg');
    expect(result.ok).toBe(true);
    expect(result.model).toBe('claude-haiku-4-5');
    expect(mockFetch).toHaveBeenCalledTimes(7);
  });

  it('returns error when all models fail', async () => {
    mockFetch.mockResolvedValue(errorResponse('service down', 500));
    const result = await extractReceipt('base64data', 'image/jpeg');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('illegible');
    // 3 Flash retries + 1.5-pro + 2.5-pro + sonnet + haiku = 7 calls
    expect(mockFetch).toHaveBeenCalledTimes(7);
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
    // All 7 models return non-JSON text
    mockFetch
      .mockResolvedValueOnce(geminiResponse('I cannot read this'))
      .mockResolvedValueOnce(geminiResponse('Still unclear'))
      .mockResolvedValueOnce(geminiResponse('No luck'))
      .mockResolvedValueOnce(geminiResponse('Cannot parse'))
      .mockResolvedValueOnce(geminiResponse('Unreadable'))
      .mockResolvedValueOnce(claudeResponse('Sorry'))
      .mockResolvedValueOnce(claudeResponse('Unable to process'));
    const result = await extractReceipt('base64data', 'image/jpeg');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('illegible');
  });
});
