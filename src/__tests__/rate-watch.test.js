import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { sheetIdMock, accountsMock, appendMock, sendMock, pushMock, reportMock } = vi.hoisted(() => ({
  sheetIdMock: vi.fn(),
  accountsMock: vi.fn(),
  appendMock: vi.fn(async () => {}),
  sendMock: vi.fn(async () => ({ ok: true })),
  pushMock: vi.fn(async () => ({ sent: true })),
  reportMock: vi.fn(async () => {}),
}));

vi.mock('../../functions/lib/_invest-sheets.mjs', () => ({
  getInvestSheetId: sheetIdMock,
  fetchInvestAccounts: accountsMock,
  appendRateWatchRow: appendMock,
}));
vi.mock('../../functions/lib/_telegram.mjs', () => ({
  sendMessage: sendMock,
  resolveTelegramChatId: (email) => (email === 'me@example.com' ? '111222333' : null),
}));
vi.mock('../../functions/lib/_push.mjs', () => ({ sendPushToEmail: pushMock }));
vi.mock('../../functions/lib/_error-log.mjs', () => ({ reportError: reportMock }));
vi.mock('firebase-functions/v2/scheduler', () => ({ onSchedule: (_opts, fn) => fn }));
vi.mock('../../functions/lib/secrets.mjs', () => ({
  GEMINI_API_KEY: 'k', TELEGRAM_BOT_TOKEN: 'k', TELEGRAM_EMAIL_MAP: 'k',
  VAPID_PUBLIC_KEY: 'k', VAPID_PRIVATE_KEY: 'k', VAPID_EMAIL: 'k', SHEETS_DRIVE_SECRETS: [],
}));

const {
  runRateWatch, detectProposals, buildRateWatchDigest, buildPushBody,
} = await import('../../functions/rate-watch.mjs');

const hysa = (id, name, apy) => ({ id, name, type: 'hysa', institution: name, apy, balance: 10000 });

/** Stub Gemini's grounded response: candidates[0].content.parts[].text holds JSON. */
function geminiReturns(obj) {
  const payload = { candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] };
  global.fetch = vi.fn(async () => ({ ok: true, json: async () => payload }));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('GEMINI_API_KEY', 'test-gemini-key');
  sheetIdMock.mockResolvedValue('inv-1');
  accountsMock.mockResolvedValue([hysa('amex-hysa', 'Amex Savings', 3.7), hysa('happen-hysa', 'Happen Bank', 4.4)]);
});

afterEach(() => vi.unstubAllEnvs());

/* ── Pure: rate-diff detection ──────────────────────────────────────────── */
describe('detectProposals', () => {
  const accounts = [hysa('amex-hysa', 'Amex Savings', 3.7)];

  it('proposes when the advertised rate differs from the stored one', () => {
    const out = detectProposals(accounts, [{ id: 'amex-hysa', advertisedApy: 3.85, effectiveDate: '2026-10-01' }]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ accountId: 'amex-hysa', bank: 'Amex Savings', currentApy: 3.7, proposedApy: 3.85, effectiveDate: '2026-10-01' });
  });

  it('proposes nothing when advertised equals stored', () => {
    expect(detectProposals(accounts, [{ id: 'amex-hysa', advertisedApy: 3.7 }])).toHaveLength(0);
  });

  it('defaults effectiveDate to today and ignores unknown ids / junk rates', () => {
    const out = detectProposals(accounts, [
      { id: 'amex-hysa', advertisedApy: 4.0 },
      { id: 'ghost', advertisedApy: 9 },
      { id: 'amex-hysa', advertisedApy: 0 },
    ], { now: '2026-10-07' });
    expect(out).toHaveLength(1);
    expect(out[0].effectiveDate).toBe('2026-10-07');
  });
});

