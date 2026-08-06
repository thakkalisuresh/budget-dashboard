// The conversational agent now runs on Groq, with Claude as the last straw.
//
// The subtle case: agent tools have SIDE EFFECTS — log_expense writes a row to
// the sheet. If Groq dies after a tool has already run, failing the whole turn
// over to Claude would run it again and duplicate the expense. So the fallback
// is only allowed when Groq did nothing.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.stubEnv('GROQ_API_KEY', 'gsk-test');
vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');

const { runToolLoop } = await import('../../functions/lib/_agent.mjs');

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

const host = (url) => (String(url).includes('groq.com') ? 'groq' : 'claude');
const calledHosts = () => mockFetch.mock.calls.map(c => host(c[0]));
const ok = (payload) => ({ ok: true, json: () => Promise.resolve(payload) });
const fail = () => ({ ok: false, json: () => Promise.resolve({ error: { message: 'boom' } }) });

const groqText = (content) => ok({ choices: [{ message: { role: 'assistant', content } }] });
const groqToolCall = (name, args) => ok({
  choices: [{ message: { role: 'assistant', content: null, tool_calls: [
    { id: 'call_1', type: 'function', function: { name, arguments: JSON.stringify(args) } },
  ] } }],
});
const claudeText = (text) => ok({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });

const TOOLS = [{
  name: 'log_expense',
  description: 'Log an expense',
  input_schema: { type: 'object', properties: { vendor: { type: 'string' }, amount: { type: 'number' } }, required: ['vendor', 'amount'] },
}];

beforeEach(() => { mockFetch.mockReset(); });

describe('provider order', () => {
  it('uses Groq and never touches Claude when it answers', async () => {
    mockFetch.mockResolvedValueOnce(groqText('You spent $200 on groceries.'));
    const res = await runToolLoop({ userText: 'how much on groceries?', system: 'sys', tools: TOOLS, execute: vi.fn() });

    expect(res.text).toBe('You spent $200 on groceries.');
    expect(calledHosts()).toEqual(['groq']);
  });

  it('translates Anthropic-shaped tools into the OpenAI schema', async () => {
    mockFetch.mockResolvedValueOnce(groqText('done'));
    await runToolLoop({ userText: 'hi', system: 'sys', tools: TOOLS, execute: vi.fn() });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.tools[0]).toEqual({
      type: 'function',
      function: { name: 'log_expense', description: 'Log an expense', parameters: TOOLS[0].input_schema },
    });
    // The system prompt becomes a message rather than a top-level field.
    expect(body.messages[0]).toEqual({ role: 'system', content: 'sys' });
  });

  it('executes a tool call and feeds the result back', async () => {
    const execute = vi.fn().mockResolvedValue({ result: 'Logged.', userNotified: true });
    mockFetch
      .mockResolvedValueOnce(groqToolCall('log_expense', { vendor: 'walgreens', amount: 53.11 }))
      .mockResolvedValueOnce(groqText(''));

    const res = await runToolLoop({ userText: 'add walgreens 53.11', system: 'sys', tools: TOOLS, execute });

    expect(execute).toHaveBeenCalledWith('log_expense', { vendor: 'walgreens', amount: 53.11 });
    expect(res.acted).toBe(true);
    const second = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(second.messages.at(-1)).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'Logged.' });
  });

  it('falls back to Claude when Groq is unreachable', async () => {
    mockFetch
      .mockResolvedValueOnce(fail())                       // groq
      .mockResolvedValueOnce(claudeText('Hello from Claude'));

    const res = await runToolLoop({ userText: 'hi', system: 'sys', tools: TOOLS, execute: vi.fn() });

    expect(res.text).toBe('Hello from Claude');
    expect(calledHosts()).toEqual(['groq', 'claude']);
  });
});

describe('no re-execution after a side effect', () => {
  it('does NOT fail over once a tool has already run', async () => {
    // Groq logs the expense, then dies. Retrying on Claude would log it twice.
    const execute = vi.fn().mockResolvedValue({ result: 'Logged.', userNotified: true });
    mockFetch
      .mockResolvedValueOnce(groqToolCall('log_expense', { vendor: 'walgreens', amount: 53.11 }))
      .mockResolvedValueOnce(fail());                      // groq dies mid-loop

    await expect(runToolLoop({ userText: 'add walgreens 53.11', system: 'sys', tools: TOOLS, execute }))
      .rejects.toThrow();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(calledHosts()).not.toContain('claude');
  });

  it('still fails over when the failure came before any tool ran', async () => {
    const execute = vi.fn();
    mockFetch
      .mockResolvedValueOnce(fail())
      .mockResolvedValueOnce(claudeText('recovered'));

    const res = await runToolLoop({ userText: 'hi', system: 'sys', tools: TOOLS, execute });

    expect(res.text).toBe('recovered');
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('malformed tool arguments', () => {
  it('reports the error back to the model instead of crashing the turn', async () => {
    const execute = vi.fn();
    mockFetch
      .mockResolvedValueOnce(ok({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'log_expense', arguments: '{not json' } },
      ] } }] }))
      .mockResolvedValueOnce(groqText('Sorry, could you repeat that?'));

    const res = await runToolLoop({ userText: 'add something', system: 'sys', tools: TOOLS, execute });

    expect(execute).not.toHaveBeenCalled();
    expect(res.text).toBe('Sorry, could you repeat that?');
    const second = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(second.messages.at(-1).content).toMatch(/not valid JSON/);
  });
});
