import { describe, it, expect } from 'vitest';
import { buildAccountOptions, FALLBACK_ACCOUNT_OPTIONS } from '../investAccountOptions.js';

describe('buildAccountOptions', () => {
  it('uses the real accounts (all types) when loaded', () => {
    const accounts = [
      { id: 'fidelity', name: 'Fidelity', type: 'brokerage' },
      { id: 'nro-mf', name: 'India MF (NRO)', type: 'mf_in' },
      { id: 'amex-hysa', name: 'Amex Savings', type: 'hysa' },
    ];
    expect(buildAccountOptions(accounts, [])).toEqual([
      ['fidelity', 'Fidelity'], ['nro-mf', 'India MF (NRO)'], ['amex-hysa', 'Amex Savings'],
    ]);
  });

  it('falls back to the default list, including nro-mf, when accounts are unloaded', () => {
    for (const none of [undefined, null, []]) {
      const opts = buildAccountOptions(none, []);
      expect(opts).toEqual(FALLBACK_ACCOUNT_OPTIONS);
      expect(opts.map(([id]) => id)).toContain('nro-mf');
    }
  });

  it('keeps a rule with an unknown account visible, labelled by its id, without duplicates', () => {
    const rules = [{ pattern: 'a', accountId: 'old-acct' }, { pattern: 'b', accountId: 'old-acct' }, { pattern: 'c', accountId: 'fidelity' }];
    const opts = buildAccountOptions([{ id: 'fidelity', name: 'Fidelity' }], rules);
    expect(opts).toEqual([['fidelity', 'Fidelity'], ['old-acct', 'old-acct']]);
  });

  it('does not mutate the fallback constant', () => {
    buildAccountOptions(null, [{ accountId: 'zzz' }]);
    expect(FALLBACK_ACCOUNT_OPTIONS).toHaveLength(4);
  });
});
