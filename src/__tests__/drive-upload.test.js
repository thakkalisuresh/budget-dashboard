import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

vi.stubEnv('GOOGLE_CLIENT_ID', 'test-client-id');
vi.stubEnv('GOOGLE_CLIENT_SECRET', 'test-secret');
vi.stubEnv('GOOGLE_DRIVE_REFRESH_TOKEN', 'test-refresh-token');

const mockFetch = vi.fn();
global.fetch = mockFetch;

let getAccessToken, findOrCreateFolder, buildFolderPath, uploadFile;

beforeAll(async () => {
  ({ getAccessToken, findOrCreateFolder, buildFolderPath, uploadFile } = await import('../../functions/lib/_drive.mjs'));
});

beforeEach(() => {
  vi.clearAllMocks();
});

function jsonResponse(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(data) };
}

function mockTokenThenApi(...apiResponses) {
  mockFetch.mockImplementation((url) => {
    if (url === 'https://oauth2.googleapis.com/token') {
      return Promise.resolve(jsonResponse({ access_token: 'test-token', expires_in: 3600 }));
    }
    const response = apiResponses.shift();
    return Promise.resolve(response || jsonResponse({}, 500));
  });
}

describe('getAccessToken', () => {
  it('exchanges refresh token for access token', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ access_token: 'test-token', expires_in: 3600 }));
    const token = await getAccessToken();
    expect(token).toBe('test-token');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://oauth2.googleapis.com/token',
      expect.objectContaining({ method: 'POST' })
    );
    const body = mockFetch.mock.calls[0][1].body;
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('client_id')).toBe('test-client-id');
  });

  it('returns cached token on subsequent calls within TTL', async () => {
    const token = await getAccessToken();
    expect(token).toBe('test-token');
  });
});

describe('findOrCreateFolder', () => {
  it('returns existing folder ID when found', async () => {
    mockTokenThenApi(
      jsonResponse({ files: [{ id: 'folder-123', name: 'Receipts' }] })
    );
    const id = await findOrCreateFolder('Receipts', null);
    expect(id).toBe('folder-123');
  });

  it('creates folder when not found', async () => {
    mockTokenThenApi(
      jsonResponse({ files: [] }),
      jsonResponse({ id: 'new-folder-456', name: 'Receipts' })
    );
    const id = await findOrCreateFolder('Receipts', null);
    expect(id).toBe('new-folder-456');
  });

  it('includes parent ID in query and create body', async () => {
    mockTokenThenApi(
      jsonResponse({ files: [] }),
      jsonResponse({ id: 'child-folder', name: '2026' })
    );
    await findOrCreateFolder('2026', 'parent-root-id');

    const calls = mockFetch.mock.calls.filter(c => c[0] !== 'https://oauth2.googleapis.com/token');
    const searchUrl = calls[0][0];
    expect(decodeURIComponent(searchUrl)).toContain("'parent-root-id' in parents");
    const createBody = JSON.parse(calls[1][1].body);
    expect(createBody.parents).toEqual(['parent-root-id']);
  });
});

describe('buildFolderPath', () => {
  it('creates nested structure Receipts/year/month/category', async () => {
    mockTokenThenApi(
      jsonResponse({ files: [{ id: 'root-id' }] }),
      jsonResponse({ files: [{ id: 'year-id' }] }),
      jsonResponse({ files: [] }),
      jsonResponse({ id: 'month-id' }),
      jsonResponse({ files: [] }),
      jsonResponse({ id: 'cat-id' })
    );
    const result = await buildFolderPath(2026, 'May', 'Grocery');
    expect(result.folderId).toBe('cat-id');
  });

  it('returns month folder when no category', async () => {
    mockTokenThenApi(
      jsonResponse({ files: [{ id: 'root-id' }] }),
      jsonResponse({ files: [{ id: 'year-id' }] }),
      jsonResponse({ files: [{ id: 'month-id' }] })
    );
    const result = await buildFolderPath(2026, 'May', null);
    expect(result.folderId).toBe('month-id');
  });
});

describe('uploadFile', () => {
  it('sends multipart upload with metadata and content', async () => {
    mockTokenThenApi(
      jsonResponse({ id: 'file-789', webViewLink: 'https://drive.google.com/file/d/file-789/view' })
    );
    const result = await uploadFile('folder-abc', 'receipt.jpg', 'image/jpeg', 'aGVsbG8=');
    expect(result.id).toBe('file-789');
    expect(result.webViewLink).toContain('file-789');

    const calls = mockFetch.mock.calls.filter(c => c[0] !== 'https://oauth2.googleapis.com/token');
    const uploadCall = calls[0];
    expect(uploadCall[0]).toContain('uploadType=multipart');
    expect(uploadCall[1].headers['Content-Type']).toContain('multipart/related');
    expect(uploadCall[1].body).toContain('"name":"receipt.jpg"');
    expect(uploadCall[1].body).toContain('"parents":["folder-abc"]');
  });
});
