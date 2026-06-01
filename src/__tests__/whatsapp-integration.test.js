import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';

vi.stubEnv('TWILIO_AUTH_TOKEN', 'test-auth-token');
vi.stubEnv('TWILIO_ACCOUNT_SID', 'ACtest123');
vi.stubEnv('WHATSAPP_ALLOWED_PHONES', '+919567791515,+18285107202');
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

const { default: handler } = await import('../../netlify/functions/whatsapp-webhook.mjs');

const WEBHOOK_URL = 'https://test.netlify.app/.netlify/functions/whatsapp-webhook';
const AUTH_TOKEN  = 'test-auth-token';

function computeSignature(url, params) {
  const sortedKeys = Object.keys(params).sort();
  const data = sortedKeys.reduce((acc, key) => acc + key + params[key], url);
  return crypto.createHmac('sha1', AUTH_TOKEN).update(data).digest('base64');
}

function buildRequest(params) {
  const body = new URLSearchParams(params).toString();
  const signature = computeSignature(WEBHOOK_URL, params);
  return new Request(WEBHOOK_URL, {
    method: 'POST',
    headers: new Headers({
      'content-type': 'application/x-www-form-urlencoded',
      'x-twilio-signature': signature,
    }),
    body,
  });
}

function jpegBytes() {
  const buf = new ArrayBuffer(12);
  const view = new Uint8Array(buf);
  view.set([0xFF, 0xD8, 0xFF, 0xE0, 0, 0, 0, 0, 0, 0, 0, 0]);
  return buf;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockStore.data.clear();
});

describe('webhook handler — signature validation', () => {
  it('rejects requests with invalid signature', async () => {
    const req = new Request(WEBHOOK_URL, {
      method: 'POST',
      headers: new Headers({
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': 'invalid-sig',
      }),
      body: 'From=whatsapp%3A%2B919567791515&Body=hello&NumMedia=0',
    });
    const res = await handler(req);
    expect(res.status).toBe(403);
  });

  it('rejects non-POST requests', async () => {
    const req = new Request(WEBHOOK_URL, { method: 'GET' });
    const res = await handler(req);
    expect(res.status).toBe(405);
  });
});

describe('webhook handler — phone allowlist', () => {
  it('rejects unregistered phone numbers', async () => {
    const params = { From: 'whatsapp:+15555555555', Body: 'hello', NumMedia: '0' };
    const res = await handler(buildRequest(params));
    const text = await res.text();
    expect(text).toContain("isn't registered");
  });

  it('accepts registered phone numbers', async () => {
    const params = { From: 'whatsapp:+919567791515', Body: 'hello', NumMedia: '0' };
    const res = await handler(buildRequest(params));
    const text = await res.text();
    expect(text).not.toContain("isn't registered");
  });
});

describe('webhook handler — rate limiting', () => {
  it('blocks after 50 receipts in a day', async () => {
    const phone = '+919567791515';
    const dateKey = new Date().toISOString().slice(0, 10);
    mockStore.data.set(`rate:${phone}:${dateKey}`, { count: 50 });

    const params = {
      From: `whatsapp:${phone}`,
      Body: '',
      NumMedia: '1',
      MediaUrl0: 'https://api.twilio.com/media/test.jpg',
      MediaContentType0: 'image/jpeg',
    };
    const res = await handler(buildRequest(params));
    const text = await res.text();
    expect(text).toContain("reached 50 receipts");
  });
});

describe('webhook handler — media validation', () => {
  it('rejects unsupported media types', async () => {
    const params = {
      From: 'whatsapp:+919567791515',
      Body: '',
      NumMedia: '1',
      MediaUrl0: 'https://api.twilio.com/media/test.gif',
      MediaContentType0: 'image/gif',
    };
    const res = await handler(buildRequest(params));
    const text = await res.text();
    expect(text).toContain('Unsupported file type');
  });

  it('rejects files with mismatched magic bytes', async () => {
    const pngBytes = new ArrayBuffer(12);
    new Uint8Array(pngBytes).set([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0]);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: () => Promise.resolve(pngBytes),
    });

    const params = {
      From: 'whatsapp:+919567791515',
      Body: '',
      NumMedia: '1',
      MediaUrl0: 'https://api.twilio.com/media/test.jpg',
      MediaContentType0: 'image/jpeg',
    };
    const res = await handler(buildRequest(params));
    const text = await res.text();
    expect(text).toContain('does not match its type');
  });
});

describe('webhook handler — receipt extraction flow', () => {
  function setupMediaAndExtraction(extractionResult) {
    mockFetch.mockImplementation((url) => {
      if (url.includes('twilio.com/media')) {
        return Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(jpegBytes()) });
      }
      if (url.includes('generativelanguage.googleapis.com')) {
        if (extractionResult === 'fail') {
          return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: { message: 'fail' } }) });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            candidates: [{ content: { parts: [{ text: JSON.stringify(extractionResult) }] } }],
          }),
        });
      }
      if (url.includes('oauth2.googleapis.com/token')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ access_token: 'tok', expires_in: 3600 }) });
      }
      if (url.includes('googleapis.com/drive') || url.includes('googleapis.com/upload')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ id: 'file-123', webViewLink: 'https://drive.google.com/file/d/file-123/view', files: [{ id: 'folder-1' }] }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });
  }

  it('sends confirmation prompt on successful extraction', async () => {
    setupMediaAndExtraction({
      store_name: 'Target',
      purchase_date: '2026-05-20',
      total_amount: 42.50,
      reward_category: 'Misc',
    });

    const params = {
      From: 'whatsapp:+919567791515',
      Body: '',
      NumMedia: '1',
      MediaUrl0: 'https://api.twilio.com/media/img.jpg',
      MediaContentType0: 'image/jpeg',
    };
    const res = await handler(buildRequest(params));
    const text = await res.text();
    expect(text).toContain('Store: Target');
    expect(text).toContain('Total: $42.5');
    expect(text).toContain('Reply YES to log');
  });

  it('asks for manual input when extraction fails', async () => {
    setupMediaAndExtraction('fail');

    const params = {
      From: 'whatsapp:+919567791515',
      Body: '',
      NumMedia: '1',
      MediaUrl0: 'https://api.twilio.com/media/img.jpg',
      MediaContentType0: 'image/jpeg',
    };
    const res = await handler(buildRequest(params));
    const text = await res.text();
    expect(text).toContain("parse receipt clearly");
    expect(text).toContain("Walmart 45.23 Grocery");
  });

  it('asks for manual input when total_amount is null', async () => {
    setupMediaAndExtraction({
      store_name: 'SomeStore',
      purchase_date: null,
      total_amount: null,
      reward_category: 'Misc',
    });

    const params = {
      From: 'whatsapp:+919567791515',
      Body: '',
      NumMedia: '1',
      MediaUrl0: 'https://api.twilio.com/media/img.jpg',
      MediaContentType0: 'image/jpeg',
    };
    const res = await handler(buildRequest(params));
    const text = await res.text();
    expect(text).toContain('confirm total amount');
  });
});

