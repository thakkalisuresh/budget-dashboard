import { describe, it, expect, vi } from 'vitest';

vi.stubEnv('GROQ_API_KEY', 'k');
const { __evalInternals, sanitizeExtraction } = await import('../../functions/lib/_extraction.mjs');

// The text prompt is what tells the model to return EUR for "€16.00". The model is
// not run here; these pin the instructions and the sanitizer that trusts its answer.
describe('text prompt — currency', () => {
  const prompt = __evalInternals.buildTextPrompt('Xt Network Sas\n€16.00', '2026-09-28', { detectNonPurchase: true });

  it('shows the real symbols, not their \\u escape text', () => {
    expect(prompt).not.toMatch(/\\u20/);
    for (const sym of ['€', '£', '₹']) expect(prompt).toContain(sym);
  });

  it.each([['€', 'EUR'], ['£', 'GBP'], ['₹', 'INR']])('maps %s to %s', (sym, code) => {
    expect(prompt).toContain(`${sym} = ${code}`);
  });

  it('asks for the amount in the ORIGINAL currency, unconverted', () => {
    expect(prompt).toMatch(/original currency/i);
    expect(prompt).toMatch(/do not convert/i);
  });

  it('leaves the receipt / vision prompts alone', () => {
    expect(__evalInternals.buildUserPrompt('2026-09-28')).not.toMatch(/do not convert/i);
  });
});

describe('sanitizeExtraction — currency', () => {
  it.each([['eur', 'EUR'], ['GBP', 'GBP'], ['inr', 'INR']])('upper-cases %s', (c, out) => {
    expect(sanitizeExtraction({ currency: c }).currency).toBe(out);
  });
  it.each([undefined, null, '', '€', 'EURO', 5])('falls back to USD for %s', (c) => {
    expect(sanitizeExtraction({ currency: c }).currency).toBe('USD');
  });
});
