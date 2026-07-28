import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';

// Pin the clock so "current month" is deterministically May 2026 (matches the
// 'May 2026' sheet fixtures below). Without this, tests that call
// getCurrentMonthSheetId() rot at month boundaries. Date-only fake leaves
// setTimeout/setInterval real.
beforeAll(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-05-15T12:00:00Z')); });
afterAll(() => { vi.useRealTimers(); });

vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test-bot-token');
vi.stubEnv('TELEGRAM_WEBHOOK_SECRET', 'test-webhook-secret');
vi.stubEnv('TELEGRAM_ALLOWED_USERS', '123456789,987654321');
vi.stubEnv('GEMINI_API_KEY', 'test-gemini-key');
vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
vi.stubEnv('GOOGLE_CLIENT_ID', 'test-client-id');
vi.stubEnv('GOOGLE_CLIENT_SECRET', 'test-secret');
vi.stubEnv('GOOGLE_DRIVE_REFRESH_TOKEN', 'test-refresh');
vi.stubEnv('VITE_TEMPLATE_SHEET_ID', 'template-id');
vi.stubEnv('ALLOWED_EMAILS', 'nair.sabarish97@gmail.com');
vi.stubEnv('SITE_URL', 'https://test-dashboard.netlify.app');

const mockStore = {
  data: new Map(),
  get(key, opts) { return Promise.resolve(this.data.get(key) || null); },
  setJSON(key, value) { this.data.set(key, value); return Promise.resolve(); },
  delete(key) { this.data.delete(key); return Promise.resolve(); },
  list({ prefix, limit }) {
    const blobs = [];
    for (const key of this.data.keys()) {
      if (key.startsWith(prefix)) blobs.push({ key });
    }
    blobs.sort((a, b) => a.key.localeCompare(b.key));
    return Promise.resolve({ blobs: limit != null ? blobs.slice(0, limit) : blobs });
  },
  // R1: claim a key once (idempotency). Returns true the first time only.
  claimOnce(key) {
    if (this.data.has(key)) return Promise.resolve(false);
    this.data.set(key, { ts: Date.now() });
    return Promise.resolve(true);
  },
  // R4: atomic increment-if-below (mirrors the Firestore transaction).
  incrementIfBelow(key, limit) {
    const count = (this.data.get(key)?.count) || 0;
    if (count >= limit) return Promise.resolve({ allowed: false, count });
    this.data.set(key, { count: count + 1 });
    return Promise.resolve({ allowed: true, count: count + 1 });
  },
};

// The Cloud Functions handler builds its store via createBotStore(getDb()); swap
// both for the in-memory mockStore (same Blobs-shaped API the bot code expects).
vi.mock('../../functions/lib/firestore.mjs', () => ({ getDb: () => ({}) }));
vi.mock('../../functions/lib/bot-store.mjs', () => ({ createBotStore: () => mockStore }));

const mockFetch = vi.fn();
global.fetch = mockFetch;

const { telegramWebhook } = await import('../../functions/telegram-webhook.mjs');

// Wrap the Express onRequest handler so the existing assertions on `res.status`
// keep working: returns { status, body } after running the handler with a mock res.
async function handler(req) {
  let statusCode = 200, body;
  const res = {
    status(c) { statusCode = c; return this; },
    send(b) { body = b; return this; },
    set() { return this; },
    end() { return this; },
  };
  await telegramWebhook(req, res);
  return { status: statusCode, body };
}

const WEBHOOK_URL = 'https://test.netlify.app/api/telegram';

/* ── Request builders ── */

// Express-style request: req.get(header) + pre-parsed req.body (the Cloud Function
// reads update from req.body, and the secret via req.get('x-telegram-bot-api-secret-token')).
function expressReq({ method = 'POST', headers = {}, body } = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { method, get: (name) => lower[name.toLowerCase()], body };
}

function buildRequest(update, secret = 'test-webhook-secret') {
  return expressReq({
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret },
    body: update,
  });
}

function textMessage(text, userId = 123456789, chatId = 123456789) {
  return {
    message: {
      message_id: 1,
      from: { id: userId, is_bot: false, first_name: 'Test' },
      chat: { id: chatId, type: 'private' },
      date: Math.floor(Date.now() / 1000),
      text,
    },
  };
}

function photoMessage(userId = 123456789, chatId = 123456789) {
  return {
    message: {
      message_id: 2,
      from: { id: userId, is_bot: false, first_name: 'Test' },
      chat: { id: chatId, type: 'private' },
      date: Math.floor(Date.now() / 1000),
      photo: [
        { file_id: 'small_id', file_unique_id: 'a', width: 90, height: 90, file_size: 1000 },
        { file_id: 'medium_id', file_unique_id: 'b', width: 320, height: 320, file_size: 5000 },
        { file_id: 'large_id', file_unique_id: 'c', width: 800, height: 800, file_size: 20000 },
      ],
    },
  };
}

function callbackQuery(data, userId = 123456789, chatId = 123456789) {
  return {
    callback_query: {
      id: 'cb-query-1',
      from: { id: userId, is_bot: false, first_name: 'Test' },
      message: {
        message_id: 10,
        chat: { id: chatId, type: 'private' },
      },
      data,
    },
  };
}

function jpegBytes() {
  const buf = new ArrayBuffer(12);
  const view = new Uint8Array(buf);
  view.set([0xFF, 0xD8, 0xFF, 0xE0, 0, 0, 0, 0, 0, 0, 0, 0]);
  return buf;
}

function geminiResponse(jsonObj) {
  return {
    ok: true,
    json: () => Promise.resolve({
      candidates: [{ content: { parts: [{ text: JSON.stringify(jsonObj) }] } }],
    }),
  };
}

/* ── Mock Telegram API calls (sendMessage, answerCallbackQuery, getFile) ── */

