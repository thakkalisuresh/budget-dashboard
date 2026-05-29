import { describe, it, expect, vi, beforeEach } from 'vitest';

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
  list({ prefix }) {
    const blobs = [];
    for (const key of this.data.keys()) {
      if (key.startsWith(prefix)) blobs.push({ key });
    }
    return Promise.resolve({ blobs });
  },
};

vi.mock('@netlify/blobs', () => ({
  getStore: () => mockStore,
}));

const mockFetch = vi.fn();
global.fetch = mockFetch;

const { default: handler } = await import('../../netlify/functions/telegram-webhook.mjs');

const WEBHOOK_URL = 'https://test.netlify.app/.netlify/functions/telegram-webhook';

/* ── Request builders ── */

function buildRequest(update, secret = 'test-webhook-secret') {
  return new Request(WEBHOOK_URL, {
    method: 'POST',
    headers: new Headers({
      'content-type': 'application/json',
      'x-telegram-bot-api-secret-token': secret,
    }),
    body: JSON.stringify(update),
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
    // Gemini extraction
    if (url.includes('generativelanguage.googleapis.com')) {
      if (extractionResult === 'fail') {
        return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: { message: 'fail' } }) });
      }
      return Promise.resolve(geminiResponse(extractionResult));
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
    const req = new Request(WEBHOOK_URL, { method: 'GET' });
    const res = await handler(req);
    expect(res.status).toBe(405);
  });

  it('rejects missing webhook secret', async () => {
    const req = new Request(WEBHOOK_URL, {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify(textMessage('hello')),
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
      if (url.includes('sheets.googleapis.com') && (url.includes('F:F') || url.includes('F%3AF'))) {
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
      if (url.includes('sheets.googleapis.com') && (url.includes('F:F') || url.includes('F%3AF'))) {
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
