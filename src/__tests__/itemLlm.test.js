import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { categorizeItemsBatch, sanitizeItemInput, MAX_ITEMS, MAX_EXAMPLES } from '../../functions/lib/_item-llm.mjs';

const CATEGORIES = ['Grocery', 'Misc', 'Health', 'Eating Out'];

/** A Groq-shaped success response wrapping `results`. */
const groqOk = (results) => ({
  ok: true,
  json: async () => ({ choices: [{ message: { content: JSON.stringify({ results }) } }] }),
});

describe('sanitizeItemInput', () => {
  it('caps the item list rather than sending an unbounded prompt', () => {
    const items = Array.from({ length: MAX_ITEMS + 20 }, (_, i) => `ITEM ${i}`);
    expect(sanitizeItemInput({ items, categories: CATEGORIES }).items).toHaveLength(MAX_ITEMS);
  });

  it('caps the few-shot examples too', () => {
    const examples = Array.from({ length: MAX_EXAMPLES + 5 }, (_, i) => ({ name: `E${i}`, category: 'Grocery' }));
    expect(sanitizeItemInput({ items: ['A'], categories: CATEGORIES, examples }).examples).toHaveLength(MAX_EXAMPLES);
  });

  it('drops blank and malformed entries', () => {
    const clean = sanitizeItemInput({
      items: ['MILK', '  ', null, 'EGGS'],
      categories: ['Grocery', '', null],
      examples: [{ name: 'X', category: 'Grocery' }, { name: 'Y' }, null],
    });
    expect(clean.items).toEqual(['MILK', 'EGGS']);
    expect(clean.categories).toEqual(['Grocery']);
    expect(clean.examples).toEqual([{ name: 'X', category: 'Grocery' }]);
  });
});

describe('categorizeItemsBatch', () => {
  const OLD_KEY = process.env.GROQ_API_KEY;
  beforeEach(() => { process.env.GROQ_API_KEY = 'test-key'; });
  afterEach(() => {
    if (OLD_KEY === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = OLD_KEY;
    vi.restoreAllMocks();
  });

  it('maps answers back onto the items by index', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(groqOk([
      { i: 0, category: 'Grocery', confidence: 0.9 },
      { i: 1, category: 'Misc', confidence: 0.6 },
    ]));
    const { results } = await categorizeItemsBatch({
      vendor: 'Costco', items: ['MILK', 'ZX9'], categories: CATEGORIES, fetchImpl,
    });
    expect(results).toEqual([
      { category: 'Grocery', confidence: 0.9 },
      { category: 'Misc', confidence: 0.6 },
    ]);
  });

  it('sends ONE request for the whole receipt', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(groqOk([]));
    await categorizeItemsBatch({
      vendor: 'Costco',
      items: Array.from({ length: 40 }, (_, i) => `ITEM ${i}`),
      categories: CATEGORIES, fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('puts the shopper\'s own past filings in the prompt', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(groqOk([]));
    await categorizeItemsBatch({
      vendor: 'Costco', items: ['ZX9'], categories: CATEGORIES,
      examples: [{ name: 'PAPER TOWELS', category: 'Misc' }], fetchImpl,
    });
    const prompt = JSON.parse(fetchImpl.mock.calls[0][1].body).messages[1].content;
    expect(prompt).toContain('PAPER TOWELS → Misc');
    expect(prompt).toContain('follow their habits');
  });

  it('discards a category that is not one of the sheet tabs', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(groqOk([
      { i: 0, category: 'Pets', confidence: 0.99 },
    ]));
    const { results } = await categorizeItemsBatch({ vendor: 'Costco', items: ['DOG FOOD'], categories: CATEGORIES, fetchImpl });
    // A category with no tab would fail the write — better to ask.
    expect(results).toEqual([null]);
  });

  it('ignores out-of-range indexes instead of shifting answers onto wrong items', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(groqOk([
      { i: 5, category: 'Grocery', confidence: 0.9 },
      { i: 0, category: 'Health', confidence: 0.9 },
    ]));
    const { results } = await categorizeItemsBatch({ vendor: 'Costco', items: ['A', 'B'], categories: CATEGORIES, fetchImpl });
    expect(results).toEqual([{ category: 'Health', confidence: 0.9 }, null]);
  });

  it('returns nulls, not an error, when Groq is down', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    const { results, reason } = await categorizeItemsBatch({ vendor: 'Costco', items: ['A', 'B'], categories: CATEGORIES, fetchImpl });
    expect(results).toEqual([null, null]);
    expect(reason).toBe('llm-error');
  });

  it('returns nulls when the network throws', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('socket hang up'));
    const { results } = await categorizeItemsBatch({ vendor: 'Costco', items: ['A'], categories: CATEGORIES, fetchImpl });
    expect(results).toEqual([null]);
  });

  it('returns nulls on unparseable JSON rather than throwing into the caller', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ choices: [{ message: { content: 'not json' } }] }),
    });
    const { results } = await categorizeItemsBatch({ vendor: 'Costco', items: ['A'], categories: CATEGORIES, fetchImpl });
    expect(results).toEqual([null]);
  });

  it('never calls Groq when the key is missing', async () => {
    delete process.env.GROQ_API_KEY;
    const fetchImpl = vi.fn();
    const { results, reason } = await categorizeItemsBatch({ vendor: 'Costco', items: ['A'], categories: CATEGORIES, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(results).toEqual([null]);
    expect(reason).toBe('unavailable');
  });
});