function setupTelegramMocks() {
  mockFetch.mockImplementation((url) => {
    // answerCallbackQuery
    if (url.includes('/answerCallbackQuery')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
    }
    // sendMessage
    if (url.includes('/sendMessage')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, result: { message_id: 99 } }) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
}

function setupPhotoMocks(extractionResult) {
  mockFetch.mockImplementation((url) => {
    // Telegram getFile
    if (url.includes('/getFile')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, result: { file_path: 'photos/file_0.jpg' } }),
      });
    }
    // Telegram file download
    if (url.includes('api.telegram.org/file/')) {
      return Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(jpegBytes()) });
    }
    // Gemini extraction (batch: handler calls extractReceiptBatch → expects { transactions: [...] })
    if (url.includes('generativelanguage.googleapis.com')) {
      if (extractionResult === 'fail') {
        return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: { message: 'fail' } }) });
      }
      const transactions = Array.isArray(extractionResult) ? extractionResult : [extractionResult];
      return Promise.resolve(geminiResponse({ transactions }));
    }
    // Google OAuth
    if (url.includes('oauth2.googleapis.com/token')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ access_token: 'tok', expires_in: 3600 }) });
    }
    // Drive API
    if (url.includes('googleapis.com/drive') || url.includes('googleapis.com/upload')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ id: 'file-123', webViewLink: 'https://drive.google.com/file/d/file-123/view', files: [{ id: 'folder-1' }] }) });
    }
    // Telegram sendMessage
    if (url.includes('/sendMessage')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, result: { message_id: 99 } }) });
    }
    // answerCallbackQuery
    if (url.includes('/answerCallbackQuery')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockStore.data.clear();
});

/* ── Webhook validation ── */

describe('telegram webhook — validation', () => {
  it('rejects non-POST requests', async () => {
    const req = expressReq({ method: 'GET' });
    const res = await handler(req);
    expect(res.status).toBe(405);
  });

  it('rejects missing webhook secret', async () => {
    const req = expressReq({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: textMessage('hello'),
    });
    const res = await handler(req);
    expect(res.status).toBe(403);
  });

  it('rejects wrong webhook secret', async () => {
    const req = buildRequest(textMessage('hello'), 'wrong-secret');
    const res = await handler(req);
    expect(res.status).toBe(403);
  });

  it('accepts correct webhook secret', async () => {
    setupTelegramMocks();
    const req = buildRequest(textMessage('hello'));
    const res = await handler(req);
    expect(res.status).toBe(200);
  });
});

/* ── User authorization ── */

describe('telegram webhook — user authorization', () => {
  it('silently ignores unauthorized users (text)', async () => {
    setupTelegramMocks();
    const req = buildRequest(textMessage('hello', 999999));
    const res = await handler(req);
    expect(res.status).toBe(200);
    // No sendMessage should be called (only 0 fetch calls, or none to sendMessage)
    const sendCalls = mockFetch.mock.calls.filter(c => c[0].includes('/sendMessage'));
    expect(sendCalls.length).toBe(0);
  });

  it('silently ignores unauthorized callback_query', async () => {
    setupTelegramMocks();
    const req = buildRequest(callbackQuery('YES', 999999));
    const res = await handler(req);
    expect(res.status).toBe(200);
    // answerCallbackQuery IS called (to clear spinner), but no sendMessage
    const sendCalls = mockFetch.mock.calls.filter(c => c[0].includes('/sendMessage'));
    expect(sendCalls.length).toBe(0);
  });

  it('processes messages from allowed users', async () => {
    setupTelegramMocks();
    const req = buildRequest(textMessage('GUIDE'));
    const res = await handler(req);
    expect(res.status).toBe(200);
    const sendCalls = mockFetch.mock.calls.filter(c => c[0].includes('/sendMessage'));
    expect(sendCalls.length).toBe(1);
  });
});

/* ── Text message routing ── */

describe('telegram webhook — text messages', () => {
  it('routes GUIDE command and returns guide text', async () => {
    setupTelegramMocks();
    const req = buildRequest(textMessage('GUIDE'));
    const res = await handler(req);
    expect(res.status).toBe(200);

    const sendCall = mockFetch.mock.calls.find(c => c[0].includes('/sendMessage'));
    const body = JSON.parse(sendCall[1].body);
    expect(body.text).toContain('BUDGET BOT GUIDE');
    expect(body.text).toContain('SET SALARY');
    expect(body.text).toContain('DELETE');
    expect(body.chat_id).toBe(123456789);
  });

  it('routes HELP command same as GUIDE', async () => {
    setupTelegramMocks();
    const req = buildRequest(textMessage('help'));
    const res = await handler(req);
    const sendCall = mockFetch.mock.calls.find(c => c[0].includes('/sendMessage'));
    const body = JSON.parse(sendCall[1].body);
    expect(body.text).toContain('BUDGET BOT GUIDE');
  });

  it('sends help fallback for unrecognized text', async () => {
    setupTelegramMocks();
    const req = buildRequest(textMessage('random message here'));
    const res = await handler(req);
    const sendCall = mockFetch.mock.calls.find(c => c[0].includes('/sendMessage'));
    const body = JSON.parse(sendCall[1].body);
    expect(body.text).toContain('Send a receipt photo');
    expect(body.text).toContain('GUIDE');
  });

  it('handles manual entry "Walmart 45.23 Grocery"', async () => {
    setupTelegramMocks();
    const req = buildRequest(textMessage('Walmart 45.23 Grocery'));
    const res = await handler(req);
    const sendCall = mockFetch.mock.calls.find(c => c[0].includes('/sendMessage'));
    const body = JSON.parse(sendCall[1].body);
    expect(body.text).toContain('Walmart');
    expect(body.text).toContain('Grocery');
    expect(body.text).toContain('$45.23');
    expect(body.text).toContain('Reply YES to log');
    // Should have inline keyboard for YES/CANCEL
    expect(body.reply_markup).toBeDefined();
    expect(body.reply_markup.inline_keyboard[0][0].text).toContain('YES');
    expect(body.reply_markup.inline_keyboard[0][1].text).toContain('CANCEL');
  });

  it('CANCEL clears pending state', async () => {
    setupTelegramMocks();
    const userId = '123456789';
    mockStore.data.set(`confirm:${userId}:receipt-1`, {
      id: 'receipt-1', extraction: { store_name: 'Test', total_amount: 10 },
    });

    const req = buildRequest(textMessage('CANCEL'));
    await handler(req);

    expect(mockStore.data.has(`confirm:${userId}:receipt-1`)).toBe(false);
    const sendCall = mockFetch.mock.calls.find(c => c[0].includes('/sendMessage'));
    const body = JSON.parse(sendCall[1].body);
    expect(body.text).toContain('Cancelled');
  });
});

