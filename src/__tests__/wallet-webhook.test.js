import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { localToday } from '../../functions/lib/_time.mjs';
import { createFakeDb } from './helpers/fake-firestore.js';

// Backs the duplicate guard's transactional claims (real bot-store code over an
// in-memory Firestore double); blobs still go to splitStore below.
const fakeDb = createFakeDb();

// firebase-admin is only installed under functions/; the store just needs these two symbols.
vi.mock('firebase-admin/firestore', () => ({
  FieldPath: { documentId: () => '__name__' },
  Timestamp: { fromMillis: (ms) => ({ ms }) },
}));

vi.stubEnv('WALLET_WEBHOOK_SECRET', 'test-wallet-secret');

// Shared mock state (hoisted so the vi.mock factories can close over it).
const { activityMock, extractMock, appendMock, sheetIdMock, webpushSend, getSettingsMock, telegramSend, splitStore, ctl, recentMock, reportErrorMock } = vi.hoisted(() => ({
  activityMock: vi.fn(async () => {}),
  reportErrorMock: vi.fn(async () => {}),
  recentMock: vi.fn(async () => []),
  extractMock: vi.fn(),
  appendMock: vi.fn(),
  sheetIdMock: vi.fn(),
  webpushSend: vi.fn(),
  getSettingsMock: vi.fn(async () => ({})),
  telegramSend: vi.fn(async () => ({ ok: true })),
  splitStore: {
    data: new Map(),
    get(key) { return Promise.resolve(this.data.get(key) || null); },
    setJSON(key, value) { this.data.set(key, value); return Promise.resolve(); },
    delete(key) { this.data.delete(key); return Promise.resolve(); },
    list({ prefix }) {
      const blobs = [];
      for (const key of this.data.keys()) if (key.startsWith(prefix)) blobs.push({ key });
      return Promise.resolve({ blobs });
    },
  },
  ctl: { pushDoc: null, deleted: false, household: null, householdThrows: false },
}));

vi.mock('../../functions/lib/_extraction.mjs', () => ({
  extractTransactionText: extractMock,
  CATEGORIES: ['Grocery', 'Eating Out', 'Misc', 'Travel', 'Entertainment', 'Health', 'Utilities'],
}));
vi.mock('../../functions/lib/_sheets.mjs', () => ({
  appendExpense: appendMock,
  getCurrentMonthSheetId: sheetIdMock,
  // Required by the duplicate check. Its absence made every wallet test throw
  // inside that check, get swallowed as non-fatal, and silently skip the
  // dedup path entirely — so #60's wallet half was never actually exercised.
  getRecentExpenses: (...args) => recentMock(...args),
  // Default: no per-user settings (no disabled/split vendors). Tests that need
  // these override the mock via getSettingsMock.
  getUserSettingsByEmail: (...args) => getSettingsMock(...args),
}));
vi.mock('web-push', () => ({ default: { setVapidDetails: vi.fn(), sendNotification: webpushSend } }));
// Mocked so the validation tests can assert a rejected charge is actually
// reported. The real reportError writes to Firestore and Telegram-alerts on
// fatal codes; neither belongs in a unit test.
vi.mock('../../functions/lib/_error-log.mjs', () => ({ reportError: reportErrorMock }));
// Heartbeat write is unit-tested in wallet-activity.test.js; here we only check when the webhook calls it.
vi.mock('../../functions/lib/_wallet-activity.mjs', () => ({ recordActivity: activityMock }));
// The wallet split path builds a bot store + sends Telegram; stub both so the
// import chain doesn't pull in firebase-admin and no real network calls fire.
vi.mock('../../functions/lib/bot-store.mjs', async () => {
  const actual = await vi.importActual('../../functions/lib/bot-store.mjs');
  const claims = actual.createBotStore(fakeDb);
  return {
    createBotStore: () => ({
      get: (k) => splitStore.get(k),
      setJSON: (k, v, o) => splitStore.setJSON(k, v, o),
      delete: (k) => splitStore.delete(k),
      list: (o) => splitStore.list(o),
      claimWindow: (...a) => claims.claimWindow(...a),
      settleClaim: (...a) => claims.settleClaim(...a),
      releaseClaim: (...a) => claims.releaseClaim(...a),
    }),
  };
});
vi.mock('../../functions/lib/_telegram.mjs', () => ({
  sendMessage: telegramSend,
  kbCategoryConfirm: (id, cats, suggestion) => [[{ text: suggestion, callback_data: `CATFIX:${id}:${suggestion}` }]],
  resolveTelegramChatId: (email) => {
    for (const pair of (process.env.TELEGRAM_EMAIL_MAP || '').split(',')) {
      const [e, id] = pair.split(':').map(s => s.trim());
      if (e && id && email && e.toLowerCase() === email.toLowerCase()) return id;
    }
    return null;
  },
}));
vi.mock('../../functions/lib/firestore.mjs', () => ({
  getDb: () => ({
    collection: (name) => ({
      doc: () => ({
        get: async () => {
          if (name === 'config') {
            if (ctl.householdThrows) throw new Error('firestore down');
            return { exists: ctl.household !== null, data: () => ctl.household };
          }
          return { exists: ctl.pushDoc !== null, data: () => ctl.pushDoc };
        },
        delete: async () => { ctl.deleted = true; },
      }),
    }),
  }),
}));

const { walletWebhook } = await import('../../functions/wallet-webhook.mjs');
const { resetHouseholdCache } = await import('../../functions/lib/_household.mjs');

const SECRET = 'test-wallet-secret';

// Express-style request + a wrapper returning { status, json } after the handler runs.
function req({ method = 'POST', key = SECRET, keyHeader = 'authorization', body = {} } = {}) {
  const headers = {};
  if (key) headers[keyHeader] = keyHeader === 'authorization' ? `Bearer ${key}` : key;
  return { method, get: (h) => headers[h.toLowerCase()], body };
}
async function call(request) {
  let status = 200, jsonBody, sent;
  const res = {
    status(c) { status = c; return this; },
    json(o) { jsonBody = o; return this; },
    send(s) { sent = s; return this; },
  };
  await walletWebhook(request, res);
  return { status, json: jsonBody, sent };
}

const validBody = {
  merchant: 'Costco Wholesale',
  amount: '89.50',
  email: 'nair.sabarish97@gmail.com',
  sheetId: 'sheet-abc',
  card: 'Chase Sapphire Reserve',
  date: '2026-05-15',
};

beforeEach(() => {
  extractMock.mockReset().mockResolvedValue({ ok: true, data: { reward_category: 'Grocery', store_name: 'Costco' } });
  appendMock.mockReset().mockResolvedValue(undefined);
  sheetIdMock.mockReset().mockResolvedValue('resolved-month-sheet');
  webpushSend.mockReset().mockResolvedValue(undefined);
  getSettingsMock.mockReset().mockResolvedValue({});
  telegramSend.mockReset().mockResolvedValue({ ok: true });
  recentMock.mockReset().mockResolvedValue([]);
  reportErrorMock.mockReset().mockResolvedValue(undefined);
  activityMock.mockReset().mockResolvedValue(undefined);
  splitStore.data.clear();
  fakeDb.docs.clear();
  fakeDb.state.failTransactions = false;
  ctl.pushDoc = null;
  ctl.deleted = false;
  ctl.household = null;
  ctl.householdThrows = false;
  resetHouseholdCache();
  vi.stubEnv('VAPID_PUBLIC_KEY', '');
  vi.stubEnv('VAPID_PRIVATE_KEY', '');
  vi.stubEnv('VAPID_EMAIL', '');
});

