import { describe, it, expect, vi, beforeEach } from 'vitest';

const { addMock, sendMock, getMock, batchMock, commitMock, deleteMock, updateMock, alertStore } = vi.hoisted(() => ({
  alertStore: new Map(),
  addMock: vi.fn(),
  sendMock: vi.fn(async () => ({ ok: true })),
  getMock: vi.fn(),
  batchMock: vi.fn(),
  commitMock: vi.fn(async () => {}),
  deleteMock: vi.fn(),
  updateMock: vi.fn(),
}));

// Minimal Firestore stand-in: query chain + batch.
vi.mock('../../functions/lib/firestore.mjs', () => ({
  getDb: () => ({
    collection: (name) => {
      // error_alerts is a real keyed store so the cooldown can be exercised;
      // error_log keeps the query-chain stub the digest tests rely on.
      if (name === 'error_alerts') {
        return {
          doc: (id) => ({
            get: async () => ({ exists: alertStore.has(id), data: () => alertStore.get(id) }),
            set: async (v) => { alertStore.set(id, v); },
          }),
        };
      }
      const col = {
        add: addMock,
        doc: (id) => ({ id }),
        where: () => col,
        limit: () => col,
        get: getMock,
        firestore: { batch: () => ({ update: updateMock, delete: deleteMock, commit: commitMock }) },
      };
      return col;
    },
  }),
}));
vi.mock('../../functions/lib/_telegram.mjs', () => ({
  sendMessage: sendMock,
  resolveTelegramChatId: (email) => (email === 'me@example.com' ? '111' : null),
}));
vi.mock('firebase-functions/v2/scheduler', () => ({ onSchedule: (_o, fn) => fn }));
vi.mock('../../functions/lib/secrets.mjs', () => ({ TELEGRAM_BOT_TOKEN: 'k', TELEGRAM_EMAIL_MAP: 'k', ALLOWED_EMAILS: 'k' }));

const { reportError, fingerprint, groupErrors, buildDigest, sanitizeContext } =
  await import('../../functions/lib/_error-log.mjs');
const { runErrorDigest } = await import('../../functions/error-digest.mjs');

const snap = (docs) => ({ empty: docs.length === 0, size: docs.length, docs: docs.map((d, i) => ({ id: `d${i}`, ref: `r${i}`, data: () => d })) });

beforeEach(() => {
  vi.clearAllMocks();
  addMock.mockResolvedValue(undefined);
  sendMock.mockResolvedValue({ ok: true });
  getMock.mockResolvedValue(snap([]));
  commitMock.mockResolvedValue(undefined);
});

describe('fingerprint', () => {
  it('collapses the variable parts so the same failure groups', () => {
    // These are the same failure; only a row number and a uuid differ.
    const a = fingerprint('SHT-004', 'Row with UUID tx_8850_ab12cd34 not found at row 17');
    const b = fingerprint('SHT-004', 'Row with UUID tx_2200_ff99ee88 not found at row 42');
    expect(a).toBe(b);
  });

  it('keeps genuinely different failures apart', () => {
    expect(fingerprint('SHT-004', 'Row not found')).not.toBe(fingerprint('SHT-002', 'Row not found'));
    expect(fingerprint('SHT-001', 'Sheets API rate limited')).not.toBe(fingerprint('SHT-001', 'Sheets API forbidden'));
  });
});

describe('reportError', () => {
  it('logs the code and persists it', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await reportError('WAL-002', new Error('append blew up'), { vendor: 'Costco', amount: 89.5 });

    expect(spy.mock.calls[0][0]).toContain('WAL-002 — Wallet transaction write failed');
    const doc = addMock.mock.calls[0][0];
    expect(doc).toMatchObject({ code: 'WAL-002', severity: 'fatal', reported: false });
    expect(doc.context).toEqual({ vendor: 'Costco', amount: '89.5' });
    spy.mockRestore();
  });

  it('never throws when Firestore is unavailable', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    addMock.mockRejectedValue(new Error('firestore down'));

    // An error reporter that throws turns a handled degradation into a crash.
    await expect(reportError('SHT-009', new Error('boom'))).resolves.toBeUndefined();
    expect(err).toHaveBeenCalled();   // original error still logged
    err.mockRestore(); warn.mockRestore();
  });

  it('drops objects from context so nothing bulky or sensitive is stored', () => {
    expect(sanitizeContext({ ok: 'yes', n: 5, nested: { token: 'secret' }, missing: null }))
      .toEqual({ ok: 'yes', n: '5' });
  });
});

describe('groupErrors', () => {
  it('counts repeats of one failure as a single group', () => {
    const groups = groupErrors([
      { code: 'SHT-001', fingerprint: 'SHT-001:x', message: 'a', at: '2026-05-10T01:00:00Z' },
      { code: 'SHT-001', fingerprint: 'SHT-001:x', message: 'a', at: '2026-05-10T02:00:00Z' },
      { code: 'WAL-002', fingerprint: 'WAL-002:y', message: 'b', at: '2026-05-10T03:00:00Z' },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ code: 'SHT-001', count: 2 });
    expect(groups[0].first).toBe('2026-05-10T01:00:00Z');
    expect(groups[0].last).toBe('2026-05-10T02:00:00Z');
  });

  it('puts the most frequent failure first', () => {
    const groups = groupErrors([
      { code: 'A-001', fingerprint: 'a', at: '1' },
      { code: 'B-001', fingerprint: 'b', at: '1' },
      { code: 'B-001', fingerprint: 'b', at: '2' },
    ]);
    expect(groups[0].code).toBe('B-001');
  });
});

