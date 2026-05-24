import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';

vi.stubEnv('TWILIO_AUTH_TOKEN', 'test-auth-token');
vi.stubEnv('TWILIO_ACCOUNT_SID', 'ACtest123');
vi.stubEnv('WHATSAPP_ALLOWED_PHONES', '+919567791515,+18285107202');
vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
vi.stubEnv('GOOGLE_CLIENT_ID', 'test-client-id');
vi.stubEnv('GOOGLE_CLIENT_SECRET', 'test-secret');
vi.stubEnv('GOOGLE_DRIVE_REFRESH_TOKEN', 'test-refresh');
vi.stubEnv('VITE_TEMPLATE_SHEET_ID', 'template-id');
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
      if (url.includes('api.anthropic.com')) {
        if (extractionResult === 'fail') {
          return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: { message: 'fail' } }) });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            content: [{ type: 'text', text: JSON.stringify(extractionResult) }],
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
    expect(text).toContain('test-dashboard.netlify.app');
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
    expect(text).toContain('cancelled');
    expect(mockStore.data.has('confirm:+919567791515:receipt-xyz')).toBe(false);
  });

  it('handles YES with no pending receipt', async () => {
    const params = { From: 'whatsapp:+919567791515', Body: 'YES', NumMedia: '0' };
    const res = await handler(buildRequest(params));
    const text = await res.text();
    expect(text).toContain('No pending receipt');
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
    expect(text).toContain('Send a receipt image');
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

describe('webhook handler — generic text messages', () => {
  it('shows help for unrecognized text', async () => {
    const params = { From: 'whatsapp:+919567791515', Body: 'hello there', NumMedia: '0' };
    const res = await handler(buildRequest(params));
    const text = await res.text();
    expect(text).toContain('Send a receipt image');
  });

  it('returns empty TwiML for empty body', async () => {
    const params = { From: 'whatsapp:+919567791515', Body: '', NumMedia: '0' };
    const res = await handler(buildRequest(params));
    const text = await res.text();
    expect(text).toContain('<Response></Response>');
  });
});
