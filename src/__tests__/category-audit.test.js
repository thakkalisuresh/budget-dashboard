import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { sheetIdMock, recentMock, settingsMock, sendMock } = vi.hoisted(() => ({
  sheetIdMock: vi.fn(),
  recentMock: vi.fn(),
  settingsMock: vi.fn(),
  sendMock: vi.fn(async () => ({ ok: true })),
}));

vi.mock('../../functions/lib/_sheets.mjs', () => ({
  getCurrentMonthSheetId: sheetIdMock,
  getRecentExpenses: recentMock,
  getUserSettings: settingsMock,
}));
vi.mock('../../functions/lib/_telegram.mjs', () => ({
  sendMessage: sendMock,
  resolveTelegramChatId: (email) => (email === 'me@example.com' ? '111222333' : null),
}));
vi.mock('../../functions/lib/_extraction.mjs', () => ({
  CATEGORIES: ['Grocery', 'Eating Out', 'Misc', 'Travel', 'Entertainment', 'Health'],
}));
// The scheduler wrapper isn't under test; stub it so importing the module
// doesn't try to register a real Cloud Scheduler job.
vi.mock('firebase-functions/v2/scheduler', () => ({ onSchedule: (_opts, fn) => fn }));
vi.mock('../../functions/lib/secrets.mjs', () => ({
  GROQ_API_KEY: 'k', TELEGRAM_BOT_TOKEN: 'k', TELEGRAM_EMAIL_MAP: 'k', SHEETS_DRIVE_SECRETS: [],
}));

const { runCategoryAudit } = await import('../../functions/category-audit.mjs');

const mockFetch = vi.fn();

/**
 * Groq answers keyed by the vendor in the request body. Keyed rather than
 * call-ordered because the audit deliberately shuffles its sample, so call
 * order is not stable. `_` is the fallback for any vendor not listed.
 */
function groqAnswers(byVendor) {
  mockFetch.mockImplementation((_url, opts) => {
    const body = JSON.parse(opts.body);
    const prompt = body.messages.map(m => m.content).join('\n');
    const key = Object.keys(byVendor).find(k => k !== '_' && prompt.includes(k));
    const a = byVendor[key] ?? byVendor._;
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify(a) } }] }),
    });
  });
}

const expense = (vendor, category, amount, uuid) => ({ vendor, category, amount, uuid, txDate: '2026-05-10' });

beforeEach(() => {
  vi.clearAllMocks();
  global.fetch = mockFetch;
  vi.stubEnv('GROQ_API_KEY', 'test-groq-key');
  sheetIdMock.mockResolvedValue('sheet-may');
  settingsMock.mockResolvedValue({});
  recentMock.mockResolvedValue([]);
  sendMock.mockResolvedValue({ ok: true });
});

afterEach(() => vi.unstubAllEnvs());

describe('runCategoryAudit', () => {
  it('flags a confident disagreement and sends one digest', async () => {
    recentMock.mockResolvedValue([
      expense('Chipotle', 'Misc', 24.5, 'tx_1'),
      expense('Shell', 'Travel', 40, 'tx_2'),
    ]);
    groqAnswers({
      Chipotle: { category: 'Eating Out', confidence: 0.95 },  // disagrees, confident
      Shell:    { category: 'Travel',     confidence: 0.99 },  // agrees with what's logged
    });

    const out = await runCategoryAudit({ email: 'me@example.com' });

    expect(out.flagged).toBe(1);
    expect(sendMock).toHaveBeenCalledOnce();          // ONE digest, not one per suspect
    const [, text, keyboard] = sendMock.mock.calls[0];
    expect(text).toContain('Chipotle');
    expect(text).toContain('Misc → Eating Out');
    expect(text).not.toContain('Shell');
    expect(keyboard[0][0].callback_data).toBe('AUDITFIX:tx_1:Eating Out');
  });

  it('stays quiet when nothing is suspicious', async () => {
    recentMock.mockResolvedValue([expense('Chipotle', 'Eating Out', 24.5, 'tx_1')]);
    groqAnswers({ _: { category: 'Eating Out', confidence: 0.99 } });

    const out = await runCategoryAudit({ email: 'me@example.com' });
    expect(out.flagged).toBe(0);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('ignores a low-confidence disagreement', async () => {
    // The weekly bar is higher than the add-path bar — a digest that cries
    // wolf gets ignored entirely.
    recentMock.mockResolvedValue([expense('Chipotle', 'Misc', 24.5, 'tx_1')]);
    groqAnswers({ _: { category: 'Eating Out', confidence: 0.6 } });

    const out = await runCategoryAudit({ email: 'me@example.com' });
    expect(out.flagged).toBe(0);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('never second-guesses a vendor the user wrote a smart rule for', async () => {
    settingsMock.mockResolvedValue({ smartRules: [{ pattern: 'chipotle', category: 'Misc' }] });
    recentMock.mockResolvedValue([expense('Chipotle', 'Misc', 24.5, 'tx_1')]);
    groqAnswers({ _: { category: 'Eating Out', confidence: 0.99 } });

    const out = await runCategoryAudit({ email: 'me@example.com' });
    expect(out.flagged).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();  // not even asked
  });

  it('does nothing when the feature is switched off', async () => {
    settingsMock.mockResolvedValue({ llmCategorize: false });
    recentMock.mockResolvedValue([expense('Chipotle', 'Misc', 24.5, 'tx_1')]);

    const out = await runCategoryAudit({ email: 'me@example.com' });
    expect(out.reason).toBe('disabled');
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('bails without a Telegram mapping instead of doing pointless work', async () => {
    const out = await runCategoryAudit({ email: 'stranger@example.com' });
    expect(out.reason).toBe('no_chat_id');
    expect(recentMock).not.toHaveBeenCalled();
  });

  it('bails when the month sheet is missing', async () => {
    sheetIdMock.mockRejectedValue(new Error('no sheet'));
    const out = await runCategoryAudit({ email: 'me@example.com' });
    expect(out.reason).toBe('no_sheet');
  });

  it('skips rows with no vendor or no uuid', async () => {
    recentMock.mockResolvedValue([
      { vendor: '', category: 'Misc', amount: 5, uuid: 'tx_1' },
      { vendor: 'Thing', category: 'Misc', amount: 5, uuid: '' },
    ]);
    groqAnswers({ _: { category: 'Eating Out', confidence: 0.99 } });

    const out = await runCategoryAudit({ email: 'me@example.com' });
    expect(out.checked).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('caps how many rows it checks in one run', async () => {
    // 40 candidates available, but only SAMPLE_SIZE (15) get an LLM call —
    // this is a scheduled job on a free tier, not a full re-scan.
    recentMock.mockResolvedValue(
      Array.from({ length: 40 }, (_, i) => expense(`V${i}`, 'Misc', 10, `tx_${i}`))
    );
    groqAnswers({ _: { category: 'Misc', confidence: 0.99 } });

    const out = await runCategoryAudit({ email: 'me@example.com' });
    expect(out.checked).toBe(15);
    expect(mockFetch).toHaveBeenCalledTimes(15);
  });

  it('survives Groq being down', async () => {
    recentMock.mockResolvedValue([expense('Chipotle', 'Misc', 24.5, 'tx_1')]);
    mockFetch.mockRejectedValue(new Error('groq down'));

    const out = await runCategoryAudit({ email: 'me@example.com' });
    expect(out.flagged).toBe(0);
    expect(sendMock).not.toHaveBeenCalled();
  });
});
