import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  applySmartRules, categorizeWithGroq, resolveCategory, CONFIDENCE_THRESHOLD,
} from '../../functions/lib/_categorize.mjs';
import { applySmartRules as frontendApplySmartRules } from '../smartRules.js';

const CATEGORIES = ['Grocery', 'Eating Out', 'Misc', 'Travel', 'Entertainment', 'Health'];

const mockFetch = vi.fn();

/** Shape a Groq chat-completion response carrying `content` as the message body. */
function groqReply(content) {
  return {
    ok: true,
    json: () => Promise.resolve({ choices: [{ message: { content } }] }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  global.fetch = mockFetch;
  vi.stubEnv('GROQ_API_KEY', 'test-groq-key');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/* ── Layer 1: smart rules ── */

describe('applySmartRules — server mirror', () => {
  const rules = [
    { pattern: 'costco', category: 'Grocery' },
    { pattern: 'costco gas', category: 'Travel' },
    { pattern: 'starbucks', category: 'Eating Out' },
  ];

  it('matches a rule case-insensitively', () => {
    expect(applySmartRules('STARBUCKS #123', rules)).toBe('Eating Out');
  });

  it('prefers the most specific rule when several match', () => {
    // Both 'costco' and 'costco gas' match; the longer pattern wins.
    expect(applySmartRules('Costco Gas Station', rules)).toBe('Travel');
  });

  it('returns null with no vendor or no rules', () => {
    expect(applySmartRules('', rules)).toBeNull();
    expect(applySmartRules('Costco', [])).toBeNull();
    expect(applySmartRules('Costco', undefined)).toBeNull();
  });

  // This logic previously existed only in the browser. The two copies are
  // duplicated deliberately (the frontend can't import from functions/), so
  // this is the guard against them drifting.
  it('agrees with the frontend implementation across a shared input set', () => {
    const vendors = [
      'Costco Gas Station', 'COSTCO WHOLESALE #442', 'starbucks', 'Starbucks Reserve',
      'Whole Foods', '', '   ', 'costco gas',
    ];
    for (const v of vendors) {
      expect(applySmartRules(v, rules), `drift on "${v}"`)
        .toBe(frontendApplySmartRules(v, rules));
    }
  });
});

/* ── Layer 2: Groq ── */

describe('categorizeWithGroq', () => {
  it('returns the parsed category and confidence', async () => {
    mockFetch.mockResolvedValue(groqReply('{"category":"Grocery","confidence":0.93}'));
    const out = await categorizeWithGroq('Whole Foods', 52.1, CATEGORIES);
    expect(out).toEqual({ category: 'Grocery', confidence: 0.93 });
  });

  it('returns null without an API key rather than throwing', async () => {
    vi.stubEnv('GROQ_API_KEY', '');
    expect(await categorizeWithGroq('Whole Foods', 10, CATEGORIES)).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects a category outside the allowed list', async () => {
    // The sheet has no tab for an invented category, so it is unusable.
    mockFetch.mockResolvedValue(groqReply('{"category":"Groceries & Home","confidence":0.99}'));
    expect(await categorizeWithGroq('Whole Foods', 10, CATEGORIES)).toBeNull();
  });

  it('survives malformed JSON, an API error, and a network throw', async () => {
    mockFetch.mockResolvedValue(groqReply('not json at all'));
    expect(await categorizeWithGroq('X', 1, CATEGORIES)).toBeNull();

    mockFetch.mockResolvedValue({ ok: false, status: 429, json: () => Promise.resolve({ error: { message: 'rate limited' } }) });
    expect(await categorizeWithGroq('X', 1, CATEGORIES)).toBeNull();

    mockFetch.mockRejectedValue(new Error('ECONNRESET'));
    expect(await categorizeWithGroq('X', 1, CATEGORIES)).toBeNull();
  });

  it('clamps a confidence outside 0..1', async () => {
    mockFetch.mockResolvedValue(groqReply('{"category":"Misc","confidence":4.2}'));
    expect((await categorizeWithGroq('X', 1, CATEGORIES)).confidence).toBe(1);
  });

  it('treats a missing confidence as zero, not as certainty', async () => {
    mockFetch.mockResolvedValue(groqReply('{"category":"Misc"}'));
    expect((await categorizeWithGroq('X', 1, CATEGORIES)).confidence).toBe(0);
  });
});

/* ── The decision ── */

describe('resolveCategory', () => {
  const settings = { smartRules: [{ pattern: 'costco', category: 'Grocery' }] };

  it('takes a smart rule without consulting the LLM at all', async () => {
    const out = await resolveCategory({
      vendor: 'Costco #442', amount: 80, extractedCategory: 'Misc',
      categories: CATEGORIES, settings,
    });
    expect(out).toMatchObject({ category: 'Grocery', source: 'rule', needsConfirm: false });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('accepts a confident LLM correction silently', async () => {
    mockFetch.mockResolvedValue(groqReply('{"category":"Eating Out","confidence":0.95}'));
    const out = await resolveCategory({
      vendor: 'Chipotle', amount: 14, extractedCategory: 'Misc',
      categories: CATEGORIES, settings,
    });
    expect(out).toMatchObject({ category: 'Eating Out', source: 'llm', needsConfirm: false });
  });

  it('asks when the LLM disagrees but is unsure', async () => {
    mockFetch.mockResolvedValue(groqReply(`{"category":"Travel","confidence":${CONFIDENCE_THRESHOLD - 0.1}}`));
    const out = await resolveCategory({
      vendor: 'BP', amount: 40, extractedCategory: 'Misc',
      categories: CATEGORIES, settings,
    });
    expect(out).toMatchObject({ category: 'Travel', source: 'llm', needsConfirm: true });
  });

  it('does not ask when the LLM merely agrees with the extractor', async () => {
    // Agreement is corroboration — no reason to bother the user even if the
    // model hedged on its own confidence.
    mockFetch.mockResolvedValue(groqReply('{"category":"Grocery","confidence":0.3}'));
    const out = await resolveCategory({
      vendor: 'Some Market', amount: 20, extractedCategory: 'Grocery',
      categories: CATEGORIES, settings,
    });
    expect(out).toMatchObject({ category: 'Grocery', needsConfirm: false });
  });

  it('falls back to the extractor when the LLM is unavailable', async () => {
    mockFetch.mockRejectedValue(new Error('down'));
    const out = await resolveCategory({
      vendor: 'Unknown Vendor', amount: 5, extractedCategory: 'Entertainment',
      categories: CATEGORIES, settings,
    });
    expect(out).toMatchObject({ category: 'Entertainment', source: 'extraction', needsConfirm: false });
  });

  it('defaults to Misc when there is no extracted category either', async () => {
    mockFetch.mockRejectedValue(new Error('down'));
    const out = await resolveCategory({
      vendor: 'Unknown', amount: 5, extractedCategory: null,
      categories: CATEGORIES, settings,
    });
    expect(out.category).toBe('Misc');
  });

  it('when disabled, skips the LLM but still honours smart rules', async () => {
    const ruled = await resolveCategory({
      vendor: 'Costco', amount: 80, extractedCategory: 'Misc',
      categories: CATEGORIES, settings, enabled: false,
    });
    expect(ruled).toMatchObject({ category: 'Grocery', source: 'rule' });

    const unruled = await resolveCategory({
      vendor: 'Chipotle', amount: 14, extractedCategory: 'Misc',
      categories: CATEGORIES, settings, enabled: false,
    });
    expect(unruled).toMatchObject({ category: 'Misc', source: 'extraction' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('ignores a rule pointing at a category the sheet does not have', async () => {
    mockFetch.mockRejectedValue(new Error('down'));
    const out = await resolveCategory({
      vendor: 'Costco', amount: 80, extractedCategory: 'Misc',
      categories: ['Misc', 'Travel'], // no 'Grocery' tab
      settings,
    });
    expect(out).toMatchObject({ category: 'Misc', source: 'extraction' });
  });
});