describe('wallet-webhook — method & auth', () => {
  it('rejects non-POST with 405', async () => {
    const res = await call(req({ method: 'GET' }));
    expect(res.status).toBe(405);
    expect(appendMock).not.toHaveBeenCalled();
  });

  it('rejects a request with no key (401)', async () => {
    const res = await call(req({ key: null, body: validBody }));
    expect(res.status).toBe(401);
    // Error responses now carry the code so it is visible wherever the
    // response is seen — phone automation logs included.
    expect(res.json).toEqual({ ok: false, code: 'AUTH-002', error: 'Unauthorized', message: expect.any(String) });
  });

  it('rejects a wrong key (401)', async () => {
    const res = await call(req({ key: 'nope', body: validBody }));
    expect(res.status).toBe(401);
  });

  it('accepts the key via Authorization: Bearer', async () => {
    const res = await call(req({ body: validBody }));
    expect(res.status).toBe(200);
  });

  it('accepts the key via X-API-Key header', async () => {
    const res = await call(req({ keyHeader: 'x-api-key', body: validBody }));
    expect(res.status).toBe(200);
  });
});

describe('wallet-webhook — validation', () => {
  it('400 on missing merchant', async () => {
    const res = await call(req({ body: { ...validBody, merchant: undefined } }));
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/merchant/i);
  });

  it('400 on missing / NaN amount', async () => {
    const res = await call(req({ body: { ...validBody, amount: 'abc' } }));
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/amount/i);
  });

  it('400 on non-positive amount', async () => {
    const res = await call(req({ body: { ...validBody, amount: '0' } }));
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/amount/i);
  });

  it('400 on invalid email', async () => {
    const res = await call(req({ body: { ...validBody, email: 'not-an-email' } }));
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/email/i);
  });

  // These three sites returned a bare 400 and reported nothing, so a charge the
  // automation failed to describe was invisible: no alert, no digest, no row.
  // WAL-001 is severity 'fatal', so reporting it also alerts immediately.
  it.each([
    ['merchant', { merchant: undefined }],
    ['amount',   { amount: 'abc' }],
    ['email',    { email: 'not-an-email' }],
  ])('reports WAL-001 when %s is rejected', async (field, override) => {
    await call(req({ body: { ...validBody, ...override } }));
    expect(reportErrorMock).toHaveBeenCalledTimes(1);
    const [code, error, context] = reportErrorMock.mock.calls[0];
    expect(code).toBe('WAL-001');
    expect(error.message).toMatch(new RegExp(field, 'i'));
    expect(context.field).toBe(field);
  });

  // The Android automation posts raw notification text; a Samsung Wallet promo
  // reaches this path with nothing parseable in it. fromRawText is what tells
  // "the parser could not read a real notification" apart from "the automation
  // is sending the wrong shape", which have different fixes.
  it('flags a rejection that came from the raw-text path', async () => {
    extractMock.mockResolvedValue({ ok: true, data: {} });
    await call(req({ body: { email: validBody.email, text: 'Samsung Wallet is running' } }));
    const [, , context] = reportErrorMock.mock.calls[0];
    expect(context.fromRawText).toBe(true);
    expect(context.textLength).toBe('Samsung Wallet is running'.length);
  });

  it('does not report WAL-001 on a valid charge', async () => {
    await call(req({ body: validBody }));
    expect(reportErrorMock).not.toHaveBeenCalledWith('WAL-001', expect.anything(), expect.anything());
  });

  it('resolves current-month sheet when sheetId is omitted (200)', async () => {
    const res = await call(req({ body: { ...validBody, sheetId: undefined } }));
    expect(res.status).toBe(200);
    expect(sheetIdMock).toHaveBeenCalledWith('May 2026');
    expect(appendMock.mock.calls[0][0].sheetId).toBe('resolved-month-sheet');
  });

  it('422 month_not_found when the month sheet cannot be resolved', async () => {
    sheetIdMock.mockRejectedValueOnce(new Error('no such tab'));
    const res = await call(req({ body: { ...validBody, sheetId: undefined } }));
    expect(res.status).toBe(422);
    expect(res.json.error).toBe('month_not_found');
  });
});

describe('wallet-webhook — categorization & write', () => {
  it('happy path: categorizes, appends with channel=wallet, returns 200', async () => {
    const res = await call(req({ body: validBody }));
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, category: 'Grocery', vendor: 'Costco', amount: 89.5, message: expect.any(String) });
    expect(appendMock).toHaveBeenCalledOnce();
    const args = appendMock.mock.calls[0][0];
    expect(args).toMatchObject({
      category: 'Grocery',
      vendor: 'Costco',
      amount: 89.5,
      txDate: '2026-05-15',
      sheetId: 'sheet-abc',
      monthName: 'May 2026',
      paymentMethod: 'Chase Sapphire Reserve',
      channel: 'wallet',
    });
  });

  it('falls back to Misc + raw merchant when categorization throws', async () => {
    extractMock.mockRejectedValue(new Error('AI down'));
    const res = await call(req({ body: validBody }));
    expect(res.status).toBe(200);
    expect(res.json.category).toBe('Misc');
    expect(res.json.vendor).toBe('Costco Wholesale');
  });

  it('falls back to Misc when categorization returns ok:false', async () => {
    extractMock.mockResolvedValue({ ok: false });
    const res = await call(req({ body: validBody }));
    expect(res.json.category).toBe('Misc');
    expect(res.json.vendor).toBe('Costco Wholesale');
  });

  it('defaults txDate to today when omitted', async () => {
    const res = await call(req({ body: { ...validBody, date: undefined } }));
    expect(res.status).toBe(200);
    const today = localToday();
    expect(appendMock.mock.calls[0][0].txDate).toBe(today);
  });

  it('422 month_not_found when the sheet has no matching month', async () => {
    appendMock.mockRejectedValue(new Error('No sheet found for month May 2026'));
    const res = await call(req({ body: validBody }));
    expect(res.status).toBe(422);
    expect(res.json).toMatchObject({ ok: false, error: 'month_not_found', monthName: 'May 2026' });
  });

  it('500 on any other append failure', async () => {
    appendMock.mockRejectedValue(new Error('Sheets API 503'));
    const res = await call(req({ body: validBody }));
    expect(res.status).toBe(500);
    expect(res.json.error).toMatch(/Failed to write/i);
  });
});

describe('wallet-webhook — push notification (best-effort)', () => {
  beforeEach(() => {
    vi.stubEnv('VAPID_PUBLIC_KEY', 'pub');
    vi.stubEnv('VAPID_PRIVATE_KEY', 'priv');
    vi.stubEnv('VAPID_EMAIL', 'mailto:test@example.com');
  });

  it('sends a push when a subscription exists', async () => {
    ctl.pushDoc = { subscription: { endpoint: 'https://push.example/abc' } };
    const res = await call(req({ body: validBody }));
    expect(res.status).toBe(200);
    expect(webpushSend).toHaveBeenCalledOnce();
  });

  it('skips push (still 200) when no subscription exists', async () => {
    ctl.pushDoc = null;
    const res = await call(req({ body: validBody }));
    expect(res.status).toBe(200);
    expect(webpushSend).not.toHaveBeenCalled();
  });

  it('push failure is non-fatal — still returns 200', async () => {
    ctl.pushDoc = { subscription: { endpoint: 'https://push.example/abc' } };
    webpushSend.mockRejectedValue(new Error('push broke'));
    const res = await call(req({ body: validBody }));
    expect(res.status).toBe(200);
  });

  it('prunes a 410 Gone subscription', async () => {
    ctl.pushDoc = { subscription: { endpoint: 'https://push.example/abc' } };
    webpushSend.mockRejectedValue(Object.assign(new Error('gone'), { statusCode: 410 }));
    const res = await call(req({ body: validBody }));
    expect(res.status).toBe(200);
    expect(ctl.deleted).toBe(true);
  });
});