describe('webhook handler — text reply confirmation', () => {
  it('handles YES — logs receipt and sends summary', async () => {
    mockStore.data.set('confirm:+919567791515:receipt-abc', {
      id: 'receipt-abc',
      phone: '+919567791515',
      extraction: {
        store_name: 'Costco',
        purchase_date: '2026-05-22',
        total_amount: 89.99,
        reward_category: 'Grocery',
      },
      driveFileId: 'drive-file-1',
      driveShareLink: 'https://drive.google.com/file/d/drive-file-1/view',
      year: 2026,
      month: 'May',
    });

    mockFetch.mockImplementation((url) => {
      if (url.includes('oauth2.googleapis.com/token')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ access_token: 'tok', expires_in: 3600 }) });
      }
      if (url.includes('sheets.googleapis.com')) {
        if (url.includes('Months')) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ values: [['May 2026', 'sheet-may-id']] }) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ updates: { updatedRows: 1 } }) });
      }
      if (url.includes('googleapis.com/drive')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ id: 'folder-1', files: [{ id: 'folder-1' }], parents: ['old-parent'] }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    const params = { From: 'whatsapp:+919567791515', Body: 'yes', NumMedia: '0' };
    const res = await handler(buildRequest(params));
    const text = await res.text();
    expect(text).toContain('Receipt logged!');
    expect(text).toContain('Store/Vendor: Costco');
    expect(text).toContain('$89.99');
    expect(text).toContain('Grocery');
    expect(text).toContain('drive.google.com');
    expect(text).toContain('View Sheet: https://docs.google.com/spreadsheets/d/');
    expect(mockStore.data.has('confirm:+919567791515:receipt-abc')).toBe(false);
  });

  it('handles CANCEL — deletes pending and confirms', async () => {
    mockStore.data.set('confirm:+919567791515:receipt-xyz', {
      id: 'receipt-xyz',
      phone: '+919567791515',
      extraction: { store_name: 'Store', total_amount: 10, reward_category: 'Misc' },
    });

    const params = { From: 'whatsapp:+919567791515', Body: 'CANCEL', NumMedia: '0' };
    const res = await handler(buildRequest(params));
    const text = await res.text();
    expect(text).toContain('Cancelled');
    expect(mockStore.data.has('confirm:+919567791515:receipt-xyz')).toBe(false);
  });

  it('handles YES with no pending receipt', async () => {
    const params = { From: 'whatsapp:+919567791515', Body: 'YES', NumMedia: '0' };
    const res = await handler(buildRequest(params));
    const text = await res.text();
    expect(text).toContain('No pending action');
  });

  it('is case-insensitive (yes/Yes/YES all work)', async () => {
    mockStore.data.set('confirm:+919567791515:r1', {
      id: 'r1', phone: '+919567791515',
      extraction: { store_name: 'S', total_amount: 5, reward_category: 'Misc' },
      year: 2026, month: 'May',
    });

    mockFetch.mockImplementation((url) => {
      if (url.includes('oauth2')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ access_token: 'tok', expires_in: 3600 }) });
      if (url.includes('Months')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ values: [['May 2026', 'sid']] }) });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ updates: { updatedRows: 1 }, files: [] }) });
    });

    const params = { From: 'whatsapp:+919567791515', Body: '  yes  ', NumMedia: '0' };
    const res = await handler(buildRequest(params));
    const text = await res.text();
    expect(text).toContain('Receipt logged!');
  });
});

describe('webhook handler — manual clarification', () => {
  it('parses "Store 45.23 Category" and creates confirmation', async () => {
    mockStore.data.set('pending:failed-id', {
      id: 'failed-id',
      phone: '+919567791515',
      status: 'extraction_failed',
      mediaType: 'image/jpeg',
      base64: 'abc',
    });

    const params = { From: 'whatsapp:+919567791515', Body: 'Walmart 45.23 Grocery', NumMedia: '0' };
    const res = await handler(buildRequest(params));
    const text = await res.text();
    expect(text).toContain('Walmart');
    expect(text).toContain('Grocery');
    expect(text).toContain('$45.23');
    expect(text).toContain('Reply YES to log');
  });

  it('rejects invalid amount in manual input', async () => {
    mockStore.data.set('pending:failed-id', {
      id: 'failed-id',
      phone: '+919567791515',
      status: 'extraction_failed',
    });

    const params = { From: 'whatsapp:+919567791515', Body: 'Store abc Grocery', NumMedia: '0' };
    const res = await handler(buildRequest(params));
    const text = await res.text();
    // Won't match the regex (abc isn't digits), so falls through to generic help
    expect(text).toContain('Send a receipt photo');
  });

  it('defaults to Misc for unrecognized category', async () => {
    mockStore.data.set('pending:failed-id', {
      id: 'failed-id',
      phone: '+919567791515',
      status: 'extraction_failed',
      mediaType: 'image/jpeg',
      base64: 'abc',
    });

    const params = { From: 'whatsapp:+919567791515', Body: 'Random Store 20 FakeCategory', NumMedia: '0' };
    const res = await handler(buildRequest(params));
    const text = await res.text();
    expect(text).toContain('Misc');
  });
});

describe('webhook handler — direct manual entry (H1)', () => {
  it('creates confirmation from text without a pending photo', async () => {
    const params = { From: 'whatsapp:+919567791515', Body: 'Target 32.50 Grocery', NumMedia: '0' };
    const res = await handler(buildRequest(params));
    const text = await res.text();
    expect(text).toContain('Target');
    expect(text).toContain('Grocery');
    expect(text).toContain('$32.5');
    expect(text).toContain('Reply YES to log');
  });
});

