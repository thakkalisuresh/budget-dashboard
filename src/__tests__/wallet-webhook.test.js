import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.stubEnv('WALLET_WEBHOOK_SECRET', 'test-wallet-secret');

// Shared mock state (hoisted so the vi.mock factories can close over it).
const { extractMock, appendMock, sheetIdMock, webpushSend, getSettingsMock, telegramSend, splitStore, ctl, recentMock, reportErrorMock } = vi.hoisted(() => ({
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
  ctl: { pushDoc: null, deleted: false },
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
// The wallet split path builds a bot store + sends Telegram; stub both so the
// import chain doesn't pull in firebase-admin and no real network calls fire.
vi.mock('../../functions/lib/bot-store.mjs', () => ({ createBotStore: () => splitStore }));
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
  recentMock.mockReset().mockResolvedValue([]);
  reportErrorMock.mockReset().mockResolvedValue(undefined);
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
    // Error responses now carry the code so it is visible wherever the
    // response is seen — phone automation logs included.
    expect(res.json).toEqual({ ok: false, code: 'AUTH-002', error: 'Unauthorized' });
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
