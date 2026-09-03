// Provider ordering: Groq leads, Gemini/Claude are the last straw — except for
// images, where Gemini leads because Groq cannot keep up.
//
// The ordering is the feature here, so these tests assert WHICH provider is
// called and in what sequence, not what it returns. They work by watching the
// URLs fetch is called with.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.stubEnv('GROQ_API_KEY', 'gsk-test');
vi.stubEnv('GEMINI_API_KEY', 'gem-test');
vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');

const { extractReceipt, extractTransactionText } = await import('../../functions/lib/_extraction.mjs');

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

const host = (url) => {
  const u = String(url);
  if (u.includes('groq.com')) return 'groq';
  if (u.includes('googleapis.com')) return 'gemini';
  if (u.includes('anthropic.com')) return 'claude';
  return 'other';
};
const calledHosts = () => mockFetch.mock.calls.map(c => host(c[0]));

const EXTRACTION = {
  store_name: 'Walgreens', purchase_date: '2026-05-15', total_amount: 53.11,
  tax_amount: null, currency: 'USD', items: [], reward_category: 'Health',
  is_transfer: false, payment_method: null,
};

const ok = (payload) => ({ ok: true, json: () => Promise.resolve(payload) });
const groqOk   = () => ok({ choices: [{ message: { content: JSON.stringify(EXTRACTION) } }] });
const geminiOk = () => ok({ candidates: [{ content: { parts: [{ text: JSON.stringify(EXTRACTION) }] } }] });
const claudeOk = () => ok({ content: [{ type: 'text', text: JSON.stringify(EXTRACTION) }] });
const fail     = () => ({ ok: false, json: () => Promise.resolve({ error: { message: 'boom' } }) });

/** Every provider fails, so the full chain is walked and observable. */
function allFail() {
  mockFetch.mockImplementation(() => Promise.resolve(fail()));
}

beforeEach(() => { mockFetch.mockReset(); });

describe('text extraction — Groq first', () => {
  it('asks Groq before anything else', async () => {
    mockFetch.mockImplementation((url) => Promise.resolve(host(url) === 'groq' ? groqOk() : fail()));
    const res = await extractTransactionText('Your card was charged $53.11 at WALGREENS');

    expect(res.ok).toBe(true);
    expect(calledHosts()[0]).toBe('groq');
    // Nothing else needed to be touched.
    expect(calledHosts()).not.toContain('gemini');
    expect(calledHosts()).not.toContain('claude');
  });

  it('falls back Groq → Gemini → Claude, in that order', async () => {
    allFail();
    await extractTransactionText('Your card was charged $53.11 at WALGREENS');

    const order = [...new Set(calledHosts())];
    expect(order).toEqual(['groq', 'gemini', 'claude']);
  });

  it('reaches Gemini when Groq is down', async () => {
    mockFetch.mockImplementation((url) => Promise.resolve(host(url) === 'gemini' ? geminiOk() : fail()));
    const res = await extractTransactionText('Your card was charged $53.11 at WALGREENS');

    expect(res.ok).toBe(true);
    expect(res.data.total_amount).toBe(53.11);
  });
});

describe('image extraction — Gemini first, Groq second, Claude last', () => {
  it('asks Gemini before Groq', async () => {
    mockFetch.mockImplementation((url) => Promise.resolve(host(url) === 'gemini' ? geminiOk() : fail()));
    const res = await extractReceipt('BASE64', 'image/jpeg');

    expect(res.ok).toBe(true);
    expect(calledHosts()[0]).toBe('gemini');
    expect(calledHosts()).not.toContain('groq');
  });

  it('puts Groq ahead of Claude once Gemini is exhausted', async () => {
    allFail();
    await extractReceipt('BASE64', 'image/jpeg');

    const order = [...new Set(calledHosts())];
    expect(order).toEqual(['gemini', 'groq', 'claude']);
  });

  it('uses Groq as the image fallback when Gemini fails', async () => {
    mockFetch.mockImplementation((url) => Promise.resolve(host(url) === 'groq' ? groqOk() : fail()));
    const res = await extractReceipt('BASE64', 'image/jpeg');

    expect(res.ok).toBe(true);
    expect(res.data.store_name).toBe('Walgreens');
  });
});

describe('PDFs skip Groq entirely', () => {
  it('never sends a PDF to Groq', async () => {
    // Groq documents image input only; spending a step on it would just delay
    // the Claude fallback that can actually read the document.
    allFail();
    await extractReceipt('BASE64PDF', 'application/pdf');

    expect(calledHosts()).not.toContain('groq');
    expect([...new Set(calledHosts())]).toEqual(['gemini', 'claude']);
  });

  it('still falls back to Claude for a PDF Gemini cannot read', async () => {
    mockFetch.mockImplementation((url) => Promise.resolve(host(url) === 'claude' ? claudeOk() : fail()));
    const res = await extractReceipt('BASE64PDF', 'application/pdf');

    expect(res.ok).toBe(true);
    expect(res.model).toMatch(/claude/);
  });
});
