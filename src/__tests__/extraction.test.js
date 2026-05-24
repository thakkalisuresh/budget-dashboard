import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.stubEnv('ANTHROPIC_API_KEY', 'test-api-key');

const mockFetch = vi.fn();
global.fetch = mockFetch;

const { sanitizeExtraction, extractReceipt, CATEGORIES } = await import('../../netlify/functions/_extraction.mjs');

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

  it('returns extracted data on first try (primary model)', async () => {
    mockFetch.mockResolvedValueOnce(claudeResponse(validJson));
    const result = await extractReceipt('base64data', 'image/jpeg');
    expect(result.ok).toBe(true);
    expect(result.data.store_name).toBe('Target');
    expect(result.data.total_amount).toBe(67.89);
    expect(result.model).toBe('claude-sonnet-4-6');
  });

  it('retries primary model up to 2 times then succeeds', async () => {
    mockFetch
      .mockResolvedValueOnce(errorResponse('overloaded', 529))
      .mockResolvedValueOnce(errorResponse('overloaded', 529))
      .mockResolvedValueOnce(claudeResponse(validJson));
    const result = await extractReceipt('base64data', 'image/jpeg');
    expect(result.ok).toBe(true);
    expect(result.model).toBe('claude-sonnet-4-6');
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('falls back to haiku after primary exhausts retries', async () => {
    mockFetch
      .mockResolvedValueOnce(errorResponse('overloaded', 529))
      .mockResolvedValueOnce(errorResponse('overloaded', 529))
      .mockResolvedValueOnce(errorResponse('overloaded', 529))
      .mockResolvedValueOnce(claudeResponse(validJson));
    const result = await extractReceipt('base64data', 'image/jpeg');
    expect(result.ok).toBe(true);
    expect(result.model).toBe('claude-haiku-4-5');
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it('returns error when both models fail', async () => {
    mockFetch.mockResolvedValue(errorResponse('service down', 500));
    const result = await extractReceipt('base64data', 'image/jpeg');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('illegible');
  });

  it('sends correct content block for PDF', async () => {
    mockFetch.mockResolvedValueOnce(claudeResponse(validJson));
    await extractReceipt('pdfbase64', 'application/pdf');
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const contentBlock = body.messages[0].content[0];
    expect(contentBlock.type).toBe('document');
    expect(contentBlock.source.media_type).toBe('application/pdf');
  });

  it('sends correct content block for images', async () => {
    mockFetch.mockResolvedValueOnce(claudeResponse(validJson));
    await extractReceipt('imgbase64', 'image/png');
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const contentBlock = body.messages[0].content[0];
    expect(contentBlock.type).toBe('image');
    expect(contentBlock.source.media_type).toBe('image/png');
  });

  it('sanitizes extraction output', async () => {
    const malicious = JSON.stringify({
      store_name: '=IMPORTRANGE("url","Sheet1!A1")',
      total_amount: -50,
      reward_category: 'FakeCategory',
      items: [{ name: '+cmd', amount: -10 }],
    });
    mockFetch.mockResolvedValueOnce(claudeResponse(malicious));
    const result = await extractReceipt('base64data', 'image/jpeg');
    expect(result.ok).toBe(true);
    expect(result.data.store_name.startsWith("'")).toBe(true);
    expect(result.data.total_amount).toBe(50);
    expect(result.data.reward_category).toBe('Misc');
    expect(result.data.items[0].name).toBe("'+cmd");
    expect(result.data.items[0].amount).toBe(10);
  });

  it('handles Claude returning non-JSON', async () => {
    mockFetch
      .mockResolvedValueOnce(claudeResponse('I cannot read this receipt, sorry.'))
      .mockResolvedValueOnce(claudeResponse('Still unclear'))
      .mockResolvedValueOnce(claudeResponse('No luck'))
      .mockResolvedValueOnce(claudeResponse('Cannot parse'));
    const result = await extractReceipt('base64data', 'image/jpeg');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('illegible');
  });
});