/* ── Pure: digest formatting ────────────────────────────────────────────── */
describe('buildRateWatchDigest', () => {
  it('formats a better-rate finding', () => {
    const msg = buildRateWatchDigest({ bestBank: 'Openbank', bestApy: 4.75, yourBestApy: 4.4, delta: 0.35, proposals: [] });
    expect(msg).toContain('Openbank');
    expect(msg).toContain('4.75%');
    expect(msg).toContain('+0.35%');
  });

  it('lists held-bank proposals even when no market rate beats yours', () => {
    const msg = buildRateWatchDigest({
      bestBank: 'Openbank', bestApy: 4.0, yourBestApy: 4.4, delta: 0,
      proposals: [{ bank: 'Amex Savings', currentApy: 3.7, proposedApy: 3.85, effectiveDate: '2026-10-01' }],
    });
    expect(msg).toContain('top of the market');
    expect(msg).toContain('Amex Savings now advertises 3.85%');
  });

  it('returns null when there is nothing to report (no digest sent)', () => {
    expect(buildRateWatchDigest({ bestBank: 'Openbank', bestApy: 4.0, yourBestApy: 4.4, delta: 0, proposals: [] })).toBeNull();
    expect(buildRateWatchDigest({})).toBeNull();
  });
});

describe('buildPushBody', () => {
  it('summarizes proposals when present', () => {
    expect(buildPushBody({ proposals: [{}, {}] })).toBe('2 held-bank rate changes to confirm');
  });
  it('summarizes a better rate when no proposals', () => {
    expect(buildPushBody({ bestBank: 'Openbank', bestApy: 4.75, delta: 0.35 })).toContain('Openbank');
  });
  it('is empty when nothing to say', () => {
    expect(buildPushBody({ delta: 0, proposals: [] })).toBe('');
  });
});

/* ── Orchestration (lib boundaries mocked, Gemini fetch stubbed) ─────────── */
describe('runRateWatch', () => {
  it('no-ops when the invest sheet was never provisioned', async () => {
    sheetIdMock.mockResolvedValue(null);
    const out = await runRateWatch({ email: 'me@example.com' });
    expect(out.reason).toBe('no_invest_sheet');
    expect(appendMock).not.toHaveBeenCalled();
  });

  it('writes the scan but sends no digest when nothing beats you and no bank moved', async () => {
    geminiReturns({
      alternatives: [{ bank: 'Openbank', apy: 4.0 }],              // below your 4.4
      advertised: [{ id: 'amex-hysa', advertisedApy: 3.7 }, { id: 'happen-hysa', advertisedApy: 4.4 }],
    });
    const out = await runRateWatch({ email: 'me@example.com' });
    expect(appendMock).toHaveBeenCalledOnce();
    expect(out.digested).toBe(false);
    expect(sendMock).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('writes proposals, sends Telegram + push when a better rate and a change are found', async () => {
    geminiReturns({
      alternatives: [{ bank: 'Openbank', apy: 4.75 }, { bank: 'Pibank', apy: 4.6 }],
      advertised: [{ id: 'amex-hysa', advertisedApy: 3.85, effectiveDate: '2026-10-01' }],
    });
    const out = await runRateWatch({ email: 'me@example.com', now: new Date('2026-10-07T13:00:00Z') });

    expect(out).toMatchObject({ scanned: true, best: 'Openbank', proposals: 1, digested: true });
    const row = appendMock.mock.calls[0][1];
    expect(row.bestBank).toBe('Openbank');
    expect(row.bestApy).toBe(4.75);
    expect(row.delta).toBeCloseTo(0.35, 5);
    expect(row.proposals[0]).toMatchObject({ accountId: 'amex-hysa', proposedApy: 3.85 });
    expect(sendMock).toHaveBeenCalledOnce();
    expect(pushMock).toHaveBeenCalledOnce();
  });

  it('reports INV-001 and sends nothing when the scan fails', async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({ error: { message: 'overloaded' } }) }));
    const out = await runRateWatch({ email: 'me@example.com' });
    expect(out.reason).toBe('scan_failed');
    expect(reportMock).toHaveBeenCalledWith('INV-001', expect.any(Error), expect.any(Object));
    expect(appendMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });
});
