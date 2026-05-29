/**
 * MCP (Model Context Protocol) core — stateless JSON-RPC 2.0 handler.
 *
 * Implements the MCP wire protocol directly (no SDK) so it fits Netlify's
 * stateless request/response model. Compatible with MCP "Streamable HTTP"
 * clients. The legacy SSE transport is intentionally NOT used — it requires a
 * held-open connection correlated across invocations, which serverless cannot do.
 *
 * Files starting with "_" are NOT deployed as functions by Netlify.
 */

import {
  getCurrentMonthSheetId, getTotals, getRecentExpenses,
  appendExpense, deleteExpenseByUUID,
} from './_sheets.mjs';
import { CATEGORIES } from './_extraction.mjs';

export const SERVER_INFO     = { name: 'fundient-mcp', version: '1.0.0' };
const DEFAULT_PROTOCOL       = '2024-11-05';

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

/* ── month helpers ── */

function monthLabel(month) {
  if (month == null || month === '') return null;
  if (typeof month === 'number' || /^\d+$/.test(String(month))) {
    return MONTHS[Number(month) - 1] || null;
  }
  return MONTHS.find(m => m.toLowerCase() === String(month).toLowerCase()) || null;
}

function resolveMonthName(month, year) {
  const now  = new Date();
  const name = monthLabel(month) || now.toLocaleString('en-US', { month: 'long' });
  const yr   = year || now.getFullYear();
  return `${name} ${yr}`;
}

const round2 = (n) => Math.round((n || 0) * 100) / 100;

class ToolError extends Error {}

/* ── tool implementations ── */

async function toolGetMonthlySummary({ month, year } = {}) {
  const monthName = resolveMonthName(month, year);
  const sheetId   = await getCurrentMonthSheetId(monthName);
  const { categories, salary, leftFromSalary } = await getTotals(sheetId);
  const totalSpent  = round2(categories.reduce((s, c) => s + c.spent, 0));
  const totalBudget = round2(categories.reduce((s, c) => s + c.budget, 0));
  return {
    month: monthName,
    income: salary,
    totalSpent,
    totalBudget,
    variance: round2(totalBudget - totalSpent),
    remaining: salary != null ? round2(salary - totalSpent) : null,
    leftFromSalary,
    categories,
  };
}

async function toolGetTransactions({ month, year, category, limit } = {}) {
  const monthName = resolveMonthName(month, year);
  const sheetId   = await getCurrentMonthSheetId(monthName);
  let txs = await getRecentExpenses(sheetId, Math.min(Number(limit) || 50, 100));
  if (category) {
    txs = txs.filter(t => (t.category || '').toLowerCase() === String(category).toLowerCase());
  }
  return {
    month: monthName,
    count: txs.length,
    transactions: txs.map(t => ({
      date:     t.txDate || (t.timestamp || '').slice(0, 10),
      vendor:   t.vendor,
      category: t.category,
      amount:   t.amount,
      uuid:     t.uuid,
    })),
  };
}

async function toolGetCategories() {
  const monthName = resolveMonthName();
  const sheetId   = await getCurrentMonthSheetId(monthName);
  const { categories } = await getTotals(sheetId);
  return {
    month: monthName,
    categories: categories.map(c => ({ name: c.name, budget: c.budget, spent: c.spent, remaining: c.remaining })),
  };
}