/* ── Callback query (inline keyboard) ── */

describe('telegram webhook — callback queries', () => {
  it('routes callback_query data as text (YES)', async () => {
    setupTelegramMocks();
    const userId = '123456789';

    // Set up a pending receipt to confirm
    mockStore.data.set(`confirm:${userId}:test-id`, {
      id: 'test-id',
      phone: userId,
      extraction: {
        store_name: 'Target',
        total_amount: 25,
        reward_category: 'Misc',
        purchase_date: '2026-05-25',
      },
      year: 2026,
      month: 'May',
      status: 'awaiting_confirmation',
    });

    // Mock sheets API for confirmation
    mockFetch.mockImplementation((url, opts) => {
      if (url.includes('/sendMessage')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
      }
      if (url.includes('/answerCallbackQuery')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
      }
      if (url.includes('oauth2.googleapis.com/token')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ access_token: 'tok', expires_in: 3600 }) });
      }
      if (url.includes('sheets.googleapis.com') && url.includes('Months')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ values: [['May 2026', 'sheet-may']] }) });
      }
      if (url.includes('sheets.googleapis.com')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ updates: { updatedRows: 1 }, values: [] }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    const req = buildRequest(callbackQuery('YES'));
    const res = await handler(req);
    expect(res.status).toBe(200);

    // answerCallbackQuery should be called
    const answerCalls = mockFetch.mock.calls.filter(c => c[0].includes('/answerCallbackQuery'));
    expect(answerCalls.length).toBe(1);

    // sendMessage should contain "Receipt logged!"
    const sendCall = mockFetch.mock.calls.find(c => c[0].includes('/sendMessage'));
    const body = JSON.parse(sendCall[1].body);
    expect(body.text).toContain('Receipt logged');
    expect(body.text).toContain('Target');
  });

  it('routes CANCEL callback and clears state', async () => {
    setupTelegramMocks();
    const userId = '123456789';
    mockStore.data.set(`confirm:${userId}:test-id`, {
      id: 'test-id',
      extraction: { store_name: 'Test', total_amount: 10 },
    });

    const req = buildRequest(callbackQuery('CANCEL'));
    const res = await handler(req);
    expect(res.status).toBe(200);
    expect(mockStore.data.has(`confirm:${userId}:test-id`)).toBe(false);
  });
});

/* ── Photo messages ── */

describe('telegram webhook — photo messages', () => {
  it('extracts receipt from photo and creates confirmation', async () => {
    const extraction = {
      store_name: 'Costco',
      purchase_date: '2026-05-25',
      total_amount: 89.50,
      tax_amount: 6.75,
      currency: 'USD',
      items: [],
      reward_category: 'Grocery',
      is_transfer: false,
    };
    setupPhotoMocks(extraction);

    const req = buildRequest(photoMessage());
    const res = await handler(req);
    expect(res.status).toBe(200);

    // Should pick highest-res photo (large_id)
    const getFileCalls = mockFetch.mock.calls.filter(c => c[0].includes('/getFile'));
    expect(getFileCalls.length).toBe(1);
    expect(getFileCalls[0][0]).toContain('large_id');

    // sendMessage with confirmation
    const sendCall = mockFetch.mock.calls.find(c => c[0].includes('/sendMessage'));
    const body = JSON.parse(sendCall[1].body);
    expect(body.text).toContain('Costco');
    expect(body.text).toContain('$89.5');
    expect(body.text).toContain('Reply YES to log');
    // Should have inline keyboard
    expect(body.reply_markup).toBeDefined();
    expect(body.reply_markup.inline_keyboard[0][0].callback_data).toBe('YES');
  });

  it('handles extraction failure gracefully', async () => {
    setupPhotoMocks('fail');

    const req = buildRequest(photoMessage());
    const res = await handler(req);
    expect(res.status).toBe(200);

    const sendCall = mockFetch.mock.calls.find(c => c[0].includes('/sendMessage'));
    const body = JSON.parse(sendCall[1].body);
    expect(body.text).toContain("Couldn't parse receipt");
    expect(body.text).toContain('Walmart 45.23 Grocery');
  });

  it('blocks after rate limit is reached', async () => {
    setupPhotoMocks({ store_name: 'Test', total_amount: 10 });
    const dateKey = new Date().toISOString().slice(0, 10);
    mockStore.data.set(`rate:123456789:${dateKey}`, { count: 50 });

    const req = buildRequest(photoMessage());
    const res = await handler(req);
    expect(res.status).toBe(200);

    const sendCall = mockFetch.mock.calls.find(c => c[0].includes('/sendMessage'));
    const body = JSON.parse(sendCall[1].body);
    expect(body.text).toContain('reached 50 receipts');
  });
});

/* ── DELETE flow via buttons ── */

