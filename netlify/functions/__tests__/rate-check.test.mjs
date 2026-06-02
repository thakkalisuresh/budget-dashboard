import { describe, it, expect, vi } from 'vitest';
import {
  rateDisplay, diffRateTable, buildRateChangeMessage, parseClaudeRates,
  buildClaudePrompt, runRateCheck, MCC_LABELS,
} from '../_rate-check.mjs';

const CSR = {
  type: 'points', unit: 'UR', pointValue: 0.015,
  mccs: { '5812': 3, '4511': { portal: 8, direct: 4 }, '7011': { portal: 8, direct: 4 }, 'CHASE_PORTAL': 8 },
  default: 1,
};
const AMEX = {
  type: 'cashback', unit: '$',
  mccs: { '5411': { rate: 6, cap: { annual: 6000, then: 1 } }, '7372': 6, '5541': 3 },
  default: 1,
};

describe('rateDisplay', () => {
  it('formats points multipliers', () => {
    expect(rateDisplay('points', 3)).toBe('3x');
  });
  it('formats cashback percents', () => {
    expect(rateDisplay('cashback', 6)).toBe('6%');
  });
  it('formats portal/direct split', () => {
    expect(rateDisplay('points', { portal: 8, direct: 4 })).toBe('8x portal / 4x direct');
  });
  it('formats capped category by its rate', () => {
    expect(rateDisplay('cashback', { rate: 6, cap: { annual: 6000, then: 1 } })).toBe('6%');
  });
  it('renders dash for missing node', () => {
    expect(rateDisplay('points', undefined)).toBe('—');
  });
});

describe('diffRateTable', () => {
  it('returns empty when tables are identical', () => {
    expect(diffRateTable(CSR, JSON.parse(JSON.stringify(CSR)))).toEqual([]);
  });

  it('detects a single MCC rate change', () => {
    const next = JSON.parse(JSON.stringify(CSR));
    next.mccs['5812'] = 4;
    const diffs = diffRateTable(CSR, next);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({ key: '5812', label: 'Dining', from: '3x', to: '4x' });
  });

  it('detects a portal/direct split change', () => {
    const next = JSON.parse(JSON.stringify(CSR));
    next.mccs['4511'] = { portal: 10, direct: 5 };
    const diffs = diffRateTable(CSR, next);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({ key: '4511', from: '8x portal / 4x direct', to: '10x portal / 5x direct' });
  });

  it('detects a newly added MCC', () => {
    const next = JSON.parse(JSON.stringify(AMEX));
    next.mccs['5300'] = 1;
    const diffs = diffRateTable(AMEX, next);
    expect(diffs.map(d => d.key)).toContain('5300');
    expect(diffs.find(d => d.key === '5300')).toMatchObject({ from: '—', to: '1%' });
  });

  it('detects a default rate change', () => {
    const next = JSON.parse(JSON.stringify(CSR));
    next.default = 1.5;
    const diffs = diffRateTable(CSR, next);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({ key: 'default', label: 'Everything else', from: '1x', to: '1.5x' });
  });
});

describe('buildRateChangeMessage', () => {
  it('formats a complete notification', () => {
    const diffs = [{ key: '5812', label: 'Dining', from: '3x', to: '4x' }];
    const msg = buildRateChangeMessage('Chase Sapphire Reserve', diffs, 'bankrate.com/x', 'high');
    expect(msg).toContain('📊 Rate change detected — Chase Sapphire Reserve');
    expect(msg).toContain('Dining: 3x → 4x');
    expect(msg).toContain('Source: bankrate.com/x');
    expect(msg).toContain('Confidence: High');
    expect(msg).toContain('Reply APPLY RATES to update, or IGNORE to keep current rates.');
  });
});

describe('parseClaudeRates', () => {
  it('parses a clean JSON object', () => {
    const r = parseClaudeRates('{"mccs":{"5812":4},"default":1,"source":"x","confidence":"high"}');
    expect(r).toMatchObject({ mccs: { '5812': 4 }, default: 1, source: 'x', confidence: 'high' });
  });

  it('extracts JSON from fenced markdown with surrounding prose', () => {
    const text = 'After searching, here is the table:\n```json\n{"mccs":{"5411":6},"default":1,"source":"bankrate","confidence":"HIGH"}\n```\nDone.';
    const r = parseClaudeRates(text);
    expect(r.mccs).toEqual({ '5411': 6 });
    expect(r.confidence).toBe('high'); // lowercased
  });

  it('returns null for malformed / shapeless text', () => {
    expect(parseClaudeRates('no json here')).toBeNull();
    expect(parseClaudeRates('{"foo":1}')).toBeNull(); // missing mccs/default
    expect(parseClaudeRates('')).toBeNull();
    expect(parseClaudeRates(null)).toBeNull();
  });
});

