// The Telegram agent (tool calls) and natural-language queries named a retired
// Groq llama id of their own, and the fallbacks behind it (Claude, Gemini) were
// out of credit, so both features had no working model at all. They now share
// the ids and request shape in _groq.mjs, and a dead model is reported (LLM-004)
// rather than swallowed.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const reportError = vi.fn(() => Promise.resolve());
vi.mock('../../functions/lib/_error-log.mjs', () => ({ reportError: (...a) => reportError(...a) }));

const getTotals = vi.fn(async () => ({ salary: 5000, leftFromSalary: 100, categories: [{ name: 'Grocery', budget: 500, spent: 300, remaining: 200 }] }));
vi.mock('../../functions/lib/_sheets.mjs', () => ({
  getCurrentMonthSheetId: vi.fn(async () => 'sheet-1'),
  getTotals: (...a) => getTotals(...a),
  getRecentExpenses: vi.fn(async () => []),
}));

vi.stubEnv('GROQ_API_KEY', 'gsk-test');
vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');

const groq = await import('../../functions/lib/_groq.mjs');
const { runToolLoop } = await import('../../functions/lib/_agent.mjs');
const { answerQuery } = await import('../../functions/lib/_query.mjs');

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

const isGroq = (url) => String(url).includes('groq.com');
const calledHosts = () => mockFetch.mock.calls.map(c => (isGroq(c[0]) ? 'groq' : 'claude'));
const bodyOf = (i = 0) => JSON.parse(mockFetch.mock.calls[i][1].body);
const ok = (payload) => ({ ok: true, status: 200, json: () => Promise.resolve(payload) });
const fail = (status, message, code) => ({ ok: false, status, json: () => Promise.resolve({ error: { message, code } }) });
const modelGone = () => fail(404, `The model \`${groq.GROQ_TEXT_MODEL}\` does not exist or you do not have access to it.`, 'model_not_found');
const groqMsg = (message, finish_reason = 'stop') => ok({ choices: [{ message: { role: 'assistant', ...message }, finish_reason }] });
const claudeText = (text) => ok({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });

const TOOLS = [{
  name: 'log_expense', description: 'Log an expense',
  input_schema: { type: 'object', properties: { vendor: { type: 'string' }, amount: { type: 'number' } }, required: ['vendor', 'amount'] },
}];
const run = (extra = {}) => runToolLoop({ userText: 'add walgreens 53.11', system: 'sys', tools: TOOLS, execute: vi.fn(), ...extra });

beforeEach(() => {
  mockFetch.mockReset();
  reportError.mockClear();
  groq.__resetGroqReports();
});

describe('model constants', () => {
  it('neither file names a model of its own', () => {
    for (const f of ['_agent', '_query']) {
      const src = readFileSync(fileURLToPath(new URL(`../../functions/lib/${f}.mjs`, import.meta.url)), 'utf8');
      expect(src, f).not.toMatch(/llama-3\.3-70b/);
      expect(src, f).not.toMatch(/api\.groq\.com/);
    }
  });
});

describe('agent request shape', () => {
  it('sends the shared text model, low reasoning effort and room for reasoning tokens', async () => {
    mockFetch.mockResolvedValueOnce(groqMsg({ content: 'hi' }));
    await run();
    expect(String(mockFetch.mock.calls[0][0])).toBe(groq.GROQ_URL);
    const body = bodyOf();
    expect(body.model).toBe(groq.GROQ_TEXT_MODEL);
    expect(body.reasoning_effort).toBe('low');
    expect(body.tool_choice).toBe('auto');
    expect(body.max_tokens).toBeGreaterThanOrEqual(2048);
  });

  it('parses a tool call whose content is null and whose reasoning rides alongside', async () => {
    const execute = vi.fn().mockResolvedValue({ result: 'Logged.', userNotified: true });
    mockFetch
      .mockResolvedValueOnce(groqMsg({ content: null, reasoning: 'user wants an expense', tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'log_expense', arguments: '{"vendor":"walgreens","amount":53.11}' } }] }, 'tool_calls'))
      .mockResolvedValueOnce(groqMsg({ content: 'Done.' }));
    const res = await run({ execute });
    expect(execute).toHaveBeenCalledWith('log_expense', { vendor: 'walgreens', amount: 53.11 });
    expect(res).toEqual({ text: 'Done.', acted: true });
    // The chain of thought is not replayed to the model.
    const echoed = bodyOf(1).messages.find(m => m.tool_calls);
    expect(echoed.reasoning).toBeUndefined();
    expect(echoed.tool_calls).toHaveLength(1);
  });

  it('never returns the reasoning as the answer', async () => {
    mockFetch.mockResolvedValueOnce(groqMsg({ content: '', reasoning: 'long thought' }, 'length'))
      .mockResolvedValueOnce(claudeText('from claude'));
    const res = await run();
    expect(res.text).toBe('from claude');
  });
});