describe('telegram webhook — DELETE 3-layer flow', () => {
  it('full delete flow: DELETE → CONFIRM DELETE → amount', async () => {
    const userId = '123456789';

    // Set up lastlog for DELETE last
    mockStore.data.set(`lastlog:${userId}`, {
      uuid: 'uuid-abc',
      category: 'Grocery',
      vendor: 'Walmart',
      amount: 22.50,
      sheetId: 'sheet-may',
      monthName: 'May 2026',
      loggedAt: new Date().toISOString(),
    });

    // Mock sheets + telegram
    mockFetch.mockImplementation((url, opts) => {
      if (url.includes('/sendMessage')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
      }
      if (url.includes('/answerCallbackQuery')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
      }
      if (url.includes('oauth2.googleapis.com/token')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ access_token: 'tok', expires_in: 3600 }) });
      }
      if (url.includes('sheets.googleapis.com') && url.includes('Months')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ values: [['May 2026', 'sheet-may']] }) });
      }
      if (url.includes('sheets.googleapis.com') && (url.includes('F:H') || url.includes('F%3AH'))) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ values: [['uuid-abc']] }) });
      }
      if (url.includes('sheets.googleapis.com')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ updates: { updatedRows: 1 }, values: [] }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    // Step 1: DELETE last
    const req1 = buildRequest(textMessage('DELETE last'));
    await handler(req1);

    let sendCalls = mockFetch.mock.calls.filter(c => c[0].includes('/sendMessage'));
    let body1 = JSON.parse(sendCalls[sendCalls.length - 1][1].body);
    expect(body1.text).toContain('Delete this expense');
    expect(body1.text).toContain('Walmart');
    expect(body1.text).toContain('$22.50');
    expect(body1.text).toContain('CONFIRM DELETE');
    // Should have inline keyboard with CONFIRM DELETE button
    expect(body1.reply_markup).toBeDefined();
    expect(body1.reply_markup.inline_keyboard[0][0].callback_data).toBe('CONFIRM DELETE');

    // Step 2: CONFIRM DELETE via button press
    vi.clearAllMocks();
    mockFetch.mockImplementation((url, opts) => {
      if (url.includes('/sendMessage')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
      }
      if (url.includes('/answerCallbackQuery')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    const req2 = buildRequest(callbackQuery('CONFIRM DELETE'));
    await handler(req2);

    sendCalls = mockFetch.mock.calls.filter(c => c[0].includes('/sendMessage'));
    let body2 = JSON.parse(sendCalls[sendCalls.length - 1][1].body);
    expect(body2.text).toContain('Final verification');
    expect(body2.text).toContain('$22.50');
    // Layer 2 has NO keyboard (deliberate security gate)
    expect(body2.reply_markup).toBeUndefined();

    // Step 3: Type exact amount
    vi.clearAllMocks();
    mockFetch.mockImplementation((url, opts) => {
      if (url.includes('/sendMessage')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
      }
      if (url.includes('oauth2.googleapis.com/token')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ access_token: 'tok', expires_in: 3600 }) });
      }
      if (url.includes('fields=sheets.properties')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({
          sheets: [{ properties: { title: 'Grocery', sheetId: 0 } }],
        }) });
      }
      if (url.includes('sheets.googleapis.com') && (url.includes('F:H') || url.includes('F%3AH'))) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ values: [['UUID'], ['uuid-abc']] }) });
      }
      if (url.includes('sheets.googleapis.com')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ updates: { updatedRows: 1 }, values: [] }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    const req3 = buildRequest(textMessage('22.50'));
    await handler(req3);

    sendCalls = mockFetch.mock.calls.filter(c => c[0].includes('/sendMessage'));
    let body3 = JSON.parse(sendCalls[sendCalls.length - 1][1].body);
    expect(body3.text).toContain('Deleted');
    expect(body3.text).toContain('Walmart');
    expect(body3.text).toContain('$22.50');

    // delete_pending should be cleaned up
    expect(mockStore.data.has(`delete_pending:${userId}`)).toBe(false);
  });

  it('rejects wrong amount in DELETE layer 3', async () => {
    setupTelegramMocks();
    const userId = '123456789';

    mockStore.data.set(`delete_pending:${userId}`, {
      stage: 2,
      target: { category: 'Grocery', vendor: 'Walmart', amount: 22.50, uuid: 'uuid-abc' },
      sheetId: 'sheet-may',
      monthName: 'May 2026',
      expires: new Date(Date.now() + 600000).toISOString(),
    });

    const req = buildRequest(textMessage('25.00'));
    await handler(req);

    const sendCall = mockFetch.mock.calls.find(c => c[0].includes('/sendMessage'));
    const body = JSON.parse(sendCall[1].body);
    expect(body.text).toContain("Amount doesn't match");
    expect(body.text).toContain('$22.50');
    // Pending should still exist
    expect(mockStore.data.has(`delete_pending:${userId}`)).toBe(true);
  });
});

/* ── Empty / unknown update types ── */

describe('telegram webhook — tip edit field', () => {
  it('tip: X adds to total and shows incl. tip in Updated confirmation', async () => {
    setupTelegramMocks();
    // Seed a pending Eating Out receipt
    mockStore.data.set(`confirm:123456789:tip-test`, {
      id: 'tip-test',
      extraction: { store_name: 'Chipotle', reward_category: 'Eating Out', total_amount: 18.50, purchase_date: '2026-06-02' },
      year: 2026, month: 'June',
    });

    const res = await handler(buildRequest(textMessage('tip: 5.00')));
    expect(res.status).toBe(200);

    const sendCall = mockFetch.mock.calls.find(c => c[0].includes('/sendMessage'));
    const body = JSON.parse(sendCall[1].body);
    expect(body.text).toContain('Total: $23.5'); // 18.50 + 5.00
    expect(body.text).toContain('incl. $5.00 tip');
    expect(body.text).toContain('Updated!');
  });

  it('re-applying tip: X replaces the previous tip (not double-adds)', async () => {
    setupTelegramMocks();
    mockStore.data.set(`confirm:123456789:tip-test2`, {
      id: 'tip-test2',
      extraction: { store_name: 'Chipotle', reward_category: 'Eating Out', total_amount: 23.50, tip: 5.00, purchase_date: '2026-06-02' },
      year: 2026, month: 'June',
    });

    const res = await handler(buildRequest(textMessage('tip: 8.00')));
    expect(res.status).toBe(200);

    const sendCall = mockFetch.mock.calls.find(c => c[0].includes('/sendMessage'));
    const body = JSON.parse(sendCall[1].body);
    // total should be 18.50 (original pre-tip) + 8.00 = 26.50, not 23.50 + 8.00
    expect(body.text).toContain('Total: $26.5');
    expect(body.text).toContain('incl. $8.00 tip');
  });

  it('invalid tip value returns error', async () => {
    setupTelegramMocks();
    mockStore.data.set(`confirm:123456789:tip-test3`, {
      id: 'tip-test3',
      extraction: { store_name: 'Chipotle', reward_category: 'Eating Out', total_amount: 18.50 },
    });

    const res = await handler(buildRequest(textMessage('tip: abc')));
    expect(res.status).toBe(200);
    const sendCall = mockFetch.mock.calls.find(c => c[0].includes('/sendMessage'));
    const body = JSON.parse(sendCall[1].body);
    expect(body.text).toContain('Invalid tip');
  });
});

