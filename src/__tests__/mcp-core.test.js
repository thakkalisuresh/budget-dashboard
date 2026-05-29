import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Sheets data layer and category list so handleRpc can be exercised
// without touching Google. References are hoisted so each test can script them.
const sheets = vi.hoisted(() => ({
  getCurrentMonthSheetId: vi.fn(),
  getTotals:              vi.fn(),
  getRecentExpenses:      vi.fn(),
  appendExpense:          vi.fn(),
  deleteExpenseByUUID:    vi.fn(),
}));
vi.mock('../../netlify/functions/_sheets.mjs', () => sheets);
vi.mock('../../netlify/functions/_extraction.mjs', () => ({
  CATEGORIES: ['Grocery', 'Eating Out', 'Misc'],
}));

const { handleRpc, SERVER_INFO, TOOLS } = await import('../../netlify/functions/_mcp.mjs');

const rpc = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, params });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('handleRpc — protocol envelope', () => {
  it('answers initialize with serverInfo and the requested protocol version', async () => {
    const res = await handleRpc(rpc('initialize', { protocolVersion: '2025-03-26' }));
    expect(res.result.serverInfo).toEqual(SERVER_INFO);
    expect(res.result.protocolVersion).toBe('2025-03-26');
    expect(res.result.capabilities).toHaveProperty('tools');
  });

  it('answers ping with an empty result', async () => {
    expect((await handleRpc(rpc('ping'))).result).toEqual({});
  });

  it('lists every registered tool', async () => {
    const res = await handleRpc(rpc('tools/list'));
    expect(res.result.tools).toHaveLength(TOOLS.length);
    expect(res.result.tools.map(t => t.name)).toContain('get_monthly_summary');
  });

  it('treats notifications/initialized as a no-response notification', async () => {
    expect(await handleRpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
  });

  it('rejects a message missing the jsonrpc marker as Invalid Request', async () => {
    const res = await handleRpc({ id: 1, method: 'ping' });
    expect(res.error.code).toBe(-32600);
  });

  it('returns Method not found for an unknown method with an id', async () => {
    const res = await handleRpc(rpc('does/not/exist'));
    expect(res.error.code).toBe(-32601);
  });

  it('stays silent for an unknown method sent as a notification', async () => {
    expect(await handleRpc({ jsonrpc: '2.0', method: 'does/not/exist' })).toBeNull();
  });
});

describe('handleRpc — tools/call', () => {
  it('rejects an unknown tool with -32602', async () => {
    const res = await handleRpc(rpc('tools/call', { name: 'nope', arguments: {} }));
    expect(res.error.code).toBe(-32602);
  });

  it('returns a summary on the happy path', async () => {
    sheets.getCurrentMonthSheetId.mockResolvedValue('sheet-id');
    sheets.getTotals.mockResolvedValue({
      categories: [{ name: 'Grocery', spent: 10, budget: 20, remaining: 10 }],
      salary: 100,
      leftFromSalary: 90,
    });
    const res = await handleRpc(rpc('tools/call', { name: 'get_monthly_summary', arguments: { month: 'May', year: 2026 } }));
    expect(res.result.isError).toBeFalsy();
    const payload = JSON.parse(res.result.content[0].text);
    expect(payload).toMatchObject({ month: 'May 2026', income: 100, totalSpent: 10, totalBudget: 20, remaining: 90 });
  });

  it('surfaces a ToolError (validation) message to the caller', async () => {
    const res = await handleRpc(rpc('tools/call', { name: 'add_transaction', arguments: { vendor: 'X' } }));
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain('vendor, amount, and category are required');
  });

  it('surfaces a ToolError for an unknown category, including the valid list', async () => {
    const res = await handleRpc(rpc('tools/call', {
      name: 'add_transaction',
      arguments: { vendor: 'X', amount: 5, category: 'Bogus' },
    }));
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain('Unknown category');
  });

  it('hides internal/infra error details behind a generic message', async () => {
    sheets.getCurrentMonthSheetId.mockRejectedValue(new Error('Sheets API 500: spreadsheetId=SECRET123'));
    const res = await handleRpc(rpc('tools/call', { name: 'get_categories', arguments: {} }));
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toBe('Error: tool execution failed');
    expect(res.result.content[0].text).not.toContain('SECRET123');
  });
});
