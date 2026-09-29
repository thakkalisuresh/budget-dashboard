import { describe, it, expect, vi, beforeEach } from 'vitest';

const { digestSend, nudgeMock, heartMock, primaryMock, colGet } = vi.hoisted(() => ({
  digestSend: vi.fn(async () => ({ ok: true })),
  nudgeMock: vi.fn(async () => ({ nudged: 0 })),
  heartMock: vi.fn(async () => ({ alerted: 0 })),
  primaryMock: vi.fn(async () => 'p@example.com'),
  colGet: vi.fn(),
}));

vi.mock('../../functions/lib/firestore.mjs', () => ({
  getDb: () => {
    const col = { where: () => col, limit: () => col, get: colGet, firestore: { batch: () => ({ update() {}, delete() {}, commit: async () => {} }) } };
    return { collection: () => col };
  },
}));
vi.mock('../../functions/lib/_telegram.mjs', () => ({
  sendMessage: digestSend,
  resolveTelegramChatId: (e) => ({ 'p@example.com': '111', 'first@example.com': '222' })[e] || null,
}));
vi.mock('../../functions/lib/_household.mjs', () => ({
  getPrimaryEmail: primaryMock,
  resolvePromptChatId: async (e) => ({ 'p@example.com': '111', 'first@example.com': '222' })[e] || null,
}));
vi.mock('../../functions/lib/_parked-nudge.mjs', () => ({ runParkedNudge: nudgeMock }));
vi.mock('../../functions/lib/_wallet-activity.mjs', () => ({ runHeartbeat: heartMock }));
vi.mock('../../functions/lib/_error-log.mjs', async () => ({
  ...(await vi.importActual('../../functions/lib/_error-log.mjs')),
  reportError: vi.fn(async () => {}),
}));
vi.mock('firebase-functions/v2/scheduler', () => ({ onSchedule: (_o, fn) => fn }));
vi.mock('../../functions/lib/secrets.mjs', () => ({
  TELEGRAM_BOT_TOKEN: 'k', TELEGRAM_EMAIL_MAP: 'k', ALLOWED_EMAILS: 'k', SHEETS_DRIVE_SECRETS: [],
}));

const { errorDigest, runDailyChecks } = await import('../../functions/error-digest.mjs');

const snap = (docs) => ({ empty: docs.length === 0, size: docs.length, docs: docs.map((d, i) => ({ id: `d${i}`, ref: `r${i}`, data: () => d })) });
const NOW = new Date('2026-09-10T15:00:00Z');

beforeEach(() => {
  vi.clearAllMocks();
  primaryMock.mockResolvedValue('p@example.com');
  nudgeMock.mockResolvedValue({ nudged: 0 });
  heartMock.mockResolvedValue({ alerted: 0 });
  colGet.mockResolvedValue(snap([]));
  vi.stubEnv('ALLOWED_EMAILS', 'first@example.com,second@example.com');
});

describe('daily run', () => {
  it('runs the nudge and heartbeat even when there are no errors, and sends no digest', async () => {
    await runDailyChecks({ now: NOW });
    expect(digestSend).not.toHaveBeenCalled();
    expect(nudgeMock).toHaveBeenCalledWith({ now: NOW, primaryEmail: 'p@example.com', primaryChatId: '111' });
    expect(heartMock).toHaveBeenCalledWith({ now: NOW, primaryEmail: 'p@example.com', chatId: '111' });
  });

  it("sends the error digest to the primary's chat (not first-of-ALLOWED_EMAILS)", async () => {
    colGet.mockResolvedValue(snap([{ code: 'WAL-002', fingerprint: 'x', message: 'boom', at: '2026-09-10T01:00:00Z', severity: 'fatal', title: 't' }]));
    await runDailyChecks({ now: NOW });
    expect(digestSend).toHaveBeenCalledTimes(1);
    expect(digestSend.mock.calls[0][0]).toBe('111');
  });

  it('falls back to the first ALLOWED_EMAILS entry when the primary is unset', async () => {
    primaryMock.mockResolvedValue('');
    colGet.mockResolvedValue(snap([{ code: 'WAL-002', fingerprint: 'x', message: 'boom', at: '2026-09-10T01:00:00Z', severity: 'fatal', title: 't' }]));
    await runDailyChecks({ now: NOW });
    expect(digestSend.mock.calls[0][0]).toBe('222');
    expect(nudgeMock).toHaveBeenCalledWith(expect.objectContaining({ primaryEmail: 'first@example.com', primaryChatId: '222' }));
    expect(heartMock).toHaveBeenCalled();
  });

  it('the scheduled handler works with the primary unset', async () => {
    primaryMock.mockResolvedValue('');
    await expect(errorDigest()).resolves.toBeUndefined();
    expect(nudgeMock).toHaveBeenCalled();
    expect(heartMock).toHaveBeenCalled();
  });

  it('does nothing (and does not throw) when neither primary nor ALLOWED_EMAILS is configured', async () => {
    primaryMock.mockResolvedValue('');
    vi.stubEnv('ALLOWED_EMAILS', '');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(errorDigest()).resolves.toBeUndefined();
    expect(nudgeMock).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a throwing nudge does not stop the heartbeat or the digest', async () => {
    nudgeMock.mockRejectedValue(new Error('nudge boom'));
    colGet.mockResolvedValue(snap([{ code: 'WAL-002', fingerprint: 'x', message: 'boom', at: '2026-09-10T01:00:00Z', severity: 'fatal', title: 't' }]));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(runDailyChecks({ now: NOW })).resolves.toBeDefined();
    expect(digestSend).toHaveBeenCalledTimes(1);
    expect(heartMock).toHaveBeenCalled();
    err.mockRestore();
  });

  it('a throwing heartbeat does not stop the nudge or the digest', async () => {
    heartMock.mockRejectedValue(new Error('hb boom'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await runDailyChecks({ now: NOW });
    expect(nudgeMock).toHaveBeenCalled();
    err.mockRestore();
  });

  it('a throwing digest read does not stop the nudge or the heartbeat', async () => {
    colGet.mockRejectedValue(new Error('read boom'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await runDailyChecks({ now: NOW });
    expect(nudgeMock).toHaveBeenCalled();
    expect(heartMock).toHaveBeenCalled();
    err.mockRestore();
  });
});