/* ── R1: idempotency ── */

describe('telegram webhook — R1 idempotency', () => {
  it('ignores a re-delivered update_id (no double processing)', async () => {
    setupTelegramMocks();
    const update = { ...textMessage('GUIDE'), update_id: 555 };
    await handler(buildRequest(update));
    await handler(buildRequest(update));   // Telegram retry
    const sendCalls = mockFetch.mock.calls.filter(c => c[0].includes('/sendMessage'));
    expect(sendCalls.length).toBe(1);       // only the first was handled
  });
});

/* ── R9: greetings (deterministic, no AI) ── */

describe('telegram webhook — R9 greetings', () => {
  it('greets on "hi" without hitting the AI', async () => {
    setupTelegramMocks();
    const res = await handler(buildRequest(textMessage('hi')));
    expect(res.status).toBe(200);
    const body = JSON.parse(mockFetch.mock.calls.find(c => c[0].includes('/sendMessage'))[1].body);
    expect(body.text).toContain('budget bot');
    expect(mockFetch.mock.calls.some(c => c[0].includes('api.anthropic.com'))).toBe(false);
  });
});

/* ── R10: button-driven editing ── */

describe('telegram webhook — R10 button editing', () => {
  function seedPending(id = 'e1') {
    mockStore.data.set(`confirm:123456789:${id}`, {
      id, extraction: { store_name: 'X', total_amount: 10, reward_category: 'Misc' },
      year: 2026, month: 'May', status: 'awaiting_confirmation',
    });
  }

  it('edit:menu opens the field menu for a pending receipt', async () => {
    setupTelegramMocks();
    seedPending();
    await handler(buildRequest(callbackQuery('edit:menu')));
    const body = JSON.parse(mockFetch.mock.calls.find(c => c[0].includes('/sendMessage'))[1].body);
    expect(body.text).toContain('What do you want to edit');
    expect(body.reply_markup.inline_keyboard.flat().some(b => b.callback_data === 'edit:f:cat')).toBe(true);
  });

  it('edit:setcat:3 sets the category to Travel', async () => {
    setupTelegramMocks();
    seedPending('e2');
    await handler(buildRequest(callbackQuery('edit:setcat:3')));
    const body = JSON.parse(mockFetch.mock.calls.find(c => c[0].includes('/sendMessage'))[1].body);
    expect(body.text).toContain('Updated!');
    expect(body.text).toContain('Category: Travel');
    expect(mockStore.data.get('confirm:123456789:e2').extraction.reward_category).toBe('Travel');
  });

  it('button amount edit prompts, then captures the typed value', async () => {
    setupTelegramMocks();
    seedPending('e3');
    await handler(buildRequest(callbackQuery('edit:f:amt')));
    expect(mockStore.data.get('awaiting_edit:123456789')).toMatchObject({ scope: 'pending', field: 'amount' });

    vi.clearAllMocks();
    setupTelegramMocks();
    await handler(buildRequest(textMessage('52.10')));
    const body = JSON.parse(mockFetch.mock.calls.find(c => c[0].includes('/sendMessage'))[1].body);
    expect(body.text).toContain('Updated!');
    expect(body.text).toContain('Total: $52.1');
    expect(mockStore.data.has('awaiting_edit:123456789')).toBe(false);
  });

  it('edit:last re-categorizes the last logged expense (delete + re-append)', async () => {
    const userId = '123456789';
    mockStore.data.set(`lastlog:${userId}`, {
      uuid: 'uuid-x', category: 'Grocery', vendor: 'Cafe', amount: 12.5, txDate: '2026-05-10',
      sheetId: 'sheet-may', monthName: 'May 2026', loggedAt: new Date().toISOString(),
    });
    mockFetch.mockImplementation((url) => {
      if (url.includes('/sendMessage') || url.includes('/answerCallbackQuery')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
      }
      if (url.includes('oauth2.googleapis.com/token')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ access_token: 'tok', expires_in: 3600 }) });
      }
      if (url.includes('fields=sheets.properties')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ sheets: [{ properties: { title: 'Grocery', sheetId: 0 } }] }) });
      }
      if (url.includes('sheets.googleapis.com') && (url.includes('F:H') || url.includes('F%3AH'))) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ values: [['UUID'], ['uuid-x']] }) });
      }
      if (url.includes('sheets.googleapis.com')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ updates: { updatedRows: 1 }, values: [] }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    await handler(buildRequest(callbackQuery('edit:lastcat:3')));   // Travel
    const sendCalls = mockFetch.mock.calls.filter(c => c[0].includes('/sendMessage'));
    const body = JSON.parse(sendCalls[sendCalls.length - 1][1].body);
    expect(body.text).toContain('Updated');
    expect(body.text).toContain('Travel');
    expect(mockStore.data.get(`lastlog:${userId}`).category).toBe('Travel');
  });
});

