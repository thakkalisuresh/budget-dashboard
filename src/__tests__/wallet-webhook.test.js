import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.stubEnv('WALLET_WEBHOOK_SECRET', 'test-wallet-secret');

// Shared mock state (hoisted so the vi.mock factories can close over it).
const { extractMock, appendMock, sheetIdMock, webpushSend, getSettingsMock, telegramSend, splitStore, ctl } = vi.hoisted(() => ({
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
  ctl: { pushDoc: null, deleted: false },
}));

vi.mock('../../functions/lib/_extraction.mjs', () => ({ extractTransactionText: extractMock }));
vi.mock('../../functions/lib/_sheets.mjs', () => ({
  appendExpense: appendMock,
  getCurrentMonthSheetId: sheetIdMock,
  // Default: no per-user settings (no disabled/split vendors). Tests that need
  // these override the mock via getSettingsMock.
  getUserSettingsByEmail: (...args) => getSettingsMock(...args),
}));
vi.mock('web-push', () => ({ default: { setVapidDetails: vi.fn(), sendNotification: webpushSend } }));
// The wallet split path builds a bot store + sends Telegram; stub both so the
// import chain doesn't pull in firebase-admin and no real network calls fire.
vi.mock('../../functions/lib/bot-store.mjs', () => ({ createBotStore: () => splitStore }));
vi.mock('../../functions/lib/_telegram.mjs', () => ({ sendMessage: telegramSend }));
vi.mock('../../functions/lib/firestore.mjs', () => ({
  getDb: () => ({
    collection: () => ({
      doc: () => ({
        get: async () => ({ exists: ctl.pushDoc !== null, data: () => ctl.pushDoc }),
        delete: async () => { ctl.deleted = true; },
      }),
    }),
  }),
}));

const { walletWebhook } = await import('../../functions/wallet-webhook.mjs');

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
  splitStore.data.clear();
  ctl.pushDoc = null;
  ctl.deleted = false;
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
    expect(res.json).toEqual({ ok: false, error: 'Unauthorized' });
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
    expect(res.json).toEqual({ ok: true, category: 'Grocery', vendor: 'Costco', amount: 89.5 });
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
    const today = new Date().toISOString().slice(0, 10);
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
