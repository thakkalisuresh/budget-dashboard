import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Sheets layer so no real Google calls happen.
vi.mock('../_sheets.mjs', () => ({
  getCurrentMonthSheetId: vi.fn(async () => 'sheet-123'),
  getTotals: vi.fn(async () => ({
    categories: [
      { name: 'Grocery',    spent: 320, remaining: 80,  budget: 400 },
      { name: 'Eating Out', spent: 210, remaining: -60, budget: 150 },
    ],
    salary: 5000,
    leftFromSalary: 4470,
  })),
  getRecentExpenses: vi.fn(async () => ([
    { timestamp: '2026-05-03T10:00:00Z', action: 'Added', category: 'Grocery', vendor: 'Whole Foods', amount: 84.21, uuid: 'u-1', txDate: '2026-05-03' },
    { timestamp: '2026-05-05T12:00:00Z', action: 'Added', category: 'Eating Out', vendor: 'Chipotle', amount: 12.5, uuid: 'u-2', txDate: '2026-05-05' },
  ])),
  appendExpense: vi.fn(async () => ({ uuid: 'new-uuid' })),
  deleteExpenseByUUID: vi.fn(async () => {}),
}));

const { handleRpc, TOOLS, SERVER_INFO } = await import('../_mcp.mjs');
const sheets = await import('../_sheets.mjs');

const call = (method, params, id = 1) => handleRpc({ jsonrpc: '2.0', id, method, params });

beforeEach(() => vi.clearAllMocks());

describe('MCP protocol', () => {
  it('initialize returns server info and tools capability', async () => {
    const res = await call('initialize', { protocolVersion: '2025-03-26' });
    expect(res.result.serverInfo).toEqual(SERVER_INFO);
    expect(res.result.capabilities.tools).toBeDefined();
    expect(res.result.protocolVersion).toBe('2025-03-26');
  });

  it('tools/list returns all five tools with valid schemas', async () => {
    const res = await call('tools/list');
    const names = res.result.tools.map(t => t.name);
    expect(names).toEqual([
      'get_monthly_summary', 'get_transactions', 'get_categories',
      'add_transaction', 'delete_transaction',
    ]);
    for (const t of res.result.tools) {
      expect(t.description).toBeTruthy();
      expect(t.inputSchema.type).toBe('object');
    }
    expect(TOOLS).toHaveLength(5);
  });

  it('notifications/initialized yields no response', async () => {
    const res = await handleRpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(res).toBeNull();
  });

  it('unknown method returns -32601', async () => {
    const res = await call('does/not/exist');
    expect(res.error.code).toBe(-32601);
  });

  it('invalid envelope returns -32600', async () => {
    const res = await handleRpc({ foo: 'bar' });
    expect(res.error.code).toBe(-32600);
  });

  it('ping returns empty result', async () => {
    const res = await call('ping');
    expect(res.result).toEqual({});
  });
});

describe('MCP tools/call', () => {
  it('get_monthly_summary returns computed totals', async () => {
    const res = await call('tools/call', { name: 'get_monthly_summary', arguments: { month: 'May', year: 2026 } });
    const data = JSON.parse(res.result.content[0].text);
    expect(data.income).toBe(5000);
    expect(data.totalSpent).toBe(530);
    expect(data.totalBudget).toBe(550);
    expect(data.variance).toBe(20);
    expect(data.categories).toHaveLength(2);
    expect(sheets.getCurrentMonthSheetId).toHaveBeenCalledWith('May 2026');
  });

  it('get_transactions filters by category', async () => {
    const res = await call('tools/call', { name: 'get_transactions', arguments: { category: 'Grocery' } });
    const data = JSON.parse(res.result.content[0].text);
    expect(data.count).toBe(1);
    expect(data.transactions[0].vendor).toBe('Whole Foods');
    expect(data.transactions[0].uuid).toBe('u-1');
  });

  it('get_categories lists category budgets', async () => {
    const res = await call('tools/call', { name: 'get_categories' });
    const data = JSON.parse(res.result.content[0].text);
    expect(data.categories.map(c => c.name)).toEqual(['Grocery', 'Eating Out']);
  });

  it('add_transaction validates category', async () => {
    const res = await call('tools/call', { name: 'add_transaction', arguments: { vendor: 'X', amount: 10, category: 'Nope' } });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toMatch(/Unknown category/);
    expect(sheets.appendExpense).not.toHaveBeenCalled();
  });

  it('add_transaction rejects non-positive amount', async () => {
    const res = await call('tools/call', { name: 'add_transaction', arguments: { vendor: 'X', amount: -5, category: 'Grocery' } });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toMatch(/positive/);
  });

  it('add_transaction appends a valid expense', async () => {
    const res = await call('tools/call', { name: 'add_transaction', arguments: { vendor: 'Costco', amount: 42.5, category: 'Grocery', date: '2026-05-10' } });
    const data = JSON.parse(res.result.content[0].text);
    expect(data.ok).toBe(true);
    expect(data.uuid).toBe('new-uuid');
    expect(sheets.appendExpense).toHaveBeenCalledWith(expect.objectContaining({
      category: 'Grocery', vendor: 'Costco', amount: 42.5, txDate: '2026-05-10', monthName: 'May 2026',
    }));
  });

  it('delete_transaction resolves category from uuid then deletes', async () => {
    const res = await call('tools/call', { name: 'delete_transaction', arguments: { uuid: 'u-2' } });
    const data = JSON.parse(res.result.content[0].text);
    expect(data.ok).toBe(true);
    expect(data.deleted.vendor).toBe('Chipotle');
    expect(sheets.deleteExpenseByUUID).toHaveBeenCalledWith({ category: 'Eating Out', uuid: 'u-2', sheetId: 'sheet-123' });
  });

  it('delete_transaction errors on unknown uuid', async () => {
    const res = await call('tools/call', { name: 'delete_transaction', arguments: { uuid: 'missing' } });
    expect(res.result.isError).toBe(true);
    expect(sheets.deleteExpenseByUUID).not.toHaveBeenCalled();
  });

  it('unknown tool returns -32602', async () => {
    const res = await call('tools/call', { name: 'frobnicate', arguments: {} });
    expect(res.error.code).toBe(-32602);
  });
});