describe('webhook handler — edit before confirming (H2)', () => {
  it('updates category on pending receipt', async () => {
    mockStore.data.set('confirm:+919567791515:edit-test', {
      id: 'edit-test',
      phone: '+919567791515',
      extraction: {
        store_name: 'Costco',
        purchase_date: '2026-05-22',
        total_amount: 89.99,
        reward_category: 'Misc',
      },
    });

    const params = { From: 'whatsapp:+919567791515', Body: 'category: Grocery', NumMedia: '0' };
    const res = await handler(buildRequest(params));
    const text = await res.text();
    expect(text).toContain('Updated!');
    expect(text).toContain('Grocery');
    const updated = mockStore.data.get('confirm:+919567791515:edit-test');
    expect(updated.extraction.reward_category).toBe('Grocery');
  });

  it('updates amount on pending receipt', async () => {
    mockStore.data.set('confirm:+919567791515:edit-amt', {
      id: 'edit-amt',
      phone: '+919567791515',
      extraction: {
        store_name: 'Target',
        purchase_date: '2026-05-22',
        total_amount: 10,
        reward_category: 'Misc',
      },
    });

    const params = { From: 'whatsapp:+919567791515', Body: 'amount: 52.10', NumMedia: '0' };
    const res = await handler(buildRequest(params));
    const text = await res.text();
    expect(text).toContain('Updated!');
    expect(text).toContain('$52.1');
  });

  it('updates store name on pending receipt', async () => {
    mockStore.data.set('confirm:+919567791515:edit-store', {
      id: 'edit-store',
      phone: '+919567791515',
      extraction: {
        store_name: 'Walmaart',
        purchase_date: '2026-05-22',
        total_amount: 45,
        reward_category: 'Misc',
      },
    });

    const params = { From: 'whatsapp:+919567791515', Body: 'store: Walmart', NumMedia: '0' };
    const res = await handler(buildRequest(params));
    const text = await res.text();
    expect(text).toContain('Updated!');
    expect(text).toContain('Walmart');
  });

  it('rejects invalid category', async () => {
    mockStore.data.set('confirm:+919567791515:edit-bad', {
      id: 'edit-bad',
      phone: '+919567791515',
      extraction: { store_name: 'X', total_amount: 5, reward_category: 'Misc' },
    });

    const params = { From: 'whatsapp:+919567791515', Body: 'category: FakeCategory', NumMedia: '0' };
    const res = await handler(buildRequest(params));
    const text = await res.text();
    expect(text).toContain('Unknown category');
  });

  it('returns error when no pending receipt to edit', async () => {
    const params = { From: 'whatsapp:+919567791515', Body: 'category: Grocery', NumMedia: '0' };
    const res = await handler(buildRequest(params));
    const text = await res.text();
    expect(text).toContain('No pending receipt to edit');
  });
});

describe('webhook handler — UNDO (H3)', () => {
  it('undoes the last logged entry within 10 minutes', async () => {
    mockStore.data.set('lastlog:+919567791515', {
      uuid: 'tx_4523_abc12345',
      category: 'Grocery',
      vendor: 'Walmart',
      amount: 45.23,
      sheetId: 'sheet-123',
      loggedAt: new Date().toISOString(),
    });

    mockFetch.mockImplementation((url) => {
      if (url.includes('oauth2.googleapis.com/token')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ access_token: 'tok', expires_in: 3600 }) });
      }
      if (url.includes('values') && url.includes('F%3AF')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ values: [['Header'], ['tx_4523_abc12345']] }) });
      }
      if (url.includes('fields=sheets.properties')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ sheets: [{ properties: { title: 'Grocery', sheetId: 0 } }] }) });
      }
      if (url.includes('batchUpdate')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    const params = { From: 'whatsapp:+919567791515', Body: 'UNDO', NumMedia: '0' };
    const res = await handler(buildRequest(params));
    const text = await res.text();
    expect(text).toContain('Undone');
    expect(text).toContain('Walmart');
    expect(text).toContain('$45.23');
    expect(mockStore.data.has('lastlog:+919567791515')).toBe(false);
  });

  it('rejects UNDO with no last entry', async () => {
    const params = { From: 'whatsapp:+919567791515', Body: 'UNDO', NumMedia: '0' };
    const res = await handler(buildRequest(params));
    const text = await res.text();
    expect(text).toContain('Nothing to undo');
  });

  it('rejects UNDO after 10-minute window', async () => {
    mockStore.data.set('lastlog:+919567791515', {
      uuid: 'tx_1000_old',
      category: 'Misc',
      vendor: 'OldStore',
      amount: 10,
      sheetId: 'sheet-123',
      loggedAt: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
    });

    const params = { From: 'whatsapp:+919567791515', Body: 'UNDO', NumMedia: '0' };
    const res = await handler(buildRequest(params));
    const text = await res.text();
    expect(text).toContain('expired');
  });
});

describe('webhook handler — ATTACH (H4)', () => {
  it('sets awaiting_attach state', async () => {
    mockStore.data.set('lastlog:+919567791515', {
      uuid: 'tx_5000_xyz',
      category: 'Grocery',
      vendor: 'Costco',
      amount: 50,
      year: 2026,
      month: 'May',
      loggedAt: new Date().toISOString(),
    });

    const params = { From: 'whatsapp:+919567791515', Body: 'ATTACH', NumMedia: '0' };
    const res = await handler(buildRequest(params));
    const text = await res.text();
    expect(text).toContain('Send the receipt photo');
    expect(text).toContain('Costco');
    expect(mockStore.data.has('awaiting_attach:+919567791515')).toBe(true);
  });

  it('rejects ATTACH when last entry already has a receipt', async () => {
    mockStore.data.set('lastlog:+919567791515', {
      uuid: 'tx_5000_xyz',
      category: 'Grocery',
      vendor: 'Costco',
      amount: 50,
      driveFileId: 'already-uploaded',
      loggedAt: new Date().toISOString(),
    });

    const params = { From: 'whatsapp:+919567791515', Body: 'ATTACH', NumMedia: '0' };
    const res = await handler(buildRequest(params));
    const text = await res.text();
    expect(text).toContain('already has a receipt');
  });

  it('rejects ATTACH with no last entry', async () => {
    const params = { From: 'whatsapp:+919567791515', Body: 'ATTACH', NumMedia: '0' };
    const res = await handler(buildRequest(params));
    const text = await res.text();
    expect(text).toContain('No recent entry');
  });
});