describe('telegram webhook — edge cases', () => {
  it('returns 200 ok for unknown update types', async () => {
    const req = buildRequest({ update_id: 12345 });
    const res = await handler(req);
    expect(res.status).toBe(200);
  });

  it('returns 200 ok for empty message with no text/photo', async () => {
    setupTelegramMocks();
    const update = {
      message: {
        message_id: 5,
        from: { id: 123456789 },
        chat: { id: 123456789, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        sticker: { file_id: 'sticker123' },
      },
    };
    const req = buildRequest(update);
    const res = await handler(req);
    expect(res.status).toBe(200);
    // No sendMessage called for sticker
    const sendCalls = mockFetch.mock.calls.filter(c => c[0]?.includes?.('/sendMessage'));
    expect(sendCalls.length).toBe(0);
  });
});

/* ── Drive upload moved off the perceived critical path ── */

describe('telegram webhook — receipt latency: Drive upload is deferred', () => {
  const extraction = {
    store_name: 'Costco', purchase_date: '2026-05-25', total_amount: 89.50,
    currency: 'USD', items: [], reward_category: 'Grocery', is_transfer: false,
  };

  // Same as setupPhotoMocks, but every Drive call is held until released, so
  // the test can observe what happened while the upload was still in flight.
  function setupGatedDriveMocks(gate, { driveFails = false } = {}) {
    mockFetch.mockImplementation((url) => {
      if (url.includes('/getFile')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, result: { file_path: 'photos/file_0.jpg' } }) });
      }
      if (url.includes('api.telegram.org/file/')) {
        return Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(jpegBytes()) });
      }
      if (url.includes('generativelanguage.googleapis.com')) {
        return Promise.resolve(geminiResponse({ transactions: [extraction] }));
      }
      if (url.includes('oauth2.googleapis.com/token')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ access_token: 'tok', expires_in: 3600 }) });
      }
      if (url.includes('googleapis.com/drive') || url.includes('googleapis.com/upload')) {
        return gate.then(() => driveFails
          ? { ok: false, status: 500, json: () => Promise.resolve({ error: { message: 'drive down' } }) }
          : { ok: true, json: () => Promise.resolve({ id: 'file-123', webViewLink: 'https://drive.google.com/file/d/file-123/view', files: [{ id: 'folder-1' }] }) });
      }
      if (url.includes('/sendMessage')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, result: { message_id: 99 } }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ values: [] }) });
    });
  }

  const sendCalls = () => mockFetch.mock.calls.filter(c => c[0]?.includes?.('/sendMessage'));
  const confirmBlob = () => {
    for (const [k, v] of mockStore.data) if (k.startsWith('confirm:123456789:')) return v;
    return null;
  };
  // setTimeout is real here (only Date is faked), so this yields to the event loop.
  async function until(pred, tries = 50) {
    for (let i = 0; i < tries; i++) {
      if (pred()) return true;
      await new Promise(r => setTimeout(r, 0));
    }
    return pred();
  }

  it('sends the confirm prompt while the Drive upload is still in flight', async () => {
    let release;
    const gate = new Promise(r => { release = r; });
    setupGatedDriveMocks(gate);

    const inFlight = handler(buildRequest(photoMessage()));

    // The whole point of the change: the user has their prompt before Drive
    // has answered. Without the deferral this can never become true, because
    // the handler is still parked on uploadReceiptImage.
    const sent = await until(() => sendCalls().length > 0);
    expect(sent).toBe(true);
    expect(JSON.parse(sendCalls()[0][1].body).text).toContain('Costco');

    release();
    await inFlight;
  });

  it('still attaches the Drive ids to the confirm blob once the upload lands', async () => {
    let release;
    const gate = new Promise(r => { release = r; });
    setupGatedDriveMocks(gate);

    const inFlight = handler(buildRequest(photoMessage()));
    await until(() => sendCalls().length > 0);

    // Deferred, so not yet attached…
    expect(confirmBlob()?.driveFileId).toBeNull();
    release();
    await inFlight;
    // …but present by the time the handler returns.
    expect(confirmBlob()?.driveFileId).toBe('file-123');
  });

  it('survives the user confirming before the upload lands', async () => {
    let release;
    const gate = new Promise(r => { release = r; });
    setupGatedDriveMocks(gate);

    const inFlight = handler(buildRequest(photoMessage()));
    await until(() => sendCalls().length > 0);

    // Simulate the confirm/cancel consuming the blob inside the upload window.
    for (const k of [...mockStore.data.keys()]) {
      if (k.startsWith('confirm:123456789:')) mockStore.data.delete(k);
    }
    release();
    // Patching a blob that no longer exists must not throw.
    await expect(inFlight).resolves.toBeDefined();
  });

  it('a failed Drive upload does not break the receipt flow', async () => {
    let release;
    const gate = new Promise(r => { release = r; });
    setupGatedDriveMocks(gate, { driveFails: true });

    const inFlight = handler(buildRequest(photoMessage()));
    await until(() => sendCalls().length > 0);
    release();
    await inFlight;

    // Prompt still sent, blob still queued, just without a Drive link.
    expect(JSON.parse(sendCalls()[0][1].body).text).toContain('Costco');
    expect(confirmBlob()).not.toBeNull();
    expect(confirmBlob().driveFileId).toBeNull();
  });
});

/* ── CATFIX: logging a wallet charge the categorizer wasn't sure about ── */

describe('telegram webhook — CATFIX category pick', () => {
  const userId = '123456789';
  const pendingKey = `category_pending:${userId}:abc12345`;
  const pending = {
    id: 'abc12345', vendor: 'Chipotle', amount: 24.5, txDate: '2026-05-14',
    monthName: 'May 2026', sheetId: 'sheet-may', paymentMethod: 'Chase Sapphire Reserve',
    suggested: 'Travel',
  };

  function mockSheets({ appendFails = false } = {}) {
    mockFetch.mockImplementation((url, opts) => {
      if (url.includes('/sendMessage') || url.includes('/answerCallbackQuery')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
      }
      if (url.includes('oauth2.googleapis.com/token')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ access_token: 'tok', expires_in: 3600 }) });
      }
      if (url.includes('sheets.googleapis.com') && url.includes('Months')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ values: [['May 2026', 'sheet-may']] }) });
      }
      if (appendFails && opts?.method === 'PUT') {
        return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: { message: 'sheet locked' } }) });
      }
      if (url.includes('sheets.googleapis.com')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ updates: { updatedRows: 1 }, values: [] }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });
  }

  const lastSend = () => {
    const calls = mockFetch.mock.calls.filter(c => c[0]?.includes?.('/sendMessage'));
    return JSON.parse(calls[calls.length - 1][1].body).text;
  };

  beforeEach(() => {
    mockStore.data.clear();
    mockSheets();
  });

  it('writes the parked charge with the tapped category and clears the blob', async () => {
    mockStore.data.set(pendingKey, { ...pending });
    await handler(buildRequest(callbackQuery('CATFIX:abc12345:Eating Out')));

    expect(lastSend()).toContain('Logged Chipotle');
    expect(lastSend()).toContain('Eating Out');
    expect(mockStore.data.has(pendingKey)).toBe(false);
  });

  it('tells the user plainly when the charge is already gone', async () => {
    await handler(buildRequest(callbackQuery('CATFIX:abc12345:Grocery')));
    expect(lastSend()).toContain('no longer waiting');
  });

  it('keeps the charge parked when the sheet write fails, so it can be retried', async () => {
    mockSheets({ appendFails: true });
    mockStore.data.set(pendingKey, { ...pending });
    await handler(buildRequest(callbackQuery('CATFIX:abc12345:Grocery')));

    // The blob is the only record of this charge — losing it would lose the expense.
    expect(mockStore.data.has(pendingKey)).toBe(true);
    expect(lastSend()).toMatch(/Couldn't log|retry/i);
  });

  it('CANCEL clears a parked category charge', async () => {
    mockStore.data.set(pendingKey, { ...pending });
    await handler(buildRequest(textMessage('CANCEL')));
    expect(mockStore.data.has(pendingKey)).toBe(false);
  });
});

