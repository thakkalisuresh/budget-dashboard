// The wallet webhook asks the text parser one extra question — "is this
// notification a purchase at all?" — because the phone trigger fires on every
// bank/wallet notification. The question is opt-in: extractTransactionText is
// shared with the Telegram bot's typed-expense path, and a user typing
// "coffee 5" must never be told that is not a purchase.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.stubEnv('GROQ_API_KEY', 'gsk-test');
vi.stubEnv('GEMINI_API_KEY', 'gem-test');
vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');

const { extractTransactionText, __evalInternals } = await import('../../functions/lib/_extraction.mjs');

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

const BASE = {
  store_name: 'Little Oddfellows', purchase_date: '2026-05-15', total_amount: 17.58,
  tax_amount: null, currency: 'USD', items: [], reward_category: 'Eating Out',
  is_transfer: false, payment_method: null,
};
const groqReturns = (payload) => mockFetch.mockImplementation(() => Promise.resolve({
  ok: true,
  json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify({ ...BASE, ...payload }) } }] }),
}));
const promptSent = () => JSON.parse(mockFetch.mock.calls[0][1].body).messages.at(-1).content;
const DETECT = { detectNonPurchase: true };

beforeEach(() => { mockFetch.mockReset(); });

describe('extractTransactionText — non-purchase detection (opt-in)', () => {
  it('surfaces is_purchase=false and the kind when asked', async () => {
    groqReturns({ store_name: null, total_amount: null, is_purchase: false, non_purchase_kind: 'declined' });
    const res = await extractTransactionText('Your purchase was declined', DETECT);
    expect(res.data.is_purchase).toBe(false);
    expect(res.data.non_purchase_kind).toBe('declined');
  });

  it('a missing flag means purchase (fail open toward logging)', async () => {
    groqReturns({});
    const res = await extractTransactionText('Little Oddfellows $17.58', DETECT);
    expect(res.data.is_purchase).toBe(true);
    expect(res.data.non_purchase_kind).toBeNull();
  });

  it.each([null, 'maybe', 0, 'yes', {}])('an unparseable flag (%j) means purchase', async (junk) => {
    groqReturns({ is_purchase: junk, non_purchase_kind: 'statement' });
    const res = await extractTransactionText('Little Oddfellows $17.58', DETECT);
    expect(res.data.is_purchase).toBe(true);
    expect(res.data.non_purchase_kind).toBeNull();
  });

  it('only a real false (or the string "false") counts as a non-purchase', async () => {
    groqReturns({ is_purchase: 'false', non_purchase_kind: 'refund' });
    const res = await extractTransactionText('Refund of $5', DETECT);
    expect(res.data.is_purchase).toBe(false);
    expect(res.data.non_purchase_kind).toBe('refund');
  });

  it('an unknown or missing kind on a non-purchase becomes "other"', async () => {
    groqReturns({ is_purchase: false, non_purchase_kind: 'gibberish' });
    expect((await extractTransactionText('x', DETECT)).data.non_purchase_kind).toBe('other');
    groqReturns({ is_purchase: false });
    expect((await extractTransactionText('x', DETECT)).data.non_purchase_kind).toBe('other');
  });

  it('asks the model about it only when opted in', async () => {
    groqReturns({});
    await extractTransactionText('coffee 5', DETECT);
    expect(promptSent()).toContain('is_purchase');
    mockFetch.mockClear();
    await extractTransactionText('coffee 5');
    expect(promptSent()).not.toContain('is_purchase');
    expect(__evalInternals.buildTextPrompt('coffee 5')).not.toContain('is_purchase');
  });
});

describe('extractTransactionText — shared callers are unaffected', () => {
  it('without the option the result carries no purchase flag, even if the model volunteers one', async () => {
    groqReturns({ is_purchase: false, non_purchase_kind: 'declined' });
    const res = await extractTransactionText('coffee 5');
    expect(res.ok).toBe(true);
    expect(res.data).not.toHaveProperty('is_purchase');
    expect(res.data).not.toHaveProperty('non_purchase_kind');
    expect(res.data.store_name).toBe('Little Oddfellows');
  });
});
