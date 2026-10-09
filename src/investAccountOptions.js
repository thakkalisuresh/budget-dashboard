// Account choices for the flow-through rule dropdowns in Settings → Investing.
// Pure so it can be tested: real accounts when loaded, else a fallback list; a rule
// pointing at an account that is not in the list is still shown (id as its label).

export const FALLBACK_ACCOUNT_OPTIONS = [
  ['fidelity', 'Fidelity'],
  ['amex-hysa', 'Amex Savings'],
  ['happen-hysa', 'Happen Bank'],
  ['nro-mf', 'India MF (NRO)'],
];

export function buildAccountOptions(accounts, rules = []) {
  const real = (accounts || []).filter(a => a?.id).map(a => [a.id, a.name || a.id]);
  const options = real.length ? real : FALLBACK_ACCOUNT_OPTIONS.map(o => [...o]);
  const known = new Set(options.map(([id]) => id));
  for (const r of rules || []) {
    if (r?.accountId && !known.has(r.accountId)) {
      known.add(r.accountId);
      options.push([r.accountId, r.accountId]);
    }
  }
  return options;
}