describe('webhook handler — YES stores lastlog for UNDO/ATTACH', () => {
  it('stores lastlog blob after confirming YES', async () => {
    mockStore.data.set('confirm:+919567791515:receipt-log', {
      id: 'receipt-log',
      phone: '+919567791515',
      extraction: {
        store_name: 'Target',
        purchase_date: '2026-05-24',
        total_amount: 25,
        reward_category: 'Misc',
      },
      year: 2026,
      month: 'May',
    });

    mockFetch.mockImplementation((url) => {
      if (url.includes('oauth2.googleapis.com/token')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ access_token: 'tok', expires_in: 3600 }) });
      }
      if (url.includes('sheets.googleapis.com')) {
        if (url.includes('Months')) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ values: [['May 2026', 'sheet-may-id']] }) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ updates: { updatedRows: 1 } }) });
      }
      if (url.includes('googleapis.com/drive')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ id: 'folder-1', files: [{ id: 'folder-1' }], parents: ['old-parent'] }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    const params = { From: 'whatsapp:+919567791515', Body: 'yes', NumMedia: '0' };
    const res = await handler(buildRequest(params));
    const text = await res.text();
    expect(text).toContain('Receipt logged!');
    expect(text).toContain('UNDO to reverse');

    const lastlog = mockStore.data.get('lastlog:+919567791515');
    expect(lastlog).toBeTruthy();
    expect(lastlog.vendor).toBe('Target');
    expect(lastlog.amount).toBe(25);
  });
});

describe('webhook handler — transaction text parsing (I1)', () => {
  it('parses a bank SMS and creates confirmation', async () => {
    mockFetch.mockImplementation((url) => {
      if (url.includes('generativelanguage.googleapis.com')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            candidates: [{ content: { parts: [{ text: JSON.stringify({
              store_name: 'WALMART',
              purchase_date: '2026-05-24',
              total_amount: 45.23,
              currency: 'USD',
              reward_category: 'Grocery',
              is_transfer: false,
            }) }] } }],
          }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    const params = {
      From: 'whatsapp:+919567791515',
      Body: 'Your Chase card ending in 1234 was charged $45.23 at WALMART on 05/24/2026',
      NumMedia: '0',
    };
    const res = await handler(buildRequest(params));
    const text = await res.text();
    expect(text).toContain('Transaction found');
    expect(text).toContain('WALMART');
    expect(text).toContain('Grocery');
    expect(text).toContain('$45.23');
    expect(text).toContain('Reply YES to log');
  });

  it('asks for category on detected transfer (e.g. Zelle)', async () => {
    mockFetch.mockImplementation((url) => {
      if (url.includes('generativelanguage.googleapis.com')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            candidates: [{ content: { parts: [{ text: JSON.stringify({
              store_name: 'John Doe',
              purchase_date: '2026-05-24',
              total_amount: 50,
              currency: 'USD',
              reward_category: null,
              is_transfer: true,
            }) }] } }],
          }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    const params = {
      From: 'whatsapp:+919567791515',
      Body: 'Zelle payment of $50.00 to John Doe completed',
      NumMedia: '0',
    };
    const res = await handler(buildRequest(params));
    const text = await res.text();
    expect(text).toContain('Transfer detected');
    expect(text).toContain('John Doe');
    expect(text).toContain('What category');
    expect(mockStore.data.has(`transfer_pending:+919567791515:${[...mockStore.data.keys()].find(k => k.startsWith('transfer_pending:'))?.split(':')[2]}`)).toBeTruthy();
  });

  it('user picks a category to complete a transfer', async () => {
    const transferId = 'tx-pending-1';
    mockStore.data.set(`transfer_pending:+919567791515:${transferId}`, {
      id: transferId,
      phone: '+919567791515',
      extraction: {
        store_name: 'John Doe',
        purchase_date: '2026-05-24',
        total_amount: 50,
        currency: 'USD',
        reward_category: null,
        is_transfer: true,
      },
      year: 2026,
      month: 'May',
    });

    const params = { From: 'whatsapp:+919567791515', Body: 'Investment', NumMedia: '0' };
    const res = await handler(buildRequest(params));
    const text = await res.text();
    expect(text).toContain('Got it');
    expect(text).toContain('John Doe');
    expect(text).toContain('Investment');
    expect(text).toContain('Reply YES to log');
    expect(mockStore.data.has(`transfer_pending:+919567791515:${transferId}`)).toBe(false);
    expect(mockStore.data.has(`confirm:+919567791515:${transferId}`)).toBe(true);
  });

  it('converts foreign currency and shows conversion in confirmation', async () => {
    mockFetch.mockImplementation((url) => {
      if (url.includes('generativelanguage.googleapis.com')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            candidates: [{ content: { parts: [{ text: JSON.stringify({
              store_name: 'Zara',
              purchase_date: '2026-05-24',
              total_amount: 1500,
              currency: 'INR',
              reward_category: 'Misc',
              is_transfer: false,
            }) }] } }],
          }),
        });
      }
      if (url.includes('open.er-api.com')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ rates: { INR: 83.5, EUR: 0.92, USD: 1 } }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    const params = {
      From: 'whatsapp:+919567791515',
      Body: 'Your card was charged ₹1500.00 at Zara on 05/24/2026',
      NumMedia: '0',
    };
    const res = await handler(buildRequest(params));
    const text = await res.text();
    expect(text).toContain('Zara');
    expect(text).toContain('Converted from INR 1500');
    // 1500 / 83.5 ≈ 17.96
    expect(text).toContain('$17.96');
  });

  it('ignores text without currency indicators', async () => {
    const params = { From: 'whatsapp:+919567791515', Body: 'hey how are you doing today', NumMedia: '0' };
    const res = await handler(buildRequest(params));
    const text = await res.text();
    expect(text).toContain('Send a receipt photo');
  });
});

describe('webhook handler — CANCEL clears transfer_pending', () => {
  it('cancels a pending transfer', async () => {
    mockStore.data.set('transfer_pending:+919567791515:transfer-99', {
      id: 'transfer-99',
      phone: '+919567791515',
      extraction: { store_name: 'X', total_amount: 10, is_transfer: true },
    });

    const params = { From: 'whatsapp:+919567791515', Body: 'CANCEL', NumMedia: '0' };
    const res = await handler(buildRequest(params));
    const text = await res.text();
    expect(text).toContain('Cancelled');
    expect(mockStore.data.has('transfer_pending:+919567791515:transfer-99')).toBe(false);
  });
});

describe('webhook handler — budget queries (J1)', () => {
  it('answers "? help" with help text', async () => {
    mockFetch.mockImplementation((url) => {
      if (url.includes('oauth2.googleapis.com/token')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ access_token: 'tok', expires_in: 3600 }) });
      }
      if (url.includes('Months')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ values: [[new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' }), 'sheet-may-id']] }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ values: [] }) });
    });

    const params = { From: 'whatsapp:+919567791515', Body: '? help', NumMedia: '0' };
    const res = await handler(buildRequest(params));
    const text = await res.text();
    expect(text).toContain('Ask a question');
    expect(text).toContain('budget');
  });

  it('answers "? total" with month totals', async () => {
    const monthName = new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' });
    mockFetch.mockImplementation((url) => {
      if (url.includes('oauth2.googleapis.com/token')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ access_token: 'tok', expires_in: 3600 }) });
      }
      if (url.includes('Months')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ values: [[monthName, 'sheet-may-id']] }) });
      }
      if (url.includes('Totals')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ values: [
          ['Grocery', 200, 100, null, null, null, null],
          ['Eating Out', 50, 150, null, null, null, null],
          [null, null, null, null, null, 'Salary received', 5000],
        ] }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    const params = { From: 'whatsapp:+919567791515', Body: '? total', NumMedia: '0' };
    const res = await handler(buildRequest(params));
    const text = await res.text();
    expect(text).toContain('Total spent: $250');
    expect(text).toContain('Salary: $5000');
  });

  it('answers "? budget" with remaining per category', async () => {
    const monthName = new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' });
    mockFetch.mockImplementation((url) => {
      if (url.includes('oauth2.googleapis.com/token')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ access_token: 'tok', expires_in: 3600 }) });
      }
      if (url.includes('Months')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ values: [[monthName, 'sheet-may-id']] }) });
      }
      if (url.includes('Totals')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ values: [
          ['Grocery', 200, 100, null, null, null, null],
          ['Eating Out', 50, 150, null, null, null, null],
        ] }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    const params = { From: 'whatsapp:+919567791515', Body: '? budget', NumMedia: '0' };
    const res = await handler(buildRequest(params));
    const text = await res.text();
    expect(text).toContain('Budget remaining');
    expect(text).toContain('Grocery');
    expect(text).toContain('Eating Out');
  });

  it('answers "? Grocery" with single category status', async () => {
    const monthName = new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' });
    mockFetch.mockImplementation((url) => {
      if (url.includes('oauth2.googleapis.com/token')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ access_token: 'tok', expires_in: 3600 }) });
      }
      if (url.includes('Months')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ values: [[monthName, 'sheet-may-id']] }) });
      }
      if (url.includes('Totals')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ values: [
          ['Grocery', 200, 100, null, null, null, null],
        ] }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    const params = { From: 'whatsapp:+919567791515', Body: '? Grocery', NumMedia: '0' };
    const res = await handler(buildRequest(params));
    const text = await res.text();
    expect(text).toContain('Grocery');
    expect(text).toContain('Spent: $200');
    expect(text).toContain('Budget: $300');
    expect(text).toContain('Remaining: $100');
  });

  it('answers "? top" with top spending categories', async () => {
    const monthName = new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' });
    mockFetch.mockImplementation((url) => {
      if (url.includes('oauth2.googleapis.com/token')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ access_token: 'tok', expires_in: 3600 }) });
      }
      if (url.includes('Months')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ values: [[monthName, 'sheet-may-id']] }) });
      }
      if (url.includes('Totals')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ values: [
          ['Grocery', 200, 100, null, null, null, null],
          ['Eating Out', 80, 20, null, null, null, null],
          ['Misc', 30, 70, null, null, null, null],
        ] }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    const params = { From: 'whatsapp:+919567791515', Body: '? top', NumMedia: '0' };
    const res = await handler(buildRequest(params));
    const text = await res.text();
    expect(text).toContain('Top');
    expect(text).toContain('Grocery');
    expect(text).toContain('$200');
  });

  it('falls back to Claude for natural-language questions', async () => {
    const monthName = new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' });
    mockFetch.mockImplementation((url) => {
      if (url.includes('oauth2.googleapis.com/token')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ access_token: 'tok', expires_in: 3600 }) });
      }
      if (url.includes('Months')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ values: [[monthName, 'sheet-may-id']] }) });
      }
      if (url.includes('Totals')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ values: [
          ['Grocery', 200, 100, null, null, null, null],
        ] }) });
      }
      if (url.includes('History')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ values: [] }) });
      }
      if (url.includes('api.anthropic.com')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            content: [{ type: 'text', text: 'You spent $200 on Grocery this month.' }],
          }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    const params = { From: 'whatsapp:+919567791515', Body: 'how much did I spend on grocery?', NumMedia: '0' };
    const res = await handler(buildRequest(params));
    const text = await res.text();
    expect(text).toContain('Grocery');
    expect(text).toContain('$200');
  });
});