/* ── AUDITFIX: moving an already-logged expense between category tabs ── */

describe('telegram webhook — AUDITFIX category move', () => {
  const HEADER = ['Timestamp', 'Action', 'Category', 'Vendor', 'Amount', 'Details', 'Reserved', 'User', 'UUID', 'TxDate'];
  const row = ['2026-05-10T08:00:00Z', 'Added', 'Misc', 'Chipotle', 24.5, '', '', 'Alice', 'tx_abc', '2026-05-10'];

  // Records what the handler did so append/delete ordering can be asserted.
  let ops;

  function mockSheets({ appendFails = false, deleteFails = false } = {}) {
    ops = [];
    mockFetch.mockImplementation((url, opts) => {
      if (url.includes('/sendMessage') || url.includes('/answerCallbackQuery')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
      }
      if (url.includes('oauth2.googleapis.com/token')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ access_token: 'tok', expires_in: 3600 }) });
      }
      if (url.includes('Months')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ values: [['May 2026', 'sheet-may']] }) });
      }
      if (url.includes('History')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ values: [HEADER, row] }) });
      }
      // Row write for the new category tab.
      if (opts?.method === 'PUT') {
        ops.push('append');
        return appendFails
          ? Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: { message: 'append blew up' } }) })
          : Promise.resolve({ ok: true, json: () => Promise.resolve({ updates: { updatedRows: 1 } }) });
      }
      // Row removal from the old tab.
      if (url.includes(':batchUpdate')) {
        ops.push('delete');
        return deleteFails
          ? Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: { message: 'delete blew up' } }) })
          : Promise.resolve({ ok: true, json: () => Promise.resolve({ replies: [] }) });
      }
      // UUID lookup across category tabs (deleteExpenseByUUID scans F:H).
      if (url.includes('F:H') || url.includes('F%3AH')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ values: [['tx_abc']] }) });
      }
      // Tab metadata, needed to turn a row index into a deleteDimension range.
      if (url.includes('fields=sheets.properties')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({
          sheets: [
            { properties: { title: 'Misc', sheetId: 1 } },
            { properties: { title: 'Eating Out', sheetId: 2 } },
          ],
        }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ values: [] }) });
    });
  }

  const lastSend = () => {
    const calls = mockFetch.mock.calls.filter(c => c[0]?.includes?.('/sendMessage'));
    return JSON.parse(calls[calls.length - 1][1].body).text;
  };

  beforeEach(() => { mockStore.data.clear(); mockSheets(); });

  it('moves the expense and reports both sides of the move', async () => {
    await handler(buildRequest(callbackQuery('AUDITFIX:tx_abc:Eating Out')));
    const text = lastSend();
    expect(text).toContain('Moved Chipotle');
    expect(text).toContain('Misc');
    expect(text).toContain('Eating Out');
  });

  it('appends before deleting, so a half-failure duplicates instead of losing', async () => {
    await handler(buildRequest(callbackQuery('AUDITFIX:tx_abc:Eating Out')));
    expect(ops).toEqual(['append', 'delete']);
  });

  it('changes nothing when the append fails', async () => {
    mockSheets({ appendFails: true });
    await handler(buildRequest(callbackQuery('AUDITFIX:tx_abc:Eating Out')));

    expect(ops).not.toContain('delete');   // old row untouched
    expect(lastSend()).toContain('Nothing was changed');
  });

  it('says so plainly when the old row could not be removed', async () => {
    mockSheets({ deleteFails: true });
    await handler(buildRequest(callbackQuery('AUDITFIX:tx_abc:Eating Out')));

    // The user now has a duplicate; claiming success would hide it.
    const text = lastSend();
    expect(text).toContain("couldn't remove the old");
    expect(text).toMatch(/counted twice/i);
  });

  it('handles an expense that has since disappeared', async () => {
    await handler(buildRequest(callbackQuery('AUDITFIX:tx_gone:Eating Out')));
    expect(lastSend()).toContain('Could not find that expense');
  });

  it('no-ops when the expense is already in the suggested category', async () => {
    await handler(buildRequest(callbackQuery('AUDITFIX:tx_abc:Misc')));
    expect(lastSend()).toContain('already in Misc');
    expect(ops).toEqual([]);
  });
});

/* ── Duplicate prevention on the receipt confirm prompt ── */

