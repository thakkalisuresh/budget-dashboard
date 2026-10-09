import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../sheetInvest.js', () => ({
  appendActivities: vi.fn(async () => ['act_new']),
  updateAccount: vi.fn(async () => {}),
  fetchAccounts: vi.fn(),
}));
vi.mock('../useInvestData.js', () => ({ investCache: new Map() }));

import { mirrorInvestContribution, matchInvestAccount } from '../investFlowThrough.js';
import { appendActivities, updateAccount, fetchAccounts } from '../sheetInvest.js';

const settings = {
  investSheetId: 'sheet1',
  investAccountRules: [
    { pattern: 'wise', accountId: 'nro-mf' },
    { pattern: 'remitly', accountId: 'nro-mf' },
    { pattern: 'fidelity', accountId: 'fidelity' },
    { pattern: 'amex', accountId: 'amex-hysa' },
  ],
};
const ACCOUNTS = [
  { id: 'nro-mf', type: 'mf_in', balance: 0, currency: 'INR' },
  { id: 'fidelity', type: 'brokerage', balance: 0 },
  { id: 'amex-hysa', type: 'hysa', balance: 1000 },
];

beforeEach(() => { vi.clearAllMocks(); fetchAccounts.mockResolvedValue(ACCOUNTS); });

describe('mirrorInvestContribution — mf_in', () => {
  it('Wise/Remitly vendors route to nro-mf as an explicit USD deposit, no balance bump', async () => {
    const r = await mirrorInvestContribution({ settings, accessToken: 't', vendor: 'Wise Transfer', amount: 240, txDate: '2026-11-02' });
    expect(appendActivities).toHaveBeenCalledWith('sheet1', 't', [expect.objectContaining({
      accountId: 'nro-mf', type: 'DEPOSIT', amount: 240, currency: 'USD', fxToUsd: 1, date: '2026-11-02',
    })]);
    expect(updateAccount).not.toHaveBeenCalled();
    expect(r).toMatchObject({ mirrored: true, accountId: 'nro-mf', depositUuid: 'act_new', needsInrReceipt: true, needsItemization: false });
  });
  it('remitly matches too', async () => {
    expect(matchInvestAccount('REMITLY', settings.investAccountRules)).toBe('nro-mf');
  });
  it('is non-fatal when the sheet write fails', async () => {
    appendActivities.mockRejectedValueOnce(new Error('boom'));
    const r = await mirrorInvestContribution({ settings, accessToken: 't', vendor: 'wise', amount: 240 });
    expect(r).toEqual({ mirrored: false });
  });
});

describe('mirrorInvestContribution — unchanged paths', () => {
  it('HYSA still bumps the balance and needs no INR receipt', async () => {
    const r = await mirrorInvestContribution({ settings, accessToken: 't', vendor: 'Amex', amount: 500 });
    expect(updateAccount).toHaveBeenCalledWith('sheet1', 't', 'amex-hysa', { balance: 1500 });
    expect(r).toMatchObject({ mirrored: true, needsInrReceipt: false, needsItemization: false });
  });
  it('brokerage flags itemization', async () => {
    const r = await mirrorInvestContribution({ settings, accessToken: 't', vendor: 'Fidelity', amount: 500 });
    expect(r).toMatchObject({ needsItemization: true, needsInrReceipt: false });
  });
});
