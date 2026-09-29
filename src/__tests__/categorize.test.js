import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  applySmartRules, categorizeWithGroq, resolveCategory, CONFIDENCE_THRESHOLD,
  CONFIDENCE_RUBRIC, AUDIT_CONFIDENCE, ALWAYS_ASK_VENDORS, isAlwaysAsk, buildPrompt, categoryFromHistory,
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

  it('agreeing with the extractor does not bypass the threshold', async () => {
    // Extractor and Groq are the same model family with correlated errors —
    // both say Travel for a car rental the user files under Holiday.
    mockFetch.mockResolvedValue(groqReply('{"category":"Grocery","confidence":0.3}'));
    const out = await resolveCategory({
      vendor: 'Some Market', amount: 20, extractedCategory: 'Grocery',
      categories: CATEGORIES, settings,
    });
    expect(out).toMatchObject({ category: 'Grocery', needsConfirm: true });
  });

  it('a confident answer that also matches the extractor is still written silently', async () => {
    mockFetch.mockResolvedValue(groqReply('{"category":"Grocery","confidence":1}'));
    const out = await resolveCategory({
      vendor: 'Safeway', amount: 20, extractedCategory: 'Grocery',
      categories: CATEGORIES, settings,
    });
    expect(out).toMatchObject({ category: 'Grocery', needsConfirm: false });
  });

  it('asks when both extractor and Groq say Misc, however sure Groq is', async () => {
    // The weakest agreement there is: an unfamiliar vendor lands in the catch-all.
    for (const extracted of ['Misc', null]) {
      mockFetch.mockResolvedValue(groqReply('{"category":"Misc","confidence":1}'));
      const out = await resolveCategory({
        vendor: 'AMZN Mktp US*2K4', amount: 20, extractedCategory: extracted,
        categories: CATEGORIES, settings,
      });
      expect(out, `extracted=${extracted}`).toMatchObject({ category: 'Misc', needsConfirm: true });
    }
  });

  it('asks at 0.8 and writes at 0.9', async () => {
    for (const [confidence, ask] of [[0.8, true], [0.9, false]]) {
      mockFetch.mockResolvedValue(groqReply(`{"category":"Travel","confidence":${confidence}}`));
      const out = await resolveCategory({
        vendor: 'Avis Car Rental', amount: 200, extractedCategory: 'Travel',
        categories: CATEGORIES, settings,
      });
      expect(out.needsConfirm, `confidence ${confidence}`).toBe(ask);
    }
  });

  it('always asks about a split-receipt vendor, even at 1.0', async () => {
    mockFetch.mockResolvedValue(groqReply('{"category":"Grocery","confidence":1}'));
    const out = await resolveCategory({
      vendor: 'COSTCO WHSE #0117', amount: 200, extractedCategory: 'Grocery',
      categories: CATEGORIES, settings: {},
    });
    expect(out).toMatchObject({ category: 'Grocery', needsConfirm: true });
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


/* ── One scale: prompt, threshold and audit ── */

describe('confidence scale', () => {
  it('generates the prompt from the exported rubric, with no hardcoded threshold', () => {
    const prompt = buildPrompt('Safeway', 10, CATEGORIES);
    for (const [score, meaning] of CONFIDENCE_RUBRIC) {
      expect(prompt).toContain(String(score));
      expect(prompt).toContain(meaning);
    }
    expect(prompt).not.toMatch(/below 0\.75/);
  });

  it('puts the threshold between the 0.8 and 0.9 answers the model actually gives', () => {
    // Measured: the model snaps to 0.2/0.5/0.7/0.8/0.9/1.0. At 0.9 and up it was
    // right ~95% of the time on this household's vendors; at 0.8 and below it
    // was not. 0.85 is silent from 0.9 up and asks at 0.8 and below.
    expect(CONFIDENCE_THRESHOLD).toBeGreaterThan(0.8);
    expect(CONFIDENCE_THRESHOLD).toBeLessThan(0.9);
  });

  it('keeps the weekly audit at least as strict as the add path', () => {
    expect(AUDIT_CONFIDENCE).toBeGreaterThanOrEqual(CONFIDENCE_THRESHOLD);
  });
});

/* ── Layer 1.5: the user's own past filings ── */

describe('categoryFromHistory', () => {
  const row = (vendor, category) => ({ vendor, category });

  it('takes the category of a single prior filing', () => {
    expect(categoryFromHistory('SAFEWAY', [row('Safeway', 'Grocery')], CATEGORIES))
      .toEqual({ category: 'Grocery', count: 1, agree: true, supported: false });
  });

  it('needs two agreeing rows, or three for an always-ask vendor, before it is supported', () => {
    // One trip purchase must not pin a category for good.
    const two = (v, c) => [row(v, c), row(v, c)];
    expect(categoryFromHistory('Safeway', two('Safeway', 'Grocery'), CATEGORIES).supported).toBe(true);
    expect(categoryFromHistory('Walmart', two('Walmart', 'Holiday'), CATEGORIES.concat('Holiday')))
      .toMatchObject({ agree: true, supported: false });
    expect(categoryFromHistory('Walmart', [...two('Walmart', 'Grocery'), row('Walmart', 'Grocery')], CATEGORIES))
      .toMatchObject({ agree: true, supported: true });
  });

  it('matches store numbers, truncation and extra words on the same vendor', () => {
    const rows = [row('Daily Grocery Beer And Wine', 'Grocery')];
    expect(categoryFromHistory('DAILY GROCERY BEER AND WI', rows, CATEGORIES).category).toBe('Grocery');
    expect(categoryFromHistory('Safeway #1841', [row('SAFEWAY', 'Grocery')], CATEGORIES).category).toBe('Grocery');
    expect(categoryFromHistory('Mayuri', [row('Mayuri Foods International', 'Grocery')], CATEGORIES).category).toBe('Grocery');
  });

  it('does not match a different vendor that merely shares a word', () => {
    expect(categoryFromHistory('Some Market', [row('Metropolitan Market', 'Grocery')], CATEGORIES)).toBeNull();
    expect(categoryFromHistory('Amazon Prime', [row('Anker Mouse Amazon', 'Misc')], CATEGORIES)).toBeNull();
  });

  it('takes the dominant category when prior filings mostly agree', () => {
    const rows = [row('Costco', 'Grocery'), row('Costco', 'Grocery'), row('Costco', 'Grocery'), row('Costco', 'Misc')];
    expect(categoryFromHistory('Costco', rows, CATEGORIES)).toMatchObject({ category: 'Grocery', agree: true });
  });

  it('reports a split vendor as not agreeing, so the caller asks', () => {
    const rows = [row('Costco', 'Grocery'), row('Costco', 'Grocery'), row('Costco', 'Travel')];
    expect(categoryFromHistory('Costco', rows, CATEGORIES)).toMatchObject({ agree: false });
    expect(categoryFromHistory('Costco', [row('Costco', 'Grocery'), row('Costco', 'Travel')], CATEGORIES))
      .toMatchObject({ agree: false });
  });

  it('ignores rows with no usable category and categories the sheet lacks', () => {
    expect(categoryFromHistory('Safeway', [row('Safeway', ''), row('Safeway', 'Nope')], CATEGORIES)).toBeNull();
  });

  it('returns null without rows or a vendor', () => {
    expect(categoryFromHistory('Safeway', [], CATEGORIES)).toBeNull();
    expect(categoryFromHistory('Safeway', undefined, CATEGORIES)).toBeNull();
    expect(categoryFromHistory('', [row('Safeway', 'Grocery')], CATEGORIES)).toBeNull();
  });
});

describe('resolveCategory with history', () => {
  const settings = { smartRules: [{ pattern: 'avis', category: 'Travel' }] };
  const history = [
    { vendor: 'Avis Car Rental', category: 'Health' },
    { vendor: 'Petrol', category: 'Travel' }, { vendor: 'Petrol', category: 'Travel' },
  ];

  it('uses the vendor\'s prior filing without calling the LLM or asking', async () => {
    const out = await resolveCategory({
      vendor: 'PETROL', amount: 40, extractedCategory: 'Travel',
      categories: CATEGORIES, settings: {}, history,
    });
    expect(out).toMatchObject({ category: 'Travel', source: 'history', needsConfirm: false });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('lets a smart rule beat history', async () => {
    const out = await resolveCategory({
      vendor: 'Avis Car Rental', amount: 200, extractedCategory: null,
      categories: CATEGORIES, settings, history,
    });
    expect(out).toMatchObject({ category: 'Travel', source: 'rule' });
  });

  it('asks about a vendor whose prior filings disagree, even if Groq is sure', async () => {
    mockFetch.mockResolvedValue(groqReply('{"category":"Grocery","confidence":1}'));
    const out = await resolveCategory({
      vendor: 'Costco', amount: 90, extractedCategory: 'Grocery', categories: CATEGORIES, settings: {},
      history: [{ vendor: 'Costco', category: 'Grocery' }, { vendor: 'Costco', category: 'Travel' }],
    });
    expect(out).toMatchObject({ category: 'Grocery', source: 'llm', needsConfirm: true });
  });

  it('applies history even when the LLM is switched off', async () => {
    const out = await resolveCategory({
      vendor: 'Petrol', amount: 40, extractedCategory: 'Travel',
      categories: CATEGORIES, settings: {}, history, enabled: false,
    });
    expect(out).toMatchObject({ category: 'Travel', source: 'history' });
  });

  it('does not let a single prior row skip the prompt for an always-ask vendor', async () => {
    // One Hawaii-trip Walmart row filed as Holiday must not pin Walmart forever.
    mockFetch.mockResolvedValue(groqReply('{"category":"Grocery","confidence":1}'));
    const out = await resolveCategory({
      vendor: 'WALMART SUPERCENTER', amount: 41, extractedCategory: null,
      categories: [...CATEGORIES, 'Holiday'], settings: {},
      history: [{ vendor: 'Walmart', category: 'Holiday' }],
    });
    expect(mockFetch).toHaveBeenCalled();
    expect(out).toMatchObject({ category: 'Grocery', source: 'llm', needsConfirm: true });
  });

  it('lets three agreeing rows settle an always-ask vendor, but not two', async () => {
    const rows = (n) => Array.from({ length: n }, () => ({ vendor: 'Target', category: 'Health' }));
    mockFetch.mockResolvedValue(groqReply('{"category":"Grocery","confidence":1}'));
    const two = await resolveCategory({
      vendor: 'Target', amount: 20, extractedCategory: null, categories: CATEGORIES, settings: {}, history: rows(2),
    });
    expect(two).toMatchObject({ source: 'llm', needsConfirm: true });
    const three = await resolveCategory({
      vendor: 'Target', amount: 20, extractedCategory: null, categories: CATEGORIES, settings: {}, history: rows(3),
    });
    expect(three).toMatchObject({ category: 'Health', source: 'history', needsConfirm: false });
  });

  it('with one prior row an ordinary vendor goes through the threshold, not straight to history', async () => {
    mockFetch.mockResolvedValue(groqReply('{"category":"Eating Out","confidence":0.7}'));
    const out = await resolveCategory({
      vendor: 'Chipotle', amount: 14, extractedCategory: null, categories: CATEGORIES, settings: {},
      history: [{ vendor: 'Chipotle', category: 'Grocery' }],
    });
    expect(out).toMatchObject({ category: 'Eating Out', source: 'llm', needsConfirm: true });
  });

  it('treats a history of Misc as no information and goes to the LLM', async () => {
    // Misc is the unknown bucket, and the old pipeline defaulted many rows to it
    // (Safeway, Mayuri...) until the user moved them. Repeating that default
    // silently would freeze the old mistakes; pin a genuine Misc vendor with a
    // smart rule instead.
    const misc = Array.from({ length: 4 }, () => ({ vendor: 'Shell Oil', category: 'Misc' }));
    mockFetch.mockResolvedValue(groqReply('{"category":"Misc","confidence":1}'));
    const asked = await resolveCategory({
      vendor: 'SHELL OIL 57444', amount: 40, extractedCategory: null, categories: CATEGORIES, settings: {}, history: misc,
    });
    expect(mockFetch).toHaveBeenCalled();
    expect(asked).toMatchObject({ category: 'Misc', source: 'llm', needsConfirm: true });

    mockFetch.mockResolvedValue(groqReply('{"category":"Travel","confidence":0.9}'));
    const corrected = await resolveCategory({
      vendor: 'SHELL OIL 57444', amount: 40, extractedCategory: null, categories: CATEGORIES, settings: {}, history: misc,
    });
    expect(corrected).toMatchObject({ category: 'Travel', source: 'llm', needsConfirm: false });
  });

  it('still lets a smart rule pin a vendor to Misc', async () => {
    const out = await resolveCategory({
      vendor: 'Shell Oil', amount: 40, extractedCategory: null, categories: CATEGORIES,
      settings: { smartRules: [{ pattern: 'shell oil', category: 'Misc' }] },
      history: [{ vendor: 'Shell Oil', category: 'Misc' }],
    });
    expect(out).toMatchObject({ category: 'Misc', source: 'rule', needsConfirm: false });
  });

  it('falls through to the LLM for a vendor with no history', async () => {
    mockFetch.mockResolvedValue(groqReply('{"category":"Eating Out","confidence":1}'));
    const out = await resolveCategory({
      vendor: 'Chipotle', amount: 14, extractedCategory: null,
      categories: CATEGORIES, settings: {}, history,
    });
    expect(out).toMatchObject({ category: 'Eating Out', source: 'llm', needsConfirm: false });
  });
});


describe('always-ask vendors', () => {
  it('flags split-receipt and ambiguous vendors as they appear on card feeds', () => {
    for (const v of ['COSTCO WHSE #0117', 'Costco Wholesale', 'TARGET 00021', 'Target', 'WALMART SUPERCENTER',
      'AMZN Mktp US*2K4TR8', 'Amazon.com', 'Amazon Prime Membership', 'Zelle to J Smith', 'VENMO PAYMENT',
      'PAYPAL *DIGITALGOOD', 'APPLE.COM/BILL', 'GOOGLE *SERVICES', 'Google *YouTube']) {
      expect(isAlwaysAsk(v), v).toBe(true);
    }
  });

  it('does not over-match unrelated vendors', () => {
    for (const v of ['Targeted Marketing LLC', 'Costcorp Ltd', 'Trader Joes', 'Safeway', 'Chipotle',
      'Googleplex Cafe', 'Zellers', 'Applebees', 'Amazonia Grill', 'Starbucks']) {
      expect(isAlwaysAsk(v), v).toBe(false);
    }
  });

  it('is one exported list of patterns', () => {
    expect(Array.isArray(ALWAYS_ASK_VENDORS)).toBe(true);
    expect(ALWAYS_ASK_VENDORS.length).toBeGreaterThan(0);
    expect(isAlwaysAsk('')).toBe(false);
    expect(isAlwaysAsk(undefined)).toBe(false);
  });

  it('lets a smart rule and a consistent history beat the list', async () => {
    const byRule = await resolveCategory({
      vendor: 'Costco', amount: 50, extractedCategory: null, categories: CATEGORIES,
      settings: { smartRules: [{ pattern: 'costco', category: 'Grocery' }] },
    });
    expect(byRule).toMatchObject({ source: 'rule', needsConfirm: false });

    const byHistory = await resolveCategory({
      vendor: 'Target', amount: 50, extractedCategory: null, categories: CATEGORIES, settings: {},
      history: Array.from({ length: 3 }, () => ({ vendor: 'Target', category: 'Health' })),
    });
    expect(byHistory).toMatchObject({ category: 'Health', source: 'history', needsConfirm: false });
  });
});