describe('wallet-webhook — disabled vendors (per-user)', () => {
  it('skips logging when the resolved vendor is on the requester\'s block list', async () => {
    extractMock.mockResolvedValue({ ok: true, data: { reward_category: 'Misc', store_name: 'Shell Gas #123' } });
    getSettingsMock.mockResolvedValue({ disabledWalletVendors: [{ name: 'Shell', patterns: ['shell'] }] });
    const res = await call(req({ body: { ...validBody, merchant: 'SHELL OIL 4521' } }));
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, skipped: true, reason: 'vendor_disabled' });
    expect(appendMock).not.toHaveBeenCalled();
  });

  it('logs normally when the block list does not match', async () => {
    extractMock.mockResolvedValue({ ok: true, data: { reward_category: 'Grocery', store_name: 'Trader Joe\'s' } });
    getSettingsMock.mockResolvedValue({ disabledWalletVendors: [{ name: 'Shell', patterns: ['shell'] }] });
    const res = await call(req({ body: { ...validBody, merchant: 'Trader Joes' } }));
    expect(res.status).toBe(200);
    expect(appendMock).toHaveBeenCalledTimes(1);
  });
});

describe('wallet-webhook — split vendors', () => {
  beforeEach(() => {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test-bot-token');
    vi.stubEnv('TELEGRAM_EMAIL_MAP', 'nair.sabarish97@gmail.com:111222333');
  });

  it('prompts via Telegram and does NOT log when a split vendor is charged', async () => {
    extractMock.mockResolvedValue({ ok: true, data: { reward_category: 'Grocery', store_name: 'Costco Wholesale' } });
    getSettingsMock.mockResolvedValue({ splitReceiptVendors: [{ name: 'Costco', patterns: ['costco'] }] });
    const res = await call(req({ body: validBody }));
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, split: true });
    expect(appendMock).not.toHaveBeenCalled();
    expect(telegramSend).toHaveBeenCalledTimes(1);
    // chatId resolved from TELEGRAM_EMAIL_MAP
    expect(telegramSend.mock.calls[0][0]).toBe('111222333');
    // a split_pending was stashed under that chat id
    const keys = [...splitStore.data.keys()];
    expect(keys.some(k => k.startsWith('split_pending:111222333:'))).toBe(true);
  });

  it('falls back to normal logging when no Telegram mapping exists for the email', async () => {
    vi.stubEnv('TELEGRAM_EMAIL_MAP', 'someone-else@x.com:999');
    extractMock.mockResolvedValue({ ok: true, data: { reward_category: 'Grocery', store_name: 'Costco Wholesale' } });
    getSettingsMock.mockResolvedValue({ splitReceiptVendors: [{ name: 'Costco', patterns: ['costco'] }] });
    const res = await call(req({ body: validBody }));
    expect(res.status).toBe(200);
    expect(appendMock).toHaveBeenCalledTimes(1);
    expect(telegramSend).not.toHaveBeenCalled();
  });
});

/* ── Card-name resolution on the wallet path ── */

describe('wallet-webhook — resolves the card against the user card list', () => {
  const CARDS = ['American Express Blue Cash Preferred', 'Chase Sapphire Reserve'];

  it('canonicalizes the shortened name the Wallet notification sends', async () => {
    // The Android macro forwards the bank notification title verbatim. This
    // path never called the resolver, so "Blue Cash Preferred" was written as
    // its own card, splitting the bucket from the canonical AmEx name.
    getSettingsMock.mockResolvedValue({ cards: CARDS });
    const res = await call(req({ body: { ...validBody, card: 'Blue Cash Preferred' } }));
    expect(res.status).toBe(200);
    expect(appendMock.mock.calls[0][0].paymentMethod)
      .toBe('American Express Blue Cash Preferred');
  });

  it('resolves an abbreviation via the alias map', async () => {
    getSettingsMock.mockResolvedValue({ cards: CARDS });
    await call(req({ body: { ...validBody, card: 'BCP' } }));
    expect(appendMock.mock.calls[0][0].paymentMethod)
      .toBe('American Express Blue Cash Preferred');
  });

  it('keeps the raw card when it matches nothing', async () => {
    // Better to log an unrecognised card than to blank it.
    getSettingsMock.mockResolvedValue({ cards: CARDS });
    await call(req({ body: { ...validBody, card: 'Some Other Card' } }));
    expect(appendMock.mock.calls[0][0].paymentMethod).toBe('Some Other Card');
  });

  it('keeps the raw card when the settings lookup fails', async () => {
    // getUserSettingsByEmail throwing leaves userSettings empty; resolving to
    // '' there would wipe a perfectly good card name.
    getSettingsMock.mockRejectedValue(new Error('firestore down'));
    await call(req({ body: { ...validBody, card: 'Blue Cash Preferred' } }));
    expect(appendMock.mock.calls[0][0].paymentMethod).toBe('Blue Cash Preferred');
  });

  it('leaves an absent card absent', async () => {
    getSettingsMock.mockResolvedValue({ cards: CARDS });
    await call(req({ body: { ...validBody, card: undefined } }));
    expect(appendMock.mock.calls[0][0].paymentMethod).toBe('');
  });
});

/* ── LLM category correction on the wallet path ── */