describe('webhook handler — NEW MONTH wizard', () => {
  const phone = '+919567791515';
  const monthName = 'June 2026';

  function mockSheetsForNewMonth({ monthExists = false, prevSalary = 5000, prevBudgets = null, userSettings = {} } = {}) {
    const defaultBudgets = [
      ['Grocery', 200, 200, null, null, null, null],
      ['Misc', 50, 50, null, null, null, null],
    ];
    const budgetRows = prevBudgets || defaultBudgets;

    mockFetch.mockImplementation((url, opts) => {
      if (url.includes('oauth2.googleapis.com/token')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ access_token: 'tok', expires_in: 3600 }) });
      }
      // Months registry lookup
      if (url.includes('Months') && !opts?.method) {
        if (monthExists) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ values: [['June 2026', 'sheet-jun']] }) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ values: [['May 2026', 'sheet-may']] }) });
      }
      // Totals (for previous month data and new sheet creation)
      if (url.includes('Totals') && !opts?.method) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ values: [
          ...budgetRows,
          [null, null, null, null, null, 'Salary Received', prevSalary],
        ] }) });
      }
      // UserSettings
      if (url.includes('UserSettings')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({
          values: [['nair.sabarish97@gmail.com', JSON.stringify(userSettings)]],
        }) });
      }
      // Drive copy (createMonth)
      if (url.includes('/copy')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ id: 'new-sheet-id' }) });
      }
      // Sheet metadata for deleteMonthsTab
      if (url.includes('fields=sheets.properties')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({
          sheets: [{ properties: { title: 'Months', sheetId: 99 } }, { properties: { title: 'Totals', sheetId: 1 } }],
        }) });
      }
      // Default: succeed for any write operation
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ values: [] }) });
    });
  }

  it('rejects invalid month format', async () => {
    const params = { From: `whatsapp:${phone}`, Body: 'NEW MONTH blah', NumMedia: '0' };
    const res = await handler(buildRequest(params));
    const text = await res.text();
    expect(text).toContain('Invalid month format');
  });

  it('rejects already-existing month', async () => {
    mockSheetsForNewMonth({ monthExists: true });
    const params = { From: `whatsapp:${phone}`, Body: 'NEW MONTH June 2026', NumMedia: '0' };
    const res = await handler(buildRequest(params));
    const text = await res.text();
    expect(text).toContain('already exists');
  });

  it('starts wizard and asks for salary', async () => {
    mockSheetsForNewMonth();
    const params = { From: `whatsapp:${phone}`, Body: 'NEW MONTH June 2026', NumMedia: '0' };
    const res = await handler(buildRequest(params));
    const text = await res.text();
    expect(text).toContain('Creating June 2026');
    expect(text).toContain('Previous salary: $5000');
    expect(text).toContain('SAME');
    expect(mockStore.data.has(`new_month_wizard:${phone}`)).toBe(true);
  });

  it('stage 1: SAME keeps previous salary and shows budgets', async () => {
    mockSheetsForNewMonth();
    // Start wizard
    await handler(buildRequest({ From: `whatsapp:${phone}`, Body: 'NEW MONTH June 2026', NumMedia: '0' }));

    // Reply SAME for salary
    const res = await handler(buildRequest({ From: `whatsapp:${phone}`, Body: 'SAME', NumMedia: '0' }));
    const text = await res.text();
    expect(text).toContain('Salary: $5000');
    expect(text).toContain('Grocery');
    expect(text).toContain('Misc');
    expect(text).toContain('DONE');

    const wizard = mockStore.data.get(`new_month_wizard:${phone}`);
    expect(wizard.stage).toBe(2);
    expect(wizard.salary).toBe(5000);
  });

  it('stage 1: numeric input sets salary', async () => {
    mockSheetsForNewMonth();
    await handler(buildRequest({ From: `whatsapp:${phone}`, Body: 'NEW MONTH June 2026', NumMedia: '0' }));

    const res = await handler(buildRequest({ From: `whatsapp:${phone}`, Body: '6000', NumMedia: '0' }));
    const text = await res.text();
    expect(text).toContain('Salary: $6000');

    const wizard = mockStore.data.get(`new_month_wizard:${phone}`);
    expect(wizard.salary).toBe(6000);
  });

  it('stage 2: budget change is recorded', async () => {
    mockSheetsForNewMonth();
    await handler(buildRequest({ From: `whatsapp:${phone}`, Body: 'NEW MONTH June 2026', NumMedia: '0' }));
    await handler(buildRequest({ From: `whatsapp:${phone}`, Body: 'SAME', NumMedia: '0' }));

    const res = await handler(buildRequest({ From: `whatsapp:${phone}`, Body: 'Grocery 500', NumMedia: '0' }));
    const text = await res.text();
    expect(text).toContain('Grocery');
    expect(text).toContain('$500');

    const wizard = mockStore.data.get(`new_month_wizard:${phone}`);
    expect(wizard.budgetChanges['Grocery']).toBe(500);
  });

  it('stage 2: DONE shows summary with YES prompt', async () => {
    mockSheetsForNewMonth();
    await handler(buildRequest({ From: `whatsapp:${phone}`, Body: 'NEW MONTH June 2026', NumMedia: '0' }));
    await handler(buildRequest({ From: `whatsapp:${phone}`, Body: 'SAME', NumMedia: '0' }));

    const res = await handler(buildRequest({ From: `whatsapp:${phone}`, Body: 'DONE', NumMedia: '0' }));
    const text = await res.text();
    expect(text).toContain('New month: June 2026');
    expect(text).toContain('Salary: $5000');
    expect(text).toContain('Grocery');
    expect(text).toContain('Reply YES');

    const wizard = mockStore.data.get(`new_month_wizard:${phone}`);
    expect(wizard.stage).toBe(3);
  });

  it('stage 3: YES creates the month', async () => {
    mockSheetsForNewMonth();
    await handler(buildRequest({ From: `whatsapp:${phone}`, Body: 'NEW MONTH June 2026', NumMedia: '0' }));
    await handler(buildRequest({ From: `whatsapp:${phone}`, Body: 'SAME', NumMedia: '0' }));
    await handler(buildRequest({ From: `whatsapp:${phone}`, Body: 'DONE', NumMedia: '0' }));

    const res = await handler(buildRequest({ From: `whatsapp:${phone}`, Body: 'YES', NumMedia: '0' }));
    const text = await res.text();
    expect(text).toContain('June 2026 created');
    expect(text).toContain('Salary: $5000');
    expect(mockStore.data.has(`new_month_wizard:${phone}`)).toBe(false);
  });

  it('stage 4: recurring expenses YES logs them', async () => {
    mockSheetsForNewMonth({
      userSettings: { recurringExpenses: [{ category: 'Misc', vendor: 'Netflix', amount: 15.99 }] },
    });
    await handler(buildRequest({ From: `whatsapp:${phone}`, Body: 'NEW MONTH June 2026', NumMedia: '0' }));
    await handler(buildRequest({ From: `whatsapp:${phone}`, Body: 'SAME', NumMedia: '0' }));
    await handler(buildRequest({ From: `whatsapp:${phone}`, Body: 'DONE', NumMedia: '0' }));
    // YES at stage 3 creates, then shows recurring
    const res3 = await handler(buildRequest({ From: `whatsapp:${phone}`, Body: 'YES', NumMedia: '0' }));
    const text3 = await res3.text();
    expect(text3).toContain('Recurring expenses');
    expect(text3).toContain('Netflix');
    expect(mockStore.data.get(`new_month_wizard:${phone}`).stage).toBe(4);

    // YES at stage 4 logs recurring
    const res4 = await handler(buildRequest({ From: `whatsapp:${phone}`, Body: 'YES', NumMedia: '0' }));
    const text4 = await res4.text();
    expect(text4).toContain('1 recurring expense');
    expect(mockStore.data.has(`new_month_wizard:${phone}`)).toBe(false);
  });

  it('stage 4: SKIP skips recurring', async () => {
    mockSheetsForNewMonth({
      userSettings: { recurringExpenses: [{ category: 'Misc', vendor: 'Netflix', amount: 15.99 }] },
    });
    await handler(buildRequest({ From: `whatsapp:${phone}`, Body: 'NEW MONTH June 2026', NumMedia: '0' }));
    await handler(buildRequest({ From: `whatsapp:${phone}`, Body: 'SAME', NumMedia: '0' }));
    await handler(buildRequest({ From: `whatsapp:${phone}`, Body: 'DONE', NumMedia: '0' }));
    await handler(buildRequest({ From: `whatsapp:${phone}`, Body: 'YES', NumMedia: '0' }));

    const res = await handler(buildRequest({ From: `whatsapp:${phone}`, Body: 'SKIP', NumMedia: '0' }));
    const text = await res.text();
    expect(text).toContain('skipped');
    expect(mockStore.data.has(`new_month_wizard:${phone}`)).toBe(false);
  });

  it('CANCEL clears wizard state', async () => {
    mockSheetsForNewMonth();
    await handler(buildRequest({ From: `whatsapp:${phone}`, Body: 'NEW MONTH June 2026', NumMedia: '0' }));
    expect(mockStore.data.has(`new_month_wizard:${phone}`)).toBe(true);

    const res = await handler(buildRequest({ From: `whatsapp:${phone}`, Body: 'CANCEL', NumMedia: '0' }));
    const text = await res.text();
    expect(text).toContain('Cancelled');
    expect(mockStore.data.has(`new_month_wizard:${phone}`)).toBe(false);
  });
});

