import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sendMock, reportMock, db } = vi.hoisted(() => {
  const docs = new Map(); // 'col/id' -> data
  const ctl = { failWrite: false };
  const database = {
    docs, ctl,
    collection: (col) => ({
      doc: (id) => ({
        id,
        get: async () => ({ exists: docs.has(`${col}/${id}`), data: () => structuredClone(docs.get(`${col}/${id}`)) }),
        set: async (v) => {
          if (ctl.failWrite) throw new Error('firestore down');
          docs.set(`${col}/${id}`, structuredClone(v));
        },
      }),
      get: async () => ({
        docs: [...docs.entries()].filter(([k]) => k.startsWith(`${col}/`))
          .map(([k, v]) => ({ id: k.split('/')[1], data: () => structuredClone(v) })),
      }),
    }),
  };
  return { sendMock: vi.fn(async () => ({ ok: true })), reportMock: vi.fn(async () => {}), db: database };
});

vi.mock('../../functions/lib/firestore.mjs', () => ({ getDb: () => db }));
vi.mock('../../functions/lib/_telegram.mjs', () => ({ sendMessage: sendMock }));
vi.mock('../../functions/lib/_error-log.mjs', () => ({ reportError: reportMock }));

const { recordActivity, runHeartbeat, activityId, resetActivityReportGate } =
  await import('../../functions/lib/_wallet-activity.mjs');

const HOUR = 3600e3, DAY = 24 * HOUR;
const T0 = new Date('2026-09-01T15:00:00Z');
const at = (ms) => new Date(T0.getTime() + ms);
const A = 'a@example.com';
const B = 'b@example.com';
const stored = (e) => db.docs.get(`wallet_activity/${activityId(e)}`);

beforeEach(() => {
  db.docs.clear();
  db.ctl.failWrite = false;
  vi.clearAllMocks();
  resetActivityReportGate();
});

describe('recordActivity', () => {
  it('upserts lastSeenAt, source and a running count keyed by a hash (no email in the id)', async () => {
    await recordActivity(A, 'android', { now: T0 });
    await recordActivity('A@Example.com', 'android', { now: at(HOUR) });
    expect(activityId(A)).not.toContain('example');
    expect(stored(A)).toMatchObject({
      email: A, lastSource: 'android', count: 2, lastSeenAt: at(HOUR).toISOString(), lastAlertedAt: null,
    });
  });

  it('clears lastAlertedAt so a phone that resumes and dies again re-alerts fresh', async () => {
    db.docs.set(`wallet_activity/${activityId(A)}`, { email: A, lastSeenAt: T0.toISOString(), count: 5, lastAlertedAt: at(DAY).toISOString() });
    await recordActivity(A, null, { now: at(5 * DAY) });
    expect(stored(A).lastAlertedAt).toBeNull();
    expect(stored(A).count).toBe(6);
  });

  it('fails open: a write failure never throws, and is reported at most once per window', async () => {
    db.ctl.failWrite = true;
    await expect(recordActivity(A, 's', { now: T0 })).resolves.toBeUndefined();
    await recordActivity(A, 's', { now: at(60e3) });
    await recordActivity(A, 's', { now: at(11 * 60e3) });
    expect(reportMock).toHaveBeenCalledTimes(2); // first, then after the 10-minute gate
    expect(reportMock.mock.calls[0][0]).toBe('WAL-006');
  });

  it('ignores a missing/invalid email without writing', async () => {
    await recordActivity('', 's', { now: T0 });
    await recordActivity('nope', 's', { now: T0 });
    expect(db.docs.size).toBe(0);
  });
});

describe('runHeartbeat', () => {
  const seed = (email, lastSeenMs, extra = {}) =>
    db.docs.set(`wallet_activity/${activityId(email)}`, { email, lastSeenAt: at(lastSeenMs).toISOString(), count: 3, lastAlertedAt: null, ...extra });
  const run = (now) => runHeartbeat({ now, chatId: '111', primaryEmail: 'p@example.com' });

  it('stays quiet at 3d 23h 59m of silence', async () => {
    seed(A, 0);
    const r = await run(at(4 * DAY - 60e3));
    expect(sendMock).not.toHaveBeenCalled();
    expect(r.alerted).toBe(0);
  });

  it('alerts at 4 days, to the given chat, naming the email, days and last-seen date', async () => {
    seed(A, 0);
    await run(at(4 * DAY));
    expect(sendMock).toHaveBeenCalledTimes(1);
    const [chat, text] = sendMock.mock.calls[0];
    expect(chat).toBe('111');
    expect(text).toContain('📵 No wallet activity from a@example.com in 4 days');
    expect(text).toContain('last seen 2026-09-01');
    expect(text).toContain('Automate battery-optimization/app running, or Shortcuts automation.');
    expect(stored(A).lastAlertedAt).toBe(at(4 * DAY).toISOString());
  });

  it('re-alerts only every ~3 days (71h slack for the daily 08:00 drift)', async () => {
    seed(A, 0);
    await run(at(4 * DAY));
    await run(at(5 * DAY));
    await run(at(6 * DAY));
    expect(sendMock).toHaveBeenCalledTimes(1);
    await run(at(4 * DAY + 71 * HOUR));
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sendMock.mock.calls[1][1]).toContain('in 6 days');
  });

  it('is silent when activity resumes, and never alerts about a live phone', async () => {
    seed(A, 0);
    await run(at(4 * DAY));
    await recordActivity(A, 'android', { now: at(4 * DAY + HOUR) });
    sendMock.mockClear();
    await run(at(5 * DAY));
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('tracks each email independently', async () => {
    seed(A, 0);
    seed(B, 3 * DAY);
    await run(at(4 * DAY));
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][1]).toContain('a@example.com');
  });

  it('keeps lastAlertedAt unset if the send fails, so tomorrow retries', async () => {
    seed(A, 0);
    sendMock.mockRejectedValueOnce(new Error('telegram down'));
    const r = await run(at(4 * DAY));
    expect(r.alerted).toBe(0);
    expect(stored(A).lastAlertedAt).toBeNull();
    await run(at(5 * DAY));
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it('skips docs with an unreadable lastSeenAt instead of alerting', async () => {
    db.docs.set('wallet_activity/x', { email: A, lastSeenAt: 'garbage' });
    await run(at(9 * DAY));
    expect(sendMock).not.toHaveBeenCalled();
  });
});