describe('wallet-webhook — LLM category correction', () => {
  const groqFetch = vi.fn();

  function groqSays(category, confidence) {
    groqFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        choices: [{ message: { content: JSON.stringify({ category, confidence }) } }],
      }),
    });
  }

  beforeEach(() => {
    groqFetch.mockReset();
    global.fetch = groqFetch;
    vi.stubEnv('GROQ_API_KEY', 'test-groq-key');
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test-bot-token');
    vi.stubEnv('TELEGRAM_EMAIL_MAP', 'nair.sabarish97@gmail.com:111222333');
    // Extractor says Misc so the LLM has something to disagree with.
    extractMock.mockResolvedValue({ ok: true, data: { reward_category: 'Misc', store_name: 'Chipotle' } });
  });

  it('writes a confident correction straight through, no Telegram round-trip', async () => {
    groqSays('Eating Out', 0.95);
    const res = await call(req({ body: validBody }));

    expect(res.status).toBe(200);
    expect(appendMock).toHaveBeenCalledOnce();
    expect(appendMock.mock.calls[0][0].category).toBe('Eating Out');
    expect(telegramSend).not.toHaveBeenCalled();
  });

  it('parks the charge and asks when the LLM is unsure', async () => {
    groqSays('Travel', 0.4);
    const res = await call(req({ body: validBody }));

    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, pendingCategory: true });
    // Nothing written yet — the tap decides.
    expect(appendMock).not.toHaveBeenCalled();
    expect(telegramSend).toHaveBeenCalledOnce();

    const pending = [...splitStore.data.entries()].find(([k]) => k.startsWith('category_pending:111222333:'));
    expect(pending).toBeDefined();
    expect(pending[1]).toMatchObject({ vendor: 'Chipotle', amount: 89.5, suggested: 'Travel' });
  });

  it('logs the best guess rather than dropping the charge when Telegram is unreachable', async () => {
    groqSays('Travel', 0.4);
    vi.stubEnv('TELEGRAM_EMAIL_MAP', 'someone-else@x.com:999'); // no mapping for this user
    const res = await call(req({ body: validBody }));

    expect(res.status).toBe(200);
    expect(appendMock).toHaveBeenCalledOnce();
    expect(appendMock.mock.calls[0][0].category).toBe('Travel');
  });

  it('logs the best guess when sending the Telegram prompt throws', async () => {
    groqSays('Travel', 0.4);
    telegramSend.mockRejectedValue(new Error('telegram down'));
    const res = await call(req({ body: validBody }));

    // A dead notification channel must not cost the user a transaction.
    expect(appendMock).toHaveBeenCalledOnce();
    expect(appendMock.mock.calls[0][0].category).toBe('Travel');
  });

  it('asks when extraction fails and Groq only agrees with the Misc default at low confidence', async () => {
    extractMock.mockResolvedValue({ ok: false });
    groqSays('Misc', 0.3);
    const res = await call(req({ body: validBody }));

    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, pendingCategory: true });
    expect(appendMock).not.toHaveBeenCalled();
    expect(telegramSend).toHaveBeenCalledOnce();
  });

  it('asks when extraction succeeds but omits reward_category', async () => {
    extractMock.mockResolvedValue({ ok: true, data: { store_name: 'Chipotle' } });
    groqSays('Misc', 0.3);
    const res = await call(req({ body: validBody }));

    expect(res.json).toMatchObject({ ok: true, pendingCategory: true });
    expect(appendMock).not.toHaveBeenCalled();
  });

  it('writes without asking when extraction fails but Groq is at the top anchor', async () => {
    extractMock.mockResolvedValue({ ok: false });
    groqSays('Eating Out', 1);
    await call(req({ body: { ...validBody, merchant: 'Chipotle' } }));

    expect(appendMock).toHaveBeenCalledOnce();
    expect(appendMock.mock.calls[0][0].category).toBe('Eating Out');
    expect(telegramSend).not.toHaveBeenCalled();
  });

  it('asks when Groq is at 0.8 and writes at 0.9', async () => {
    extractMock.mockResolvedValue({ ok: true, data: { reward_category: 'Travel', store_name: 'Avis' } });
    groqSays('Travel', 0.8);
    const asked = await call(req({ body: { ...validBody, merchant: 'Avis' } }));
    expect(asked.json).toMatchObject({ ok: true, pendingCategory: true });
    expect(appendMock).not.toHaveBeenCalled();

    groqSays('Travel', 0.9);
    await call(req({ body: { ...validBody, merchant: 'Avis', amount: '91.20' } }));
    expect(appendMock).toHaveBeenCalledOnce();
  });

  it('always asks about a split-receipt vendor, even when Groq is sure', async () => {
    extractMock.mockResolvedValue({ ok: true, data: { reward_category: 'Grocery', store_name: 'Costco Wholesale' } });
    groqSays('Grocery', 1);
    const res = await call(req({ body: validBody }));

    expect(res.json).toMatchObject({ ok: true, pendingCategory: true });
    expect(appendMock).not.toHaveBeenCalled();
  });

  it('asks about a really extracted Misc that Groq also says, the weakest agreement', async () => {
    // beforeEach extractor says reward_category: 'Misc'.
    groqSays('Misc', 1);
    const res = await call(req({ body: validBody }));

    expect(res.json).toMatchObject({ ok: true, pendingCategory: true });
    expect(appendMock).not.toHaveBeenCalled();
    expect(telegramSend).toHaveBeenCalledOnce();
  });

  describe('vendor history', () => {
    const prevRow = { vendor: 'Chipotle', category: 'Eating Out', amount: 12 };

    beforeEach(() => {
      sheetIdMock.mockImplementation(async (m) => (m === 'April 2026' ? 'prev-sheet' : 'resolved-month-sheet'));
      groqSays('Misc', 0.3);   // would ask, if history did not settle it first
    });

    it('files a repeat vendor under last month\'s category without asking or calling the LLM', async () => {
      recentMock.mockImplementation(async (id) => (id === 'prev-sheet' ? [prevRow] : []));
      const res = await call(req({ body: validBody }));

      expect(res.json).toMatchObject({ ok: true });
      expect(appendMock.mock.calls[0][0].category).toBe('Eating Out');
      expect(groqFetch).not.toHaveBeenCalled();
      expect(telegramSend).not.toHaveBeenCalled();
    });

    it('uses this month\'s rows too, and reads them only once', async () => {
      recentMock.mockImplementation(async (id) => (id === 'sheet-abc' ? [prevRow] : []));
      await call(req({ body: validBody }));

      expect(appendMock.mock.calls[0][0].category).toBe('Eating Out');
      expect(recentMock.mock.calls.filter(c => c[0] === 'sheet-abc')).toHaveLength(1);
    });

    it('asks when the vendor was filed under different categories', async () => {
      recentMock.mockImplementation(async (id) => (id === 'sheet-abc'
        ? [prevRow, { vendor: 'Chipotle', category: 'Grocery' }] : []));
      groqSays('Eating Out', 1);
      const res = await call(req({ body: validBody }));

      expect(res.json).toMatchObject({ ok: true, pendingCategory: true });
      expect(appendMock).not.toHaveBeenCalled();
    });

    it('fails open when last month has no sheet', async () => {
      sheetIdMock.mockImplementation(async (m) => {
        if (m === 'April 2026') throw new Error('No sheet found for month');
        return 'resolved-month-sheet';
      });
      groqSays('Eating Out', 1);
      await call(req({ body: validBody }));

      expect(appendMock.mock.calls[0][0].category).toBe('Eating Out');
    });

    it('fails open when the sheet read throws, and still checks for duplicates by retrying', async () => {
      recentMock.mockRejectedValue(new Error('sheets down'));
      groqSays('Eating Out', 1);
      const res = await call(req({ body: validBody }));

      expect(res.json).toMatchObject({ ok: true });
      expect(appendMock).toHaveBeenCalledOnce();
    });
  });

  it('a smart rule wins outright and never calls the LLM', async () => {
    getSettingsMock.mockResolvedValue({ smartRules: [{ pattern: 'chipotle', category: 'Eating Out' }] });
    const res = await call(req({ body: validBody }));

    expect(appendMock.mock.calls[0][0].category).toBe('Eating Out');
    expect(groqFetch).not.toHaveBeenCalled();
    expect(telegramSend).not.toHaveBeenCalled();
  });

  it('respects the llmCategorize=false setting', async () => {
    getSettingsMock.mockResolvedValue({ llmCategorize: false });
    const res = await call(req({ body: validBody }));

    expect(appendMock.mock.calls[0][0].category).toBe('Misc'); // extractor's answer, untouched
    expect(groqFetch).not.toHaveBeenCalled();
  });

  it('keeps the extractor category when Groq is unavailable', async () => {
    groqFetch.mockRejectedValue(new Error('groq down'));
    const res = await call(req({ body: validBody }));

    expect(res.status).toBe(200);
    expect(appendMock.mock.calls[0][0].category).toBe('Misc');
  });
});

/* ── Duplicate detection on the wallet path (previously never executed) ── */