describe('webhook handler — DELETE (3-layer security)', () => {
  const phone = '+919567791515';
  const monthName = new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' });

  function mockSheetsForDelete() {
    mockFetch.mockImplementation((url, opts) => {
      if (url.includes('oauth2.googleapis.com/token')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ access_token: 'tok', expires_in: 3600 }) });
      }
      if (url.includes('Months')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ values: [[monthName, 'sheet-cur']] }) });
      }
      if (url.includes('History')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ values: [
          ['Header', 'Action', 'Category', 'Vendor', 'Amount', 'Details', 'UUID', 'Source'],
          ['2026-05-25T10:00:00Z', 'WhatsApp Receipt', 'Grocery', 'Walmart', 45.23, 'Receipt via WhatsApp', 'tx_4523_abc1', 'whatsapp-bot'],
          ['2026-05-24T09:00:00Z', 'WhatsApp Receipt', 'Misc', 'Target', 22.50, 'Receipt via WhatsApp', 'tx_2250_def2', 'whatsapp-bot'],
        ] }) });
      }
      if (url.includes('fields=sheets.properties')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({
          sheets: [{ properties: { title: 'Grocery', sheetId: 10 } }],
        }) });
      }
      if (url.includes('Grocery') && (url.includes('F:F') || url.includes('F%3AF'))) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ values: [
          ['UUID'], ['tx_4523_abc1'],
        ] }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });
  }

  it('DELETE shows recent expenses list', async () => {
    mockSheetsForDelete();
    const res = await handler(buildRequest({ From: `whatsapp:${phone}`, Body: 'DELETE', NumMedia: '0' }));
    const text = await res.text();
    expect(text).toContain('#1');
    expect(text).toContain('Walmart');
    expect(text).toContain('$45.23');
    expect(text).toContain('DELETE #N');
  });

  it('DELETE last starts 3-layer flow from lastlog', async () => {
    mockSheetsForDelete();
    mockStore.data.set(`lastlog:${phone}`, {
      uuid: 'tx_4523_abc1', category: 'Grocery', vendor: 'Walmart',
      amount: 45.23, sheetId: 'sheet-cur', loggedAt: new Date().toISOString(),
    });

    const res = await handler(buildRequest({ From: `whatsapp:${phone}`, Body: 'DELETE last', NumMedia: '0' }));
    const text = await res.text();
    expect(text).toContain('Delete this expense');
    expect(text).toContain('Walmart');
    expect(text).toContain('$45.23');
    expect(text).toContain('CONFIRM DELETE');

    const pending = mockStore.data.get(`delete_pending:${phone}`);
    expect(pending.stage).toBe(1);
    expect(pending.target.uuid).toBe('tx_4523_abc1');
  });

  it('DELETE #1 targets first recent expense', async () => {
    mockSheetsForDelete();
    const res = await handler(buildRequest({ From: `whatsapp:${phone}`, Body: 'DELETE #1', NumMedia: '0' }));
    const text = await res.text();
    expect(text).toContain('Delete this expense');
    expect(text).toContain('Target');
    expect(text).toContain('$22.50');
  });

  it('Layer 2: rejects wrong phrase', async () => {
    mockSheetsForDelete();
    mockStore.data.set(`delete_pending:${phone}`, {
      stage: 1,
      target: { category: 'Grocery', vendor: 'Walmart', amount: 45.23, uuid: 'tx_4523_abc1' },
      sheetId: 'sheet-cur', monthName,
      expires: new Date(Date.now() + 600000).toISOString(),
    });

    const res = await handler(buildRequest({ From: `whatsapp:${phone}`, Body: 'YES', NumMedia: '0' }));
    const text = await res.text();
    expect(text).toContain('CONFIRM DELETE');
    expect(mockStore.data.get(`delete_pending:${phone}`).stage).toBe(1);
  });

  it('Layer 2: CONFIRM DELETE advances to amount echo', async () => {
    mockSheetsForDelete();
    mockStore.data.set(`delete_pending:${phone}`, {
      stage: 1,
      target: { category: 'Grocery', vendor: 'Walmart', amount: 45.23, uuid: 'tx_4523_abc1' },
      sheetId: 'sheet-cur', monthName,
      expires: new Date(Date.now() + 600000).toISOString(),
    });

    const res = await handler(buildRequest({ From: `whatsapp:${phone}`, Body: 'CONFIRM DELETE', NumMedia: '0' }));
    const text = await res.text();
    expect(text).toContain('Final verification');
    expect(text).toContain('$45.23');
    expect(mockStore.data.get(`delete_pending:${phone}`).stage).toBe(2);
  });

  it('Layer 3: rejects wrong amount', async () => {
    mockSheetsForDelete();
    mockStore.data.set(`delete_pending:${phone}`, {
      stage: 2,
      target: { category: 'Grocery', vendor: 'Walmart', amount: 45.23, uuid: 'tx_4523_abc1' },
      sheetId: 'sheet-cur', monthName,
      expires: new Date(Date.now() + 600000).toISOString(),
    });

    const res = await handler(buildRequest({ From: `whatsapp:${phone}`, Body: '99.99', NumMedia: '0' }));
    const text = await res.text();
    expect(text).toContain("doesn't match");
  });

  it('Layer 3: correct amount deletes the expense', async () => {
    mockSheetsForDelete();
    mockStore.data.set(`delete_pending:${phone}`, {
      stage: 2,
      target: { category: 'Grocery', vendor: 'Walmart', amount: 45.23, uuid: 'tx_4523_abc1' },
      sheetId: 'sheet-cur', monthName,
      expires: new Date(Date.now() + 600000).toISOString(),
    });

    const res = await handler(buildRequest({ From: `whatsapp:${phone}`, Body: '45.23', NumMedia: '0' }));
    const text = await res.text();
    expect(text).toContain('Deleted');
    expect(text).toContain('Walmart');
    expect(text).toContain('$45.23');
    expect(mockStore.data.has(`delete_pending:${phone}`)).toBe(false);
  });

  it('Layer 3: accepts dollar-sign prefix', async () => {
    mockSheetsForDelete();
    mockStore.data.set(`delete_pending:${phone}`, {
      stage: 2,
      target: { category: 'Grocery', vendor: 'Walmart', amount: 45.23, uuid: 'tx_4523_abc1' },
      sheetId: 'sheet-cur', monthName,
      expires: new Date(Date.now() + 600000).toISOString(),
    });

    const res = await handler(buildRequest({ From: `whatsapp:${phone}`, Body: '$45.23', NumMedia: '0' }));
    const text = await res.text();
    expect(text).toContain('Deleted');
  });

  it('CANCEL clears delete pending', async () => {
    mockStore.data.set(`delete_pending:${phone}`, {
      stage: 1,
      target: { category: 'Grocery', vendor: 'Walmart', amount: 45.23, uuid: 'tx_4523_abc1' },
      sheetId: 'sheet-cur', monthName,
      expires: new Date(Date.now() + 600000).toISOString(),
    });

    const res = await handler(buildRequest({ From: `whatsapp:${phone}`, Body: 'CANCEL', NumMedia: '0' }));
    const text = await res.text();
    expect(text).toContain('Cancelled');
    expect(mockStore.data.has(`delete_pending:${phone}`)).toBe(false);
  });

  it('full 3-layer flow end-to-end', async () => {
    mockSheetsForDelete();
    mockStore.data.set(`lastlog:${phone}`, {
      uuid: 'tx_4523_abc1', category: 'Grocery', vendor: 'Walmart',
      amount: 45.23, sheetId: 'sheet-cur', loggedAt: new Date().toISOString(),
    });

    // Layer 1: intent
    await handler(buildRequest({ From: `whatsapp:${phone}`, Body: 'DELETE last', NumMedia: '0' }));
    expect(mockStore.data.get(`delete_pending:${phone}`).stage).toBe(1);

    // Layer 2: CONFIRM DELETE
    await handler(buildRequest({ From: `whatsapp:${phone}`, Body: 'CONFIRM DELETE', NumMedia: '0' }));
    expect(mockStore.data.get(`delete_pending:${phone}`).stage).toBe(2);

    // Layer 3: amount echo
    const res = await handler(buildRequest({ From: `whatsapp:${phone}`, Body: '45.23', NumMedia: '0' }));
    const text = await res.text();
    expect(text).toContain('Deleted');
    expect(mockStore.data.has(`delete_pending:${phone}`)).toBe(false);
    expect(mockStore.data.has(`lastlog:${phone}`)).toBe(false);
  });

  it('expired delete pending is cleared', async () => {
    mockSheetsForDelete();
    mockStore.data.set(`delete_pending:${phone}`, {
      stage: 1,
      target: { category: 'Grocery', vendor: 'Walmart', amount: 45.23, uuid: 'tx_4523_abc1' },
      sheetId: 'sheet-cur', monthName,
      expires: new Date(Date.now() - 1000).toISOString(),
    });

    // Expired delete should be ignored, text falls through to help
    const res = await handler(buildRequest({ From: `whatsapp:${phone}`, Body: 'CONFIRM DELETE', NumMedia: '0' }));
    const text = await res.text();
    expect(text).toContain('Send a receipt photo');
    expect(mockStore.data.has(`delete_pending:${phone}`)).toBe(false);
  });
});

