/**
 * The household's funds and where each one lives. One entry per SCHEME (not per
 * Direct/Regular plan variant: the portfolio is identical across a scheme's
 * plans). All four SBI Retirement sub-plans are tracked because which one is
 * held is not pinned down; parsers and storage never depend on that choice.
 *
 * `sheet` is the AMC's own sheet code; `titleRe` is matched against the text in
 * the sheet's first rows so a renamed/shuffled sheet fails loudly instead of
 * silently ingesting another scheme's portfolio.
 */
export const HOUSES = ['absl', 'sbi', 'iti'];

export const FUND_REGISTRY = [
  { fundKey: 'absl-flexi-cap', house: 'absl', label: 'Aditya Birla Sun Life Flexi Cap Fund', sheet: 'BSLEQTY', titleRe: /ADITYA BIRLA SUN LIFE FLEXI CAP FUND/ },
  { fundKey: 'absl-conglomerate', house: 'absl', label: 'Aditya Birla Sun Life Conglomerate Fund', sheet: 'ABSLCONF', titleRe: /ADITYA BIRLA SUN LIFE CONGLOMERATE FUND/ },
  { fundKey: 'iti-small-cap', house: 'iti', label: 'ITI Small Cap Fund', sheet: 'ITISCF', titleRe: /ITI SMALL CAP FUND/ },
  { fundKey: 'sbi-retirement-aggressive-hybrid', house: 'sbi', label: 'SBI Retirement Benefit Fund - Aggressive Hybrid Plan', sheet: 'SRBF-AHP', titleRe: /SBI RETIREMENT BENEFIT FUND\s*-\s*AGGRESSIVE HYBRID PLAN/ },
  { fundKey: 'sbi-retirement-aggressive', house: 'sbi', label: 'SBI Retirement Benefit Fund - Aggressive Plan', sheet: 'SRBF-AP', titleRe: /SBI RETIREMENT BENEFIT FUND\s*-\s*AGGRESSIVE PLAN/ },
  { fundKey: 'sbi-retirement-conservative-hybrid', house: 'sbi', label: 'SBI Retirement Benefit Fund - Conservative Hybrid Plan', sheet: 'SRBF-CHP', titleRe: /SBI RETIREMENT BENEFIT FUND\s*-\s*CONSERVATIVE HYBRID PLAN/ },
  { fundKey: 'sbi-retirement-conservative', house: 'sbi', label: 'SBI Retirement Benefit Fund - Conservative Plan', sheet: 'SRBF-CP', titleRe: /SBI RETIREMENT BENEFIT FUND\s*-\s*CONSERVATIVE PLAN/ },
];

export const FUND_KEYS = FUND_REGISTRY.map(f => f.fundKey);

export const fundsOfHouse = (house) => FUND_REGISTRY.filter(f => f.house === house);
