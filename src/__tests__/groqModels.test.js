// Groq retired llama-3.3-70b-versatile for this account (POST returns
// model_not_found). Every call that named it failed silently and fell back:
// categorization to the extractor (so the confirm path could never fire), text
// extraction / the agent / NL queries to Claude or Gemini. These tests pin the
// replacement ids, the reasoning-model request shape, and that a dead model is
// now reported instead of swallowed.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const reportError = vi.fn(() => Promise.resolve());
vi.mock('../../functions/lib/_error-log.mjs', () => ({ reportError: (...a) => reportError(...a) }));

vi.stubEnv('GROQ_API_KEY', 'gsk-test');
vi.stubEnv('GEMINI_API_KEY', 'gem-test');
vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');

const groq = await import('../../functions/lib/_groq.mjs');
const { categorizeWithGroq } = await import('../../functions/lib/_categorize.mjs');
const { extractTransactionText } = await import('../../functions/lib/_extraction.mjs');

const CATEGORIES = ['Grocery', 'Eating Out', 'Misc'];
const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

const ok = (message, extra = {}) => ({ ok: true, status: 200, json: () => Promise.resolve({ choices: [{ message, ...extra }] }) });
const fail = (status, message, code) => ({ ok: false, status, json: () => Promise.resolve({ error: { message, code } }) });
const modelGone = (model) => fail(404, `The model \`${model}\` does not exist or you do not have access to it.`, 'model_not_found');
const bodyOf = (i = 0) => JSON.parse(mockFetch.mock.calls[i][1].body);

beforeEach(() => {
  mockFetch.mockReset();
  reportError.mockClear();
  groq.__resetGroqReports();
});

describe('model constants', () => {
  it('no source file still names the retired model', () => {
    // _agent.mjs and _query.mjs still name it: they fall back to Claude and are a
    // separate follow-up (tool-calling behaviour needs its own testing).
    for (const f of ['_categorize', '_extraction']) {
      const src = readFileSync(fileURLToPath(new URL(`../../functions/lib/${f}.mjs`, import.meta.url)), 'utf8');
      expect(src, f).not.toMatch(/llama-3\.3-70b/);
    }
  });

  it('text and vision ids come from one place', () => {
    expect(groq.GROQ_TEXT_MODEL).toBe('openai/gpt-oss-120b');
    expect(groq.GROQ_VISION_MODEL).toBe('qwen/qwen3.8-27b');
  });
});

describe('categorizeWithGroq — request and response shape', () => {
  it('sends the shared text model with low reasoning effort and room for reasoning tokens', async () => {
    mockFetch.mockResolvedValue(ok({ content: '{"category":"Grocery","confidence":0.9}' }));
    const res = await categorizeWithGroq('Trader Joes', 42, CATEGORIES);
    expect(res).toEqual({ category: 'Grocery', confidence: 0.9 });
    const body = bodyOf();
    expect(body.model).toBe(groq.GROQ_TEXT_MODEL);
    expect(body.reasoning_effort).toBe('low');
    expect(body.response_format).toEqual({ type: 'json_object' });
    // 80 tokens was sized for a non-reasoning model; reasoning tokens count against it.
    expect(body.max_tokens ?? body.max_completion_tokens).toBeGreaterThanOrEqual(512);
  });

  it('returns null, not a throw, when the reasoning model leaves content empty', async () => {
    mockFetch.mockResolvedValue(ok({ content: '', reasoning: 'thinking...' }, { finish_reason: 'length' }));
    await expect(categorizeWithGroq('Trader Joes', 42, CATEGORIES)).resolves.toBeNull();
  });

  it('tolerates a null content field', async () => {
    mockFetch.mockResolvedValue(ok({ content: null, reasoning: 'x' }));
    await expect(categorizeWithGroq('Trader Joes', 42, CATEGORIES)).resolves.toBeNull();
  });
});

describe('a dead model is loud', () => {
  it('reports LLM-004 for model_not_found, still returns null, and only once per run', async () => {
    mockFetch.mockResolvedValue(modelGone(groq.GROQ_TEXT_MODEL));
    expect(await categorizeWithGroq('A', 1, CATEGORIES)).toBeNull();
    expect(await categorizeWithGroq('B', 2, CATEGORIES)).toBeNull();
    const calls = reportError.mock.calls.filter(c => c[0] === 'LLM-004');
    expect(calls).toHaveLength(1);
    expect(calls[0][1].message).toContain(groq.GROQ_TEXT_MODEL);
  });

  it('reports an unknown-model 400 the same way', async () => {
    mockFetch.mockResolvedValue(fail(400, 'invalid model', 'invalid_request_error'));
    await categorizeWithGroq('A', 1, CATEGORIES);
    expect(reportError.mock.calls.map(c => c[0])).toContain('LLM-004');
  });

  it('reports other hard failures as LLM-001, but not rate limits', async () => {
    mockFetch.mockResolvedValue(fail(500, 'boom'));
    await categorizeWithGroq('A', 1, CATEGORIES);
    expect(reportError.mock.calls.map(c => c[0])).toEqual(['LLM-001']);
    reportError.mockClear(); groq.__resetGroqReports();
    mockFetch.mockResolvedValue(fail(429, 'slow down'));
    await categorizeWithGroq('A', 1, CATEGORIES);
    expect(reportError).not.toHaveBeenCalled();
  });

  it('extraction reports the dead text model and falls through to the next provider', async () => {
    mockFetch.mockImplementation((url) => Promise.resolve(
      String(url).includes('groq.com') ? modelGone(groq.GROQ_TEXT_MODEL) : fail(500, 'other providers down')));
    const res = await extractTransactionText('Little Oddfellows $17.58');
    expect(res.ok).toBe(false);
    expect(bodyOf(0).model).toBe(groq.GROQ_TEXT_MODEL);
    expect(reportError.mock.calls.map(c => c[0])).toContain('LLM-004');
  });
});

describe('extraction request shape', () => {
  it('text extraction uses the shared text model with low reasoning effort', async () => {
    mockFetch.mockResolvedValue(ok({ content: JSON.stringify({ store_name: 'X', total_amount: 5, reward_category: 'Misc' }) }));
    await extractTransactionText('X $5');
    expect(bodyOf().model).toBe(groq.GROQ_TEXT_MODEL);
    expect(bodyOf().reasoning_effort).toBe('low');
  });
});