describe('webhook handler — GUIDE command', () => {
  it('GUIDE returns full command reference', async () => {
    const res = await handler(buildRequest({ From: 'whatsapp:+919567791515', Body: 'GUIDE', NumMedia: '0' }));
    const text = await res.text();
    expect(text).toContain('BUDGET BOT GUIDE');
    expect(text).toContain('LOG EXPENSES');
    expect(text).toContain('SET SALARY');
    expect(text).toContain('NEW MONTH');
    expect(text).toContain('DELETE');
    expect(text).toContain('UNDO');
    expect(text).toContain('QUERIES');
    expect(text).toContain('Categories:');
  });

  it('HELP also returns the guide', async () => {
    const res = await handler(buildRequest({ From: 'whatsapp:+919567791515', Body: 'help', NumMedia: '0' }));
    const text = await res.text();
    expect(text).toContain('BUDGET BOT GUIDE');
  });

  it('guide is case-insensitive', async () => {
    const res = await handler(buildRequest({ From: 'whatsapp:+919567791515', Body: 'Guide', NumMedia: '0' }));
    const text = await res.text();
    expect(text).toContain('BUDGET BOT GUIDE');
  });
});

describe('webhook handler — generic text messages', () => {
  it('shows short help with GUIDE hint for unrecognized text', async () => {
    const params = { From: 'whatsapp:+919567791515', Body: 'hello there', NumMedia: '0' };
    const res = await handler(buildRequest(params));
    const text = await res.text();
    expect(text).toContain('Send a receipt photo');
    expect(text).toContain('GUIDE');
  });

  it('returns empty TwiML for empty body', async () => {
    const params = { From: 'whatsapp:+919567791515', Body: '', NumMedia: '0' };
    const res = await handler(buildRequest(params));
    const text = await res.text();
    expect(text).toContain('<Response></Response>');
  });
});
