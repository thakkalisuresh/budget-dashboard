// saveTransactionNotes writes into the single UserSettings cell that holds
// EVERY user setting. Sheets caps a cell at 50,000 characters and nothing prunes
// notes, so the failure mode isn't "the note is missing" — it's "the save failed
// and took the user's categories, cards and budgets with it". These cover the
// guards that stop that, plus the merge semantics the web app depends on.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.stubEnv('VITE_TEMPLATE_SHEET_ID', 'template-id');
vi.stubEnv('ALLOWED_EMAILS', 'sabarish@example.com');
vi.stubEnv('TELEGRAM_EMAIL_MAP', 'sabarish@example.com:123456789,anu@example.com:987654321');

vi.mock('../../functions/lib/_drive.mjs', () => ({
  getAccessToken: vi.fn(() => Promise.resolve('token')),
  copyFile: vi.fn(),
  shareWithEmails: vi.fn(),
}));

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

const { saveTransactionNotes, __clearSheetCaches } = await import('../../functions/lib/_sheets.mjs');
const { resolveEmailByChatId } = await import('../../functions/lib/_telegram.mjs');

const NOTE = { note: '2 items: Bananas $2.99, Chicken $55.62', tags: ['split'] };

/** Serves the UserSettings A:B read, then captures the write. */
function mockSettingsRows(rows) {
  const writes = [];
  mockFetch.mockImplementation((url, opts) => {
    if (opts?.method === 'PUT') {
      writes.push({ url, body: JSON.parse(opts.body) });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ values: rows }) });
  });
  return writes;
}

beforeEach(() => {
  mockFetch.mockReset();
  __clearSheetCaches();
});

describe('saveTransactionNotes', () => {
  it('merges into the existing notes rather than replacing them', async () => {
    const existing = { currency: 'USD', transactionNotes: { 'old_key': { note: 'keep me', tags: [] } } };
    const writes = mockSettingsRows([['UserID', 'Settings'], ['sabarish@example.com', JSON.stringify(existing)]]);

    const res = await saveTransactionNotes({ 'new_key': NOTE }, 'sabarish@example.com');

    expect(res.saved).toBe(true);
    const saved = JSON.parse(writes[0].body.values[0][0]);
    expect(saved.transactionNotes.old_key.note).toBe('keep me');
    expect(saved.transactionNotes.new_key).toEqual(NOTE);
    // Unrelated settings must survive — they share the cell.
    expect(saved.currency).toBe('USD');
  });

  it('writes to the row matching the email, not the first row', async () => {
    const writes = mockSettingsRows([
      ['UserID', 'Settings'],
      ['sabarish@example.com', '{}'],
      ['anu@example.com', '{}'],
    ]);

    await saveTransactionNotes({ k: NOTE }, 'anu@example.com');

    // Row 3 (header + two users), 1-indexed in A1 notation.
    expect(decodeURIComponent(writes[0].url)).toContain("'UserSettings'!B3");
  });

  it('falls back to the household default when given no email', async () => {
    const writes = mockSettingsRows([['UserID', 'Settings'], ['sabarish@example.com', '{}']]);
    await saveTransactionNotes({ k: NOTE }, null);
    expect(decodeURIComponent(writes[0].url)).toContain("'UserSettings'!B2");
  });

  it('refuses to write past the cell cap instead of failing the whole blob', async () => {
    // A settings blob already near the ceiling: one more note would exceed it.
    const fat = { transactionNotes: Object.fromEntries(
      Array.from({ length: 900 }, (_, i) => [`key_${i}`, { note: 'x'.repeat(50), tags: ['split'] }]),
    ) };
    const writes = mockSettingsRows([['UserID', 'Settings'], ['sabarish@example.com', JSON.stringify(fat)]]);

    const res = await saveTransactionNotes({ 'one_more': NOTE }, 'sabarish@example.com');

    expect(res).toEqual({ saved: false, reason: 'would-exceed-cell-cap' });
    expect(writes).toHaveLength(0);
  });

  it('refuses to overwrite a cell it cannot parse', async () => {
    // Truncated JSON is likelier than genuinely-empty; clobbering it would lose
    // every setting the user has.
    const writes = mockSettingsRows([['UserID', 'Settings'], ['sabarish@example.com', '{"currency":"US']]);

    const res = await saveTransactionNotes({ k: NOTE }, 'sabarish@example.com');

    expect(res).toEqual({ saved: false, reason: 'unparseable' });
    expect(writes).toHaveLength(0);
  });

  it('skips a user who has no settings row', async () => {
    const writes = mockSettingsRows([['UserID', 'Settings'], ['someone@else.com', '{}']]);
    const res = await saveTransactionNotes({ k: NOTE }, 'ghost@example.com');
    expect(res).toEqual({ saved: false, reason: 'no-settings-row' });
    expect(writes).toHaveLength(0);
  });

  it('does nothing when there are no notes to write', async () => {
    const writes = mockSettingsRows([['UserID', 'Settings'], ['sabarish@example.com', '{}']]);
    expect(await saveTransactionNotes({}, 'sabarish@example.com')).toEqual({ saved: false, reason: 'empty' });
    expect(writes).toHaveLength(0);
  });
});

describe('resolveEmailByChatId', () => {
  it('maps a Telegram id back to its email so notes land on the right row', () => {
    expect(resolveEmailByChatId('987654321')).toBe('anu@example.com');
    expect(resolveEmailByChatId(123456789)).toBe('sabarish@example.com');
  });

  it('returns null for an unmapped or missing id', () => {
    expect(resolveEmailByChatId('555')).toBe(null);
    expect(resolveEmailByChatId(null)).toBe(null);
    expect(resolveEmailByChatId('')).toBe(null);
  });

  it('does not confuse an email fragment for an id', () => {
    expect(resolveEmailByChatId('anu@example.com')).toBe(null);
  });
});