describe('wallet-webhook — duplicate detection', () => {
  const already = (vendor, amount, date, category = 'Misc') =>
    ({ vendor, amount, category, txDate: date, timestamp: `${date}T08:00:00Z`, uuid: 'tx_old' });

  beforeEach(() => {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test-bot-token');
    vi.stubEnv('TELEGRAM_EMAIL_MAP', 'nair.sabarish97@gmail.com:111222333');
    extractMock.mockResolvedValue({ ok: true, data: { reward_category: 'Grocery', store_name: 'Costco' } });
  });

  it('warns but still logs when the charge is already there', async () => {
    recentMock.mockResolvedValue([already('Costco', 89.5, '2026-05-15')]);
    const res = await call(req({ body: validBody }));

    expect(res.status).toBe(200);
    // Notify, don't gate — nobody is in the loop on a bank push, and holding
    // the charge would cost the instant logging this path exists for.
    expect(appendMock).toHaveBeenCalledOnce();
    const notice = telegramSend.mock.calls.at(-1)?.[1] || '';
    expect(notice).toContain('Possible duplicate');
    expect(notice).toContain('Costco');
  });

  it('sends the notice only AFTER the write succeeds', async () => {
    // Warning about a charge that never landed would be worse than not warning.
    recentMock.mockResolvedValue([already('Costco', 89.5, '2026-05-15')]);
    appendMock.mockRejectedValue(new Error('sheet locked'));
    const res = await call(req({ body: validBody }));

    expect(res.status).toBe(500);
    expect(telegramSend).not.toHaveBeenCalled();
  });

  it('stays quiet when nothing matches', async () => {
    recentMock.mockResolvedValue([already('Trader Joes', 12.0, '2026-05-15')]);
    await call(req({ body: validBody }));
    expect(appendMock).toHaveBeenCalledOnce();
    expect(telegramSend).not.toHaveBeenCalled();
  });

  it('does not flag a repeat purchase outside the date window', async () => {
    // Same vendor and amount two weeks earlier is a recurring shop, not a dup.
    recentMock.mockResolvedValue([already('Costco', 89.5, '2026-05-01')]);
    await call(req({ body: validBody }));
    expect(telegramSend).not.toHaveBeenCalled();
  });

  it('matches across categories — the case this exists for', async () => {
    // The wallet filed it under Misc; the receipt would go to Grocery.
    recentMock.mockResolvedValue([already('Costco', 89.5, '2026-05-15', 'Misc')]);
    await call(req({ body: validBody }));
    expect(telegramSend.mock.calls.at(-1)?.[1] || '').toContain('Misc');
  });

  it('still logs the charge when the duplicate check itself fails', async () => {
    // A broken check must never cost a transaction.
    recentMock.mockRejectedValue(new Error('sheets down'));
    const res = await call(req({ body: validBody }));
    expect(res.status).toBe(200);
    expect(appendMock).toHaveBeenCalledOnce();
    expect(telegramSend).not.toHaveBeenCalled();
  });
});

describe('wallet-webhook — non-purchase notifications (raw text)', () => {
  const EMAIL = 'nair.sabarish97@gmail.com';
  const NON_PURCHASES = [
    ['declined', 'Your purchase of $23.10 at REAL-DEBRID was declined.'],
    ['statement', 'Your Capital One statement is ready to view.'],
    ['payment', 'Payment due: $250.00 due on Oct 3.'],
    ['deposit', 'A deposit of $1,200.00 was posted to your checking account.'],
    ['payment', 'Autopay payment of $250.00 was received. Thank you!'],
    ['refund', 'A credit of $12.99 from Target was posted to your card.'],
  ];

  it.each(NON_PURCHASES)('skips a %s notification quietly: %s', async (kind, text) => {
    extractMock.mockResolvedValue({ ok: true, data: {
      store_name: null, total_amount: null, is_purchase: false, non_purchase_kind: kind,
    } });
    const res = await call(req({ body: { text, email: EMAIL } }));

    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, skipped: true, reason: 'not_a_purchase', kind });
    expect(res.json.message).toMatch(/not a purchase/i);
    expect(appendMock).not.toHaveBeenCalled();
    expect(reportErrorMock).not.toHaveBeenCalled();
  });

  it('skips even when the model also invented a merchant and amount', async () => {
    extractMock.mockResolvedValue({ ok: true, data: {
      store_name: 'Capital One', total_amount: 250, is_purchase: false, non_purchase_kind: 'payment',
    } });
    const res = await call(req({ body: { text: 'Payment due', email: EMAIL } }));
    expect(res.json.skipped).toBe(true);
    expect(appendMock).not.toHaveBeenCalled();
  });

  it('asks the parser to detect non-purchases', async () => {
    await call(req({ body: { text: 'Little Oddfellows $17.58', email: EMAIL } }));
    expect(extractMock).toHaveBeenCalledWith('Little Oddfellows $17.58', { detectNonPurchase: true });
  });

  it.each([
    ['Amex Wallet', 'Little Oddfellows, Portland, OR $17.58', 'Little Oddfellows', 17.58],
    ['Capital One', 'Your purchase for $23.10 at REAL-DEBRID*17886754 was approved.', 'REAL-DEBRID*17886754', 23.10],
  ])('still logs a real %s purchase (is_purchase true)', async (_n, text, store, amt) => {
    extractMock.mockResolvedValue({ ok: true, data: {
      store_name: store, total_amount: amt, reward_category: 'Misc', is_purchase: true, non_purchase_kind: null,
    } });
    const res = await call(req({ body: { text, email: EMAIL, sheetId: 'sheet-abc' } }));
    expect(res.status).toBe(200);
    expect(res.json.skipped).toBeUndefined();
    expect(appendMock).toHaveBeenCalledTimes(1);
  });

  it('still logs when the flag is missing (fail open)', async () => {
    extractMock.mockResolvedValue({ ok: true, data: { store_name: 'Costco', total_amount: 89.5, reward_category: 'Grocery' } });
    const res = await call(req({ body: { text: 'Costco $89.50', email: EMAIL, sheetId: 'sheet-abc' } }));
    expect(res.status).toBe(200);
    expect(appendMock).toHaveBeenCalledTimes(1);
  });

  it('structured posts never consult the purchase flag', async () => {
    extractMock.mockResolvedValue({ ok: true, data: { reward_category: 'Grocery', store_name: 'Costco', is_purchase: false, non_purchase_kind: 'other' } });
    const res = await call(req({ body: validBody }));
    expect(res.status).toBe(200);
    expect(res.json.skipped).toBeUndefined();
    expect(appendMock).toHaveBeenCalledTimes(1);
  });

  it('a purchase with an unreadable amount still raises WAL-001', async () => {
    extractMock.mockResolvedValue({ ok: true, data: {
      store_name: 'Costco', total_amount: null, is_purchase: true, non_purchase_kind: null,
    } });
    const res = await call(req({ body: { text: 'Costco purchase approved', email: EMAIL } }));
    expect(res.status).toBe(400);
    expect(res.json.code).toBe('WAL-001');
    expect(reportErrorMock).toHaveBeenCalledWith('WAL-001', expect.any(Error), expect.objectContaining({ field: 'amount' }));
  });
});

/* ── Step 4/5: `message`, rounding, park-vs-send order, primary routing ── */