describe('buildDigest', () => {
  it('leads with the code and flags severity', () => {
    const text = buildDigest([
      { code: 'WAL-002', severity: 'fatal', title: 'Wallet transaction write failed', message: 'boom', count: 3, context: { vendor: 'Costco' } },
    ], 'today');
    expect(text).toContain('🔴 3× WAL-002 — Wallet transaction write failed');
    expect(text).toContain('vendor=Costco');
    expect(text).toContain('docs/ERROR_CODES.md');
  });

  it('returns null when there is nothing to report', () => {
    expect(buildDigest([], 'today')).toBeNull();
  });
});

describe('runErrorDigest', () => {
  const errDoc = (code, at = '2026-05-10T01:00:00Z') =>
    ({ code, severity: 'fatal', title: 't', message: 'm', fingerprint: `${code}:m`, at, reported: false });

  it('stays silent when nothing broke', async () => {
    const out = await runErrorDigest({ email: 'me@example.com' });
    expect(out).toMatchObject({ sent: false, reason: 'no_errors' });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('sends one digest and marks the errors reported', async () => {
    getMock.mockResolvedValue(snap([errDoc('WAL-002'), errDoc('WAL-002'), errDoc('SHT-001')]));
    const out = await runErrorDigest({ email: 'me@example.com' });

    expect(out).toMatchObject({ sent: true, errors: 3, groups: 2 });
    expect(sendMock).toHaveBeenCalledOnce();
    // Marked so the next run doesn't repeat them.
    expect(updateMock).toHaveBeenCalledTimes(3);
  });

  it('leaves errors unreported when the send fails, so they are not lost', async () => {
    getMock.mockResolvedValue(snap([errDoc('WAL-002')]));
    sendMock.mockRejectedValue(new Error('telegram down'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    const out = await runErrorDigest({ email: 'me@example.com' });
    expect(out).toMatchObject({ sent: false, reason: 'send_failed' });
    expect(updateMock).not.toHaveBeenCalled();
    err.mockRestore();
  });

  it('does not mark anything reported when there is no chat to send to', async () => {
    getMock.mockResolvedValue(snap([errDoc('WAL-002')]));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const out = await runErrorDigest({ email: 'stranger@example.com' });
    expect(out).toMatchObject({ sent: false, reason: 'no_chat_id' });
    expect(updateMock).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('survives the error log being unreadable', async () => {
    getMock.mockRejectedValue(new Error('firestore down'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = await runErrorDigest({ email: 'me@example.com' });
    expect(out).toMatchObject({ sent: false, reason: 'read_failed' });
    err.mockRestore();
  });
});

/* ── Instant alerts for fatal errors ── */

describe('reportError — instant fatal alert', () => {
  beforeEach(() => {
    vi.stubEnv('ALLOWED_EMAILS', 'me@example.com');
    alertStore.clear();
  });

  it('alerts immediately on a fatal error', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await reportError('WAL-002', new Error('append blew up'), { vendor: 'Costco' });

    expect(sendMock).toHaveBeenCalledOnce();
    const text = sendMock.mock.calls[0][1];
    expect(text).toContain('WAL-002 — Wallet transaction write failed');
    expect(text).toContain('append blew up');
    expect(text).toContain('vendor=Costco');
    // The catalogue's fix text travels with the alert — the point is to be
    // actionable at 2am without looking anything up.
    expect(text).toContain('Add it manually');
    err.mockRestore();
  });

  it('does NOT alert on degraded or config severities', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await reportError('DRV-002', new Error('drive down'));   // degraded
    await reportError('CFG-005', new Error('no key'));       // config
    expect(sendMock).not.toHaveBeenCalled();
    err.mockRestore();
  });

  it('sends once per distinct failure per hour, not once per occurrence', async () => {
    // The storm case: Sheets rate-limits and the same failure fires repeatedly.
    // Forty messages would get the bot muted, and then the alert that matters
    // is muted too.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (let i = 0; i < 5; i++) {
      await reportError('SHT-009', new Error(`Sheets API (500): row ${i}`));
    }
    expect(sendMock).toHaveBeenCalledOnce();
    err.mockRestore();
  });

  it('still alerts for a DIFFERENT fatal failure during the cooldown', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await reportError('SHT-009', new Error('Sheets API (500): row 1'));
    await reportError('WAL-002', new Error('totally different failure'));
    expect(sendMock).toHaveBeenCalledTimes(2);
    err.mockRestore();
  });

  it('alerts again once the cooldown has expired', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await reportError('SHT-009', new Error('Sheets API (500): row 1'));
    expect(sendMock).toHaveBeenCalledOnce();

    // Age the stored alert past the window.
    for (const [k, v] of alertStore) {
      alertStore.set(k, { ...v, lastAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() });
    }
    await reportError('SHT-009', new Error('Sheets API (500): row 2'));
    expect(sendMock).toHaveBeenCalledTimes(2);
    err.mockRestore();
  });

  it('stays silent when there is no Telegram mapping', async () => {
    vi.stubEnv('ALLOWED_EMAILS', 'stranger@example.com');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await reportError('WAL-002', new Error('boom'));
    expect(sendMock).not.toHaveBeenCalled();
    err.mockRestore();
  });

  it('never throws when Telegram is down — the digest is the backstop', async () => {
    sendMock.mockRejectedValue(new Error('telegram unreachable'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(reportError('WAL-002', new Error('boom'))).resolves.toBeUndefined();
    err.mockRestore(); warn.mockRestore();
  });
});
