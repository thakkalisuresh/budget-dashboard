import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.stubEnv('WALLET_WEBHOOK_SECRET', 'test-wallet-secret');

// Shared mock state (hoisted so the vi.mock factories can close over it).
const { extractMock, appendMock, webpushSend, ctl } = vi.hoisted(() => ({
  extractMock: vi.fn(),
  appendMock: vi.fn(),
  webpushSend: vi.fn(),
  ctl: { pushDoc: null, deleted: false },
}));

vi.mock('../../functions/lib/_extraction.mjs', () => ({ extractTransactionText: extractMock }));
vi.mock('../../functions/lib/_sheets.mjs', () => ({ appendExpense: appendMock }));
vi.mock('web-push', () => ({ default: { setVapidDetails: vi.fn(), sendNotification: webpushSend } }));
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
  webpushSend.mockReset().mockResolvedValue(undefined);
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

  it('400 on missing sheetId', async () => {
    const res = await call(req({ body: { ...validBody, sheetId: undefined } }));
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/sheetId/i);
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