describe('wallet-webhook — message on every JSON branch + rounding', () => {
  const WIFE = 'anupamaramesh2697@gmail.com';
  const PRIMARY = 'nair.sabarish97@gmail.com';
  const body = { ...validBody, merchant: 'Little Oddfellows', amount: 17.579999999999998, date: '2026-09-12', card: 'Amex BCP' };
  const groqFetch = vi.fn();
  const groqSays = (category, confidence) => groqFetch.mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify({ category, confidence }) } }] }),
  });

  beforeEach(() => {
    groqFetch.mockReset();
    global.fetch = groqFetch;
    vi.stubEnv('GROQ_API_KEY', 'test-groq-key');
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test-bot-token');
    vi.stubEnv('TELEGRAM_EMAIL_MAP', `${PRIMARY}:111222333,${WIFE}:444555666`);
    vi.stubEnv('HOUSEHOLD_PRIMARY_EMAIL', '');
    extractMock.mockResolvedValue({ ok: true, data: { reward_category: 'Eating Out', store_name: 'Little Oddfellows' } });
  });

  it('rounds the parsed amount once: sheet write, message and response all see 17.58', async () => {
    const res = await call(req({ body }));
    expect(appendMock.mock.calls[0][0].amount).toBe(17.58);
    expect(res.json.amount).toBe(17.58);
    expect(res.json.message).toBe('✅ $17.58 at Little Oddfellows on Amex BCP → Eating Out. Added to your September 2026 budget in Fundient.');
  });

  it('omits the card segment when there is no card', async () => {
    const res = await call(req({ body: { ...body, card: undefined } }));
    expect(res.json.message).toBe('✅ $17.58 at Little Oddfellows → Eating Out. Added to your September 2026 budget in Fundient.');
  });

  it('web push body prints the rounded amount with two decimals', async () => {
    vi.stubEnv('VAPID_PUBLIC_KEY', 'pub'); vi.stubEnv('VAPID_PRIVATE_KEY', 'priv'); vi.stubEnv('VAPID_EMAIL', 'a@b.c');
    ctl.pushDoc = { subscription: { endpoint: 'https://push.example/abc' } };
    await call(req({ body: { ...body, amount: 17.5 } }));
    expect(JSON.parse(webpushSend.mock.calls[0][1]).body).toBe('Logged $17.50 at Little Oddfellows as Eating Out');
  });

  it('keeps every pre-existing response key on the happy path (additive message)', async () => {
    const res = await call(req({ body }));
    expect(Object.keys(res.json).sort()).toEqual(['amount', 'category', 'message', 'ok', 'vendor']);
    expect(res.status).toBe(200);
  });

  it('parked category: message says waiting on Telegram, never added; keys preserved', async () => {
    groqSays('Travel', 0.4);
    const res = await call(req({ body }));
    expect(Object.keys(res.json).sort()).toEqual(['amount', 'message', 'ok', 'pendingCategory', 'vendor']);
    expect(res.json.message).toBe("🤔 $17.58 at Little Oddfellows — I need a category. Pick one on Telegram and I'll add it to September 2026.");
    expect(res.json.message).not.toMatch(/✅|Added to your/);
  });

  it('Telegram category prompt uses the new copy with the rounded amount', async () => {
    groqSays('Travel', 0.4);
    await call(req({ body }));
    expect(telegramSend.mock.calls[0][1]).toBe(
      '🤔 Categorize this charge\nLittle Oddfellows · $17.58 · Amex BCP · Sep 2026\nBest guess: Travel. Tap the right one:');
  });

  it('Telegram category prompt omits the card segment when none', async () => {
    groqSays('Travel', 0.4);
    await call(req({ body: { ...body, card: undefined } }));
    expect(telegramSend.mock.calls[0][1]).toBe(
      '🤔 Categorize this charge\nLittle Oddfellows · $17.58 · Sep 2026\nBest guess: Travel. Tap the right one:');
  });

  it('send OK => blob parked with originating email and source', async () => {
    groqSays('Travel', 0.4);
    await call(req({ body: { ...body, source: 'android-sms' } }));
    const [, blob] = [...splitStore.data.entries()].find(([k]) => k.startsWith('category_pending:111222333:'));
    expect(blob).toMatchObject({ email: PRIMARY, source: 'android-sms', amount: 17.58 });
  });

  it('sends BEFORE parking: a failed send leaves no blob, and the write message describes the written outcome', async () => {
    groqSays('Travel', 0.4);
    telegramSend.mockRejectedValue(new Error('telegram down'));
    const res = await call(req({ body }));
    expect([...splitStore.data.keys()].filter(k => k.startsWith('category_pending:'))).toEqual([]);
    expect(appendMock).toHaveBeenCalledOnce();
    expect(res.json.pendingCategory).toBeUndefined();
    expect(res.json.message).toMatch(/^✅ \$17\.58 at Little Oddfellows on Amex BCP → Travel\. Added to your September 2026/);
  });

  it('send OK but park fails: reports, tells the user, writes once with best guess, written message', async () => {
    groqSays('Travel', 0.4);
    const orig = splitStore.setJSON;
    splitStore.setJSON = () => Promise.reject(new Error('firestore down'));
    try {
      const res = await call(req({ body }));
      expect(reportErrorMock).toHaveBeenCalledWith('TG-001', expect.any(Error), expect.objectContaining({ flow: 'category-park' }));
      expect(appendMock).toHaveBeenCalledTimes(1);
      expect(appendMock.mock.calls[0][0].category).toBe('Travel');
      expect([...splitStore.data.keys()].filter(k => k.startsWith('category_pending:'))).toEqual([]);
      expect(telegramSend.mock.calls.at(-1)[1]).toBe("⚠️ Couldn't save that prompt — I'm logging it as Travel instead.");
      expect(res.json.pendingCategory).toBeUndefined();
      expect(res.json.message).toMatch(/^✅ .*→ Travel\./);
    } finally { splitStore.setJSON = orig; }
  });

  it('split vendor parked: message says upload receipt on Telegram; keys preserved; blob has email', async () => {
    getSettingsMock.mockResolvedValue({ splitReceiptVendors: [{ name: 'Trader', patterns: ['oddfellows'] }] });
    const res = await call(req({ body }));
    expect(Object.keys(res.json).sort()).toEqual(['amount', 'message', 'ok', 'split', 'vendor']);
    expect(res.json.message).toBe('🧾 $17.58 at Little Oddfellows — upload the receipt on Telegram to split it, or SKIP to log as one.');
    const [, blob] = [...splitStore.data.entries()].find(([k]) => k.startsWith('split_pending:111222333:'));
    expect(blob).toMatchObject({ email: PRIMARY, amount: 17.58 });
  });

  it('split: failed send leaves no blob and falls through to a written message', async () => {
    getSettingsMock.mockResolvedValue({ splitReceiptVendors: [{ name: 'Trader', patterns: ['oddfellows'] }] });
    telegramSend.mockRejectedValue(new Error('down'));
    const res = await call(req({ body }));
    expect([...splitStore.data.keys()].filter(k => k.startsWith('split_pending:'))).toEqual([]);
    expect(appendMock).toHaveBeenCalledOnce();
    expect(res.json.message).toMatch(/^✅ /);
  });

  it('split: send OK but park fails => follow-up, one write as a single expense', async () => {
    getSettingsMock.mockResolvedValue({ splitReceiptVendors: [{ name: 'Trader', patterns: ['oddfellows'] }] });
    const orig = splitStore.setJSON;
    splitStore.setJSON = () => Promise.reject(new Error('firestore down'));
    try {
      const res = await call(req({ body }));
      expect(reportErrorMock).toHaveBeenCalledWith('TG-001', expect.any(Error), expect.objectContaining({ flow: 'split-park' }));
      expect(appendMock).toHaveBeenCalledTimes(1);
      expect(telegramSend.mock.calls.at(-1)[1]).toMatch(/logging it as a single Eating Out expense/);
      expect(res.json.message).toMatch(/^✅ /);
    } finally { splitStore.setJSON = orig; }
  });

  it('duplicate: still logged, message flags it', async () => {
    recentMock.mockResolvedValue([{ vendor: 'Little Oddfellows', amount: 17.58, category: 'Eating Out', txDate: '2026-09-12' }]);
    const res = await call(req({ body }));
    expect(res.json.message).toBe('✅ $17.58 at Little Oddfellows → Eating Out, added to September 2026. ⚠️ Possible duplicate — check Telegram.');
  });

  it('vendor disabled skip has a message and keeps its keys', async () => {
    getSettingsMock.mockResolvedValue({ disabledWalletVendors: [{ patterns: ['oddfellows'] }] });
    const res = await call(req({ body }));
    expect(res.json).toEqual({ ok: true, skipped: true, reason: 'vendor_disabled', vendor: 'Little Oddfellows',
      message: 'ℹ️ Little Oddfellows is on your ignore list — nothing was logged.' });
  });

  it.each([
    ['amount', { amount: 'abc' }, "⚠️ Couldn't read the amount from that notification — nothing was logged."],
    ['merchant', { merchant: undefined }, "⚠️ Couldn't read the store name from that notification — nothing was logged."],
    ['email', { email: 'nope' }, '⚠️ No account email came with that charge — nothing was logged.'],
  ])('400 on bad %s has message and keeps ok/code/error', async (field, override, message) => {
    const res = await call(req({ body: { ...body, ...override } }));
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ ok: false, code: 'WAL-001', error: `Missing or invalid ${field}`, message });
  });

  it('401 keeps its shape and adds a message', async () => {
    const res = await call(req({ key: 'nope', body }));
    expect(res.status).toBe(401);
    expect(res.json).toMatchObject({ ok: false, code: 'AUTH-002', error: 'Unauthorized' });
    expect(res.json.message).toMatch(/nothing was logged/);
  });

  it('422 (sheet resolution) names the transaction month', async () => {
    sheetIdMock.mockRejectedValueOnce(new Error('none'));
    const res = await call(req({ body: { ...body, sheetId: undefined } }));
    expect(res.status).toBe(422);
    expect(res.json).toEqual({ ok: false, code: 'SHT-002', error: 'month_not_found', monthName: 'September 2026',
      message: '⚠️ No sheet for September 2026 yet — create the month in Fundient first.' });
  });

  it('422 from the append itself carries the same message', async () => {
    appendMock.mockRejectedValue(new Error('No sheet found for month September 2026'));
    const res = await call(req({ body }));
    expect(res.status).toBe(422);
    expect(res.json.message).toBe('⚠️ No sheet for September 2026 yet — create the month in Fundient first.');
  });

  it('500 write failure: message says NOT logged with the rounded amount', async () => {
    appendMock.mockRejectedValue(new Error('boom'));
    const res = await call(req({ body }));
    expect(res.status).toBe(500);
    expect(res.json).toMatchObject({ ok: false, code: 'WAL-002', error: 'Failed to write transaction' });
    expect(res.json.message).toBe('❌ Save FAILED — this charge was NOT logged. Re-enter $17.58 at Little Oddfellows by hand.');
  });

  describe('household primary routing', () => {
    it("the wife's charge prompts in the primary's chat when HOUSEHOLD_PRIMARY_EMAIL is set", async () => {
      vi.stubEnv('HOUSEHOLD_PRIMARY_EMAIL', PRIMARY);
      groqSays('Travel', 0.4);
      await call(req({ body: { ...body, email: WIFE } }));
      expect(telegramSend.mock.calls[0][0]).toBe('111222333');
      const [, blob] = [...splitStore.data.entries()].find(([k]) => k.startsWith('category_pending:'));
      expect(blob.email).toBe(WIFE);
      expect([...splitStore.data.keys()].some(k => k.startsWith('category_pending:111222333:'))).toBe(true);
    });

    it('duplicate note goes to the primary chat too', async () => {
      vi.stubEnv('HOUSEHOLD_PRIMARY_EMAIL', PRIMARY);
      recentMock.mockResolvedValue([{ vendor: 'Little Oddfellows', amount: 17.58, category: 'Eating Out', txDate: '2026-09-12' }]);
      await call(req({ body: { ...body, email: WIFE } }));
      expect(telegramSend.mock.calls.at(-1)[0]).toBe('111222333');
    });

    it('env wins over Firestore', async () => {
      vi.stubEnv('HOUSEHOLD_PRIMARY_EMAIL', PRIMARY);
      ctl.household = { primaryEmail: WIFE };
      groqSays('Travel', 0.4);
      await call(req({ body: { ...body, email: WIFE } }));
      expect(telegramSend.mock.calls[0][0]).toBe('111222333');
    });

    it('uses Firestore config/household when env is unset', async () => {
      ctl.household = { primaryEmail: PRIMARY };
      groqSays('Travel', 0.4);
      await call(req({ body: { ...body, email: WIFE } }));
      expect(telegramSend.mock.calls[0][0]).toBe('111222333');
    });

    it('a failed Firestore read falls back to the request email and never blocks', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      ctl.householdThrows = true;
      groqSays('Travel', 0.4);
      const res = await call(req({ body: { ...body, email: WIFE } }));
      expect(res.status).toBe(200);
      expect(telegramSend.mock.calls[0][0]).toBe('444555666');
      warn.mockRestore();
    });

    it('unset => old behavior (chat for the request email) with a warning', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      groqSays('Travel', 0.4);
      await call(req({ body: { ...body, email: WIFE } }));
      expect(telegramSend.mock.calls[0][0]).toBe('444555666');
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/HOUSEHOLD_PRIMARY_EMAIL/));
      warn.mockRestore();
    });
  });
});