async function toolAddTransaction({ vendor, amount, category, date } = {}) {
  if (!vendor || !category || amount == null) {
    throw new ToolError('vendor, amount, and category are required');
  }
  const amt = Number(amount);
  if (!(amt > 0)) throw new ToolError('amount must be a positive number');
  if (!CATEGORIES.includes(category)) {
    throw new ToolError(`Unknown category "${category}". Valid: ${CATEGORIES.join(', ')}`);
  }
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new ToolError('date must be in YYYY-MM-DD format');
  }
  const txDate    = date || new Date().toISOString().slice(0, 10);
  const d         = new Date(txDate + 'T00:00:00');
  const monthName = `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  const sheetId   = await getCurrentMonthSheetId(monthName);
  const { uuid }  = await appendExpense({ category, vendor: String(vendor).trim(), amount: amt, txDate, sheetId, monthName });
  return { ok: true, uuid, vendor: String(vendor).trim(), amount: amt, category, date: txDate, month: monthName };
}

async function toolDeleteTransaction({ uuid, month, year } = {}) {
  if (!uuid) throw new ToolError('uuid is required');
  const monthName = resolveMonthName(month, year);
  const sheetId   = await getCurrentMonthSheetId(monthName);
  const recent    = await getRecentExpenses(sheetId, 100);
  const match     = recent.find(t => t.uuid === uuid);
  if (!match) throw new ToolError(`Transaction ${uuid} not found in ${monthName}`);
  await deleteExpenseByUUID({ category: match.category, uuid, sheetId });
  return { ok: true, deleted: { uuid, vendor: match.vendor, amount: match.amount, category: match.category } };
}

/* ── tool registry ── */

export const TOOLS = [
  {
    name: 'get_monthly_summary',
    description: 'Get the budget summary for a month: income, total spent, budget, variance, and per-category breakdown. Defaults to the current month.',
    inputSchema: {
      type: 'object',
      properties: {
        month: { type: 'string', description: 'Full month name (e.g. "May") or number 1-12. Defaults to current month.' },
        year:  { type: 'number', description: 'Year (e.g. 2026). Defaults to current year.' },
      },
    },
  },
  {
    name: 'get_transactions',
    description: 'List logged transactions for a month, optionally filtered by category. Returns date, vendor, category, amount, and uuid for each.',
    inputSchema: {
      type: 'object',
      properties: {
        month:    { type: 'string', description: 'Full month name or number 1-12. Defaults to current month.' },
        year:     { type: 'number', description: 'Year. Defaults to current year.' },
        category: { type: 'string', description: 'Optional category name to filter by.' },
        limit:    { type: 'number', description: 'Max transactions to return (default 50, max 100).' },
      },
    },
  },
  {
    name: 'get_categories',
    description: 'List the budget categories for the current month with their budget, spent, and remaining amounts.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'add_transaction',
    description: 'Log a new expense to the budget sheet. Requires vendor, amount, and a valid category.',
    inputSchema: {
      type: 'object',
      properties: {
        vendor:   { type: 'string', description: 'Merchant or vendor name.' },
        amount:   { type: 'number', description: 'Positive expense amount.' },
        category: { type: 'string', description: `One of: ${CATEGORIES.join(', ')}.` },
        date:     { type: 'string', description: 'Transaction date YYYY-MM-DD. Defaults to today.' },
      },
      required: ['vendor', 'amount', 'category'],
    },
  },
  {
    name: 'delete_transaction',
    description: 'Delete a logged transaction by its uuid (obtain it from get_transactions).',
    inputSchema: {
      type: 'object',
      properties: {
        uuid:  { type: 'string', description: 'The transaction uuid to delete.' },
        month: { type: 'string', description: 'Month the transaction is in. Defaults to current month.' },
        year:  { type: 'number', description: 'Year. Defaults to current year.' },
      },
      required: ['uuid'],
    },
  },
];

const TOOL_IMPL = {
  get_monthly_summary: toolGetMonthlySummary,
  get_transactions:    toolGetTransactions,
  get_categories:      toolGetCategories,
  add_transaction:     toolAddTransaction,
  delete_transaction:  toolDeleteTransaction,
};

/* ── JSON-RPC 2.0 envelope ── */

const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError  = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

/**
 * Handle a single JSON-RPC message. Returns a response object, or null for
 * notifications (messages without an id) which must not be answered.
 */
export async function handleRpc(message) {
  if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') {
    return rpcError(message?.id ?? null, -32600, 'Invalid Request');
  }

  const { id, method, params } = message;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: params?.protocolVersion || DEFAULT_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });

    case 'notifications/initialized':
    case 'initialized':
      return null; // notification — no response

    case 'ping':
      return rpcResult(id, {});

    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });

    case 'tools/call': {
      const name = params?.name;
      const impl = TOOL_IMPL[name];
      if (!impl) return rpcError(id, -32602, `Unknown tool: ${name}`);
      try {
        const result = await impl(params?.arguments || {});
        return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
      } catch (e) {
        // Tool-execution failures are returned as tool results (isError), not
        // protocol errors, so the model can read and react to them.
        return rpcResult(id, { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
      }
    }

    default:
      if (isNotification) return null;
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}