describe('agent failures are loud', () => {
  it('reports LLM-004 for model_not_found and falls through to Claude', async () => {
    mockFetch.mockResolvedValueOnce(modelGone()).mockResolvedValueOnce(claudeText('from claude'));
    const res = await run();
    expect(res.text).toBe('from claude');
    expect(calledHosts()).toEqual(['groq', 'claude']);
    const calls = reportError.mock.calls.filter(c => c[0] === 'LLM-004');
    expect(calls).toHaveLength(1);
    expect(calls[0][1].message).toContain(groq.GROQ_TEXT_MODEL);
  });

  it('reports the dead model once per run, not once per message', async () => {
    mockFetch.mockResolvedValue(modelGone());
    await run().catch(() => {});
    await run().catch(() => {});
    expect(reportError.mock.calls.filter(c => c[0] === 'LLM-004')).toHaveLength(1);
  });

  it('throws when every provider fails, so the caller can tell the user', async () => {
    mockFetch.mockImplementation((url) => Promise.resolve(isGroq(url) ? modelGone() : fail(400, 'credit balance is too low')));
    await expect(run()).rejects.toThrow();
  });
});

describe('query', () => {
  it('sends the shared text model with low reasoning effort and room for reasoning tokens', async () => {
    mockFetch.mockResolvedValueOnce(groqMsg({ content: 'You spent $300.00 on grocery.' }));
    const answer = await answerQuery('how much on grocery this month?');
    expect(answer).toBe('You spent $300.00 on grocery.');
    const body = bodyOf();
    expect(String(mockFetch.mock.calls[0][0])).toBe(groq.GROQ_URL);
    expect(body.model).toBe(groq.GROQ_TEXT_MODEL);
    expect(body.reasoning_effort).toBe('low');
    expect(body.max_tokens).toBeGreaterThanOrEqual(1024);
  });

  it('reports LLM-004 for model_not_found and falls through to Claude', async () => {
    mockFetch.mockResolvedValueOnce(modelGone()).mockResolvedValueOnce(claudeText('claude answer'));
    expect(await answerQuery('how much on grocery this month?')).toBe('claude answer');
    expect(calledHosts()).toEqual(['groq', 'claude']);
    expect(reportError.mock.calls.map(c => c[0])).toContain('LLM-004');
  });

  it('treats empty content (reasoning ate the budget) as a miss, not an answer', async () => {
    mockFetch.mockResolvedValueOnce(groqMsg({ content: '', reasoning: 'x' }, 'length')).mockResolvedValueOnce(claudeText('claude answer'));
    expect(await answerQuery('how much on grocery this month?')).toBe('claude answer');
  });

  it('gives a clear reply and reports an error when every provider fails', async () => {
    mockFetch.mockImplementation((url) => Promise.resolve(isGroq(url) ? modelGone() : fail(400, 'credit balance is too low')));
    const answer = await answerQuery('how much on grocery this month?');
    expect(answer).toMatch(/couldn't answer|right now/i);
    expect(answer).not.toMatch(/Error|at \S+:\d+/);
    expect(reportError.mock.calls.map(c => c[0])).toContain('LLM-002');
  });
});