/* ── Step 6: idempotency guard (exact cents + email + 2-minute window) ── */

describe('wallet-webhook — duplicate-source guard', () => {
  const PRIMARY = 'nair.sabarish97@gmail.com';
  const WIFE = 'anupamaramesh2697@gmail.com';
  const body = { ...validBody, merchant: 'Safeway', amount: 11.46, date: '2026-09-12', card: 'Amex BCP', source: 'ios-wallet' };
  const groqFetch = vi.fn();
  const groqSays = (category, confidence) => groqFetch.mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify({ category, confidence }) } }] }),
  });
  const nowMs = () => Date.now();
  const advance = (ms) => vi.setSystemTime(nowMs() + ms);
  const dupKeys = () => [...splitStore.data.keys()].filter(k => k.startsWith('dup_skipped:'));

  beforeAll(() => { vi.useFakeTimers({ toFake: ['Date'] }); });
  afterAll(() => { vi.useRealTimers(); });

  beforeEach(() => {
    vi.setSystemTime(new Date('2026-09-28T12:00:00Z'));
    groqFetch.mockReset();
    global.fetch = groqFetch;
    vi.stubEnv('GROQ_API_KEY', 'test-groq-key');
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test-bot-token');
    vi.stubEnv('TELEGRAM_EMAIL_MAP', `${PRIMARY}:111222333,${WIFE}:444555666`);
    vi.stubEnv('HOUSEHOLD_PRIMARY_EMAIL', PRIMARY);
    extractMock.mockResolvedValue({ ok: true, data: { reward_category: 'Grocery', store_name: 'Safeway' } });
  });

  it('second source for the same amount+email inside 2 minutes is skipped; first is written once', async () => {
    const first = await call(req({ body }));
    advance(20_000);
    extractMock.mockResolvedValue({ ok: true, data: { reward_category: 'Grocery', store_name: 'SAFEWAY #1234' } });
    const second = await call(req({ body: { ...body, merchant: 'SAFEWAY #1234', source: 'sms' } }));

    expect(first.json.category).toBe('Grocery');
    expect(appendMock).toHaveBeenCalledTimes(1);
    expect(second.status).toBe(200);
    expect(second.json).toEqual({
      ok: true, skipped: true, reason: 'duplicate_recent',
      vendor: 'SAFEWAY #1234', amount: 11.46,
      message: '⏭ $11.46 at SAFEWAY #1234 looks like a duplicate of a charge just logged — skipped. Tap "Log it anyway" on Telegram if it was separate.',
    });
  });

  it('the skipped charge sends the primary chat a note with a Log-it-anyway button and parks a full blob', async () => {
    await call(req({ body }));
    advance(20_000);
    await call(req({ body: { ...body, email: PRIMARY, source: 'sms' } }));

    const [chatId, text, keyboard] = telegramSend.mock.calls.at(-1);
    expect(chatId).toBe('111222333');
    expect(text).toBe(
      '⏭ Skipped a likely duplicate\nSafeway · $11.46 · Amex BCP · Sep 2026\n' +
      'Looks like Safeway from 20s ago. Same amount arrived from the same phone within 2 minutes. If it was a separate purchase, tap:'
    );
    const btn = keyboard[0][0];
    expect(btn.text).toBe('➕ Log it anyway');
    expect(btn.callback_data).toMatch(/^DUPLOG:[0-9a-f-]{8}$/);
    expect(Buffer.byteLength(btn.callback_data)).toBeLessThan(64);

    const id = btn.callback_data.split(':')[1];
    const blob = splitStore.data.get(`dup_skipped:111222333:${id}`);
    expect(blob).toMatchObject({
      id, vendor: 'Safeway', amount: 11.46, category: 'Grocery', txDate: '2026-09-12',
      monthName: 'September 2026', sheetId: 'sheet-abc', paymentMethod: 'Amex BCP',
      email: PRIMARY, source: 'sms',
    });
    expect(new Date(blob.expiresAt).getTime() - nowMs()).toBe(24 * 3600_000);
    expect(typeof blob.createdAt).toBe('string');
  });

  it("note goes to the household primary's chat, not the request email's", async () => {
    await call(req({ body }));
    await call(req({ body: { ...body, email: PRIMARY } }));
    telegramSend.mockClear();
    // wife's Samsung notification for the SAME email key? key includes email, so use the wife's own pair
    await call(req({ body: { ...body, email: WIFE } }));
    advance(5_000);
    await call(req({ body: { ...body, email: WIFE } }));
    expect(telegramSend.mock.calls.at(-1)[0]).toBe('111222333');
    expect(dupKeys().every(k => k.startsWith('dup_skipped:111222333:'))).toBe(true);
  });

  it('different amount, different email, or more than 2 minutes later => both are logged', async () => {
    await call(req({ body }));
    await call(req({ body: { ...body, amount: 11.47 } }));
    await call(req({ body: { ...body, email: WIFE } }));
    advance(121_000);
    await call(req({ body }));
    expect(appendMock).toHaveBeenCalledTimes(4);
    expect(dupKeys()).toHaveLength(0);
  });

  it('float noise is rounded before keying: 11.459999999 and 11.46 are the same charge', async () => {
    await call(req({ body: { ...body, amount: 11.459999999999999 } }));
    const second = await call(req({ body }));
    expect(second.json.reason).toBe('duplicate_recent');
    expect(appendMock).toHaveBeenCalledTimes(1);
  });

  it('a parked first charge + a second source => ONE category prompt, no second write', async () => {
    groqSays('Travel', 0.4); // unconfident => parked
    const first = await call(req({ body }));
    advance(10_000);
    const second = await call(req({ body: { ...body, source: 'sms' } }));

    expect(first.json.pendingCategory).toBe(true);
    expect(second.json.reason).toBe('duplicate_recent');
    const prompts = telegramSend.mock.calls.filter(c => String(c[1]).startsWith('🤔 Categorize'));
    expect(prompts).toHaveLength(1);
    expect(appendMock).not.toHaveBeenCalled();
    expect(dupKeys()).toHaveLength(1);
    // the skipped blob carries the suggestion for the DUPLOG handler
    expect(splitStore.data.get(dupKeys()[0]).category).toBe('Travel');
  });

  it('concurrent duplicate requests => exactly one write', async () => {
    const results = await Promise.all([call(req({ body })), call(req({ body: { ...body, source: 'sms' } })), call(req({ body }))]);
    expect(appendMock).toHaveBeenCalledTimes(1);
    expect(results.filter(r => r.json.reason === 'duplicate_recent')).toHaveLength(2);
    expect(results.filter(r => r.json.category === 'Grocery')).toHaveLength(1);
  });

  it('a failed write RELEASES the claim so a retry / second source can still log', async () => {
    appendMock.mockRejectedValueOnce(new Error('sheets down'));
    const first = await call(req({ body }));
    expect(first.status).toBe(500);
    const retry = await call(req({ body }));
    expect(retry.status).toBe(200);
    expect(retry.json.category).toBe('Grocery');
    expect(appendMock).toHaveBeenCalledTimes(2);
    expect(dupKeys()).toHaveLength(0);
  });

  it('a month-not-found 422 from the append also releases the claim', async () => {
    appendMock.mockRejectedValueOnce(new Error('No sheet found for month September 2026'));
    expect((await call(req({ body }))).status).toBe(422);
    expect((await call(req({ body }))).status).toBe(200);
  });

  it('an in-flight claim (<30s, never settled) blocks; an abandoned one (>30s) is taken over', async () => {
    const { createHash } = await import('node:crypto');
    const key = `wdup:${createHash('sha256').update(PRIMARY).digest('hex').slice(0, 16)}:1146`;
    fakeDb.docs.set(key, { v: { ts: nowMs() - 5_000, status: 'claimed', vendor: 'Safeway', token: 't1' } });
    expect((await call(req({ body }))).json.reason).toBe('duplicate_recent');
    expect(appendMock).not.toHaveBeenCalled();

    fakeDb.docs.set(key, { v: { ts: nowMs() - 31_000, status: 'claimed', vendor: 'Safeway', token: 't1' } });
    const res = await call(req({ body }));
    expect(res.json.category).toBe('Grocery');
    expect(appendMock).toHaveBeenCalledTimes(1);
  });

  it('guard infrastructure failure fails OPEN: charge logged, error reported, not dropped', async () => {
    fakeDb.state.failTransactions = true;
    const res = await call(req({ body }));
    expect(res.status).toBe(200);
    expect(res.json.category).toBe('Grocery');
    expect(appendMock).toHaveBeenCalledTimes(1);
    expect(reportErrorMock).toHaveBeenCalledWith('WAL-005', expect.any(Error), expect.any(Object));
  });

  it('a Telegram/park failure on the skipped path never turns the skip into an error', async () => {
    await call(req({ body }));
    telegramSend.mockRejectedValue(new Error('telegram down'));
    const second = await call(req({ body }));
    expect(second.status).toBe(200);
    expect(second.json.reason).toBe('duplicate_recent');
    expect(second.json.message).toMatch(/^⏭ \$11\.46 at Safeway looks like a duplicate/);
  });

  it('non-duplicate happy path keeps exactly its pre-existing response keys', async () => {
    const res = await call(req({ body }));
    expect(Object.keys(res.json).sort()).toEqual(['amount', 'category', 'message', 'ok', 'vendor']);
  });

  it('the existing ±3-day findDuplicates notice still fires and still logs', async () => {
    recentMock.mockResolvedValue([{ vendor: 'Safeway', amount: 11.46, category: 'Grocery', txDate: '2026-09-11' }]);
    const res = await call(req({ body }));
    expect(appendMock).toHaveBeenCalledTimes(1);
    expect(res.json.message).toMatch(/Possible duplicate/);
  });
});