describe('buildClaudePrompt', () => {
  it('includes the card name, source hint, and current table', () => {
    const p = buildClaudePrompt('Chase Sapphire Reserve', CSR, 'https://chase.com/csr');
    expect(p).toContain('Chase Sapphire Reserve');
    expect(p).toContain('https://chase.com/csr');
    expect(p).toContain('"5812": 3');
    expect(p).toContain('confidence');
  });
});

describe('runRateCheck', () => {
  const makeStore = () => {
    const data = new Map();
    return { data, setJSON: vi.fn((k, v) => { data.set(k, v); return Promise.resolve(); }) };
  };

  it('notifies + stores a proposal on a high-confidence change', async () => {
    const store = makeStore();
    const tg = vi.fn();
    const inApp = vi.fn();
    const callClaude = vi.fn(async (card) =>
      card === 'Chase Sapphire Reserve'
        ? { mccs: { ...CSR.mccs, '5812': 4 }, default: 1, source: 'bankrate', confidence: 'high' }
        : { mccs: AMEX.mccs, default: AMEX.default, source: 'bankrate', confidence: 'high' } // unchanged
    );

    const result = await runRateCheck({
      currentRates: { 'Chase Sapphire Reserve': CSR, 'American Express Blue Cash Preferred': AMEX },
      callClaude, store, notifyTelegram: tg, notifyInApp: inApp,
    });

    expect(result.changed).toHaveLength(1);
    expect(result.changed[0].card).toBe('Chase Sapphire Reserve');
    expect(result.proposalStored).toBe(true);
    expect(tg).toHaveBeenCalledTimes(1);
    expect(inApp).toHaveBeenCalledTimes(1);
    // stored proposal carries the updated table for APPLY RATES
    expect(store.setJSON).toHaveBeenCalledWith('latest', expect.objectContaining({
      rates: expect.objectContaining({
        'Chase Sapphire Reserve': expect.objectContaining({ mccs: expect.objectContaining({ '5812': 4 }) }),
      }),
    }));
  });

  it('stays silent on low/medium confidence', async () => {
    const store = makeStore();
    const tg = vi.fn();
    const callClaude = vi.fn(async () => ({ mccs: { ...CSR.mccs, '5812': 4 }, default: 1, source: 'x', confidence: 'medium' }));

    const result = await runRateCheck({
      currentRates: { 'Chase Sapphire Reserve': CSR }, callClaude, store, notifyTelegram: tg, notifyInApp: vi.fn(),
    });

    expect(result.changed).toHaveLength(0);
    expect(result.proposalStored).toBe(false);
    expect(tg).not.toHaveBeenCalled();
    expect(store.setJSON).not.toHaveBeenCalled();
  });

  it('stays silent when high-confidence but no actual change', async () => {
    const store = makeStore();
    const tg = vi.fn();
    const callClaude = vi.fn(async () => ({ mccs: CSR.mccs, default: CSR.default, source: 'x', confidence: 'high' }));

    const result = await runRateCheck({
      currentRates: { 'Chase Sapphire Reserve': CSR }, callClaude, store, notifyTelegram: tg, notifyInApp: vi.fn(),
    });

    expect(result.changed).toHaveLength(0);
    expect(tg).not.toHaveBeenCalled();
  });

  it('skips a card when Claude returns null, continues with others', async () => {
    const store = makeStore();
    const tg = vi.fn();
    const callClaude = vi.fn(async (card) =>
      card === 'Chase Sapphire Reserve'
        ? null
        : { mccs: { ...AMEX.mccs, '7372': 5 }, default: 1, source: 'x', confidence: 'high' }
    );

    const result = await runRateCheck({
      currentRates: { 'Chase Sapphire Reserve': CSR, 'American Express Blue Cash Preferred': AMEX },
      callClaude, store, notifyTelegram: tg, notifyInApp: vi.fn(),
    });

    expect(result.changed).toHaveLength(1);
    expect(result.changed[0].card).toBe('American Express Blue Cash Preferred');
  });

  it('survives a Claude error for one card without aborting the run', async () => {
    const store = makeStore();
    const callClaude = vi.fn(async (card) => {
      if (card === 'Chase Sapphire Reserve') throw new Error('rate limited');
      return { mccs: { ...AMEX.mccs, '5541': 4 }, default: 1, source: 'x', confidence: 'high' };
    });

    const result = await runRateCheck({
      currentRates: { 'Chase Sapphire Reserve': CSR, 'American Express Blue Cash Preferred': AMEX },
      callClaude, store, notifyTelegram: vi.fn(), notifyInApp: vi.fn(),
    });

    expect(result.changed.map(c => c.card)).toEqual(['American Express Blue Cash Preferred']);
  });
});
