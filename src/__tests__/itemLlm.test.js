import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// reportGroqFailure routes a dead/unknown model to the daily digest via
// _error-log; mock it so the item path's digest wiring can be asserted without
// pulling in firebase-admin.
const reportError = vi.fn(() => Promise.resolve());
vi.mock('../../functions/lib/_error-log.mjs', () => ({ reportError: (...a) => reportError(...a) }));

import { categorizeItemsBatch, sanitizeItemInput, MAX_ITEMS, MAX_EXAMPLES } from '../../functions/lib/_item-llm.mjs';
import { GROQ_TEXT_MODEL, __resetGroqReports } from '../../functions/lib/_groq.mjs';

const CATEGORIES = ['Grocery', 'Misc', 'Health', 'Eating Out'];

// The model id Groq retired (the Sept outages). The item path must never send it.
const RETIRED_MODEL = 'llama-3.3-70b-versatile';

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

// LANDMINE GUARD: _item-llm.mjs used to hardcode the retired llama-3.3-70b model
// and had no reasoning_effort, so merged as-is the item step failed 100% and a
// naive model swap returned empty content. These pin the shared reasoning-model
// request shape and the digest wiring. Each FAILS against the old code: the
// model/reasoning_effort assertions fail on the retired id + missing param, and
// the LLM-004 assertion fails because the old catch only console.warn'd.
describe('item categorizer uses the shared reasoning model (landmine guard)', () => {
  const OLD_KEY = process.env.GROQ_API_KEY;
  beforeEach(() => {
    process.env.GROQ_API_KEY = 'test-key';
    reportError.mockClear();
    __resetGroqReports();
  });
  afterEach(() => {
    if (OLD_KEY === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = OLD_KEY;
    vi.restoreAllMocks();
  });

  it('sends GROQ_TEXT_MODEL with reasoning_effort:low — never the retired hardcoded id', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(groqOk([]));
    await categorizeItemsBatch({ vendor: 'Costco', items: ['A'], categories: CATEGORIES, fetchImpl });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.model).toBe(GROQ_TEXT_MODEL);
    expect(body.model).not.toBe(RETIRED_MODEL);
    // gpt-oss-120b returns empty content without this — the naive-swap trap.
    expect(body.reasoning_effort).toBe('low');
    // Reasoning tokens count against the budget; a small base starved content.
    expect(body.max_tokens ?? body.max_completion_tokens).toBeGreaterThanOrEqual(512);
  });

  it('reports a retired/unknown model to the digest as LLM-004 instead of failing silently', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: { message: `The model \`${RETIRED_MODEL}\` does not exist`, code: 'model_not_found' } }),
    });
    const { results, reason } = await categorizeItemsBatch({ vendor: 'Costco', items: ['A'], categories: CATEGORIES, fetchImpl });
    expect(results).toEqual([null]);
    expect(reason).toBe('llm-error');
    const calls = reportError.mock.calls.filter(c => c[0] === 'LLM-004');
    expect(calls).toHaveLength(1);
    expect(calls[0][1].message).toContain(GROQ_TEXT_MODEL);
  });
});