describe('wallet-webhook — heartbeat (last activity per email)', () => {
  const EMAIL = 'nair.sabarish97@gmail.com';

  it('records activity with the email and source on a normal charge', async () => {
    await call(req({ body: { ...validBody, source: 'android' } }));
    expect(activityMock).toHaveBeenCalledWith(EMAIL, 'android');
  });

  it('records activity for a non-purchase notification (the phone is alive)', async () => {
    extractMock.mockResolvedValue({ ok: true, data: { store_name: null, total_amount: null, is_purchase: false, non_purchase_kind: 'statement' } });
    const res = await call(req({ body: { text: 'Your statement is ready', email: EMAIL } }));
    expect(res.json.reason).toBe('not_a_purchase');
    expect(activityMock).toHaveBeenCalledWith(EMAIL, null);
  });

  it('records activity even when parsing fails and the request is rejected', async () => {
    extractMock.mockRejectedValue(new Error('parser down'));
    const res = await call(req({ body: { text: 'garbled ~~~', email: EMAIL } }));
    expect(res.status).toBe(400);
    expect(activityMock).toHaveBeenCalledWith(EMAIL, null);
  });

  it('does not record for unauthenticated requests or an invalid email', async () => {
    await call(req({ key: 'nope', body: validBody }));
    await call(req({ body: { ...validBody, email: 'not-an-email' } }));
    expect(activityMock).not.toHaveBeenCalled();
  });

  it('fails open: a throwing recorder never changes the response', async () => {
    activityMock.mockRejectedValue(new Error('firestore down'));
    const res = await call(req({ body: validBody }));
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(appendMock).toHaveBeenCalledTimes(1);
  });
});