describe('telegram webhook — duplicate warning before logging', () => {
  const extraction = {
    store_name: 'Costco', purchase_date: '2026-05-14', total_amount: 89.50,
    currency: 'USD', items: [], reward_category: 'Grocery', is_transfer: false,
  };
  const HEADER = ['Timestamp', 'Action', 'Category', 'Vendor', 'Amount', 'Details', 'Reserved', 'User', 'UUID', 'TxDate'];
  // Already logged: same vendor + amount, one day earlier, filed under Misc —
  // the wallet-then-receipt case this exists to catch.
  const alreadyLogged = ['2026-05-13T08:00:00Z', 'Added', 'Misc', 'Costco', 89.5, '', '', 'Alice', 'tx_old', '2026-05-13'];

  function setupMocks({ history = [], historyFails = false } = {}) {
    mockFetch.mockImplementation((url) => {
      if (url.includes('/getFile')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, result: { file_path: 'photos/f.jpg' } }) });
      }
      if (url.includes('api.telegram.org/file/')) {
        return Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(jpegBytes()) });
      }
      if (url.includes('generativelanguage.googleapis.com')) {
        return Promise.resolve(geminiResponse({ transactions: [extraction] }));
      }
      if (url.includes('oauth2.googleapis.com/token')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ access_token: 'tok', expires_in: 3600 }) });
      }
      if (url.includes('Months')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ values: [['May 2026', 'sheet-may']] }) });
      }
      if (url.includes('History')) {
        if (historyFails) return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: { message: 'sheets down' } }) });
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ values: [HEADER, ...history] }) });
      }
      if (url.includes('googleapis.com/drive') || url.includes('googleapis.com/upload')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ id: 'file-1', webViewLink: 'x', files: [{ id: 'f' }] }) });
      }
      if (url.includes('/sendMessage')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, result: { message_id: 9 } }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ values: [] }) });
    });
  }

  const lastSend = () => {
    const calls = mockFetch.mock.calls.filter(c => c[0]?.includes?.('/sendMessage'));
    return JSON.parse(calls[calls.length - 1][1].body);
  };

  beforeEach(() => { mockStore.data.clear(); });

  it('warns and relabels the button when the charge is already logged', async () => {
    setupMocks({ history: [alreadyLogged] });
    await handler(buildRequest(photoMessage()));

    const body = lastSend();
    expect(body.text).toContain('Possible duplicate');
    expect(body.text).toContain('Costco');
    expect(body.text).toContain('Misc');            // names the category it's already in
    expect(body.text).toContain('Reply YES to log'); // the normal prompt still follows
    // Confirming becomes a deliberate act, but the callback_data is unchanged
    // so the existing confirm handler still works.
    expect(body.reply_markup.inline_keyboard[0][0].text).toContain('Log anyway');
    expect(body.reply_markup.inline_keyboard[0][0].callback_data).toBe('YES');
  });

  it('leaves the normal prompt alone when nothing matches', async () => {
    setupMocks({ history: [] });
    await handler(buildRequest(photoMessage()));

    const body = lastSend();
    expect(body.text).not.toContain('Possible duplicate');
    expect(body.reply_markup.inline_keyboard[0][0].text).toContain('YES');
    expect(body.reply_markup.inline_keyboard[0][0].callback_data).toBe('YES');
  });

  it('does not warn about a same-vendor charge outside the date window', async () => {
    // A repeat purchase at the same amount two weeks earlier is not a duplicate.
    const old = [...alreadyLogged];
    old[0] = '2026-04-28T08:00:00Z';
    old[9] = '2026-04-28';
    setupMocks({ history: [old] });
    await handler(buildRequest(photoMessage()));
    expect(lastSend().text).not.toContain('Possible duplicate');
  });

  it('still logs normally when the duplicate check itself fails', async () => {
    // A broken check must never block someone logging an expense.
    setupMocks({ historyFails: true });
    await handler(buildRequest(photoMessage()));

    const body = lastSend();
    expect(body.text).toContain('Costco');
    expect(body.text).not.toContain('Possible duplicate');
    expect(body.reply_markup.inline_keyboard[0][0].callback_data).toBe('YES');
  });
});

/* ── DELETE disambiguation when one vendor has several identical rows ── */

describe('telegram webhook — DELETE list disambiguates duplicate vendor+amount', () => {
  const userId = '123456789';
  // Same vendor, same amount, different dates — indistinguishable before this fix.
  // Web layout: uuid@8, txDate@9. History is append-only, and getRecentExpenses
  // reverses it, so the LAST row here comes back as #1.
  const HEADER = ['Timestamp', 'Action', 'Category', 'Vendor', 'Amount', 'Details', 'Reserved', 'User', 'UUID', 'TxDate'];
  const costcoOld = ['2026-05-08T08:00:00Z', 'Added', 'Grocery', 'Costco', 50, '', '', 'Alice', 'uuid-older', '2026-05-08'];
  const costcoNew = ['2026-05-11T08:00:00Z', 'Added', 'Grocery', 'Costco', 50, '', '', 'Alice', 'uuid-newer', '2026-05-11'];

  function mockSheets() {
    mockFetch.mockImplementation((url) => {
      if (url.includes('/sendMessage') || url.includes('/answerCallbackQuery')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
      }
      if (url.includes('oauth2.googleapis.com/token')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ access_token: 'tok', expires_in: 3600 }) });
      }
      if (url.includes('sheets.googleapis.com') && url.includes('Months')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ values: [['May 2026', 'sheet-may']] }) });
      }
      if (url.includes('sheets.googleapis.com') && url.includes('History')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ values: [HEADER, costcoOld, costcoNew] }) });
      }
      if (url.includes('sheets.googleapis.com')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ updates: { updatedRows: 1 }, values: [] }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });
  }

  beforeEach(() => {
    mockStore.data.clear();
    mockSheets();
  });

  function lastSendText() {
    const calls = mockFetch.mock.calls.filter(c => c[0]?.includes?.('/sendMessage'));
    return JSON.parse(calls[calls.length - 1][1].body).text;
  }

  it('shows a date on each line so identical vendor+amount rows are separable', async () => {
    await handler(buildRequest(textMessage('DELETE')));
    const text = lastSendText();

    // Both rows read "Costco · $50.00" — the date is the only differentiator.
    expect(text).toContain('#1 Costco · $50.00 · May 11');
    expect(text).toContain('#2 Costco · $50.00 · May 8');
  });

  it('DELETE #2 targets the older row, not the newer one', async () => {
    await handler(buildRequest(textMessage('DELETE #2')));

    // The pending delete is what CONFIRM DELETE later acts on, so this is the
    // assertion that #N maps to the row the user actually saw at that index.
    const pending = mockStore.data.get(`delete_pending:${userId}`);
    expect(pending.target.uuid).toBe('uuid-older');
    expect(pending.target.vendor).toBe('Costco');
  });

  it('DELETE #1 targets the newer row', async () => {
    await handler(buildRequest(textMessage('DELETE #1')));
    expect(mockStore.data.get(`delete_pending:${userId}`).target.uuid).toBe('uuid-newer');
  });

  it('repeats the date on the confirm screen, the last stop before deletion', async () => {
    await handler(buildRequest(textMessage('DELETE #2')));
    const text = lastSendText();
    expect(text).toContain('Delete this expense');
    expect(text).toContain('Date: May 8');
  });
});
