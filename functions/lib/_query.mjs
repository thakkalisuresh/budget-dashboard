/**
 * WhatsApp query handler — three-layer cost optimization:
 *   Layer 1: Deterministic patterns (FREE, no AI)
 *   Layer 2: Pre-aggregated summary + Haiku (~$0.002/query)
 *   Layer 3: Full context + Sonnet (~$0.010/query, rare)
 *
 * Files in lib/ are shared modules, not standalone deployed functions.
 */

import { getCurrentMonthSheetId, getTotals, getRecentExpenses } from './_sheets.mjs';
import { CATEGORIES } from './_extraction.mjs';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_URL     = 'https://api.anthropic.com/v1/messages';
const HAIKU_MODEL       = 'claude-haiku-4-5';
const SONNET_MODEL      = 'claude-sonnet-4-6';

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_URL     = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL   = 'llama-3.3-70b-versatile';

const QUERY_SYSTEM_PROMPT = `You are a budget assistant answering questions about the user's monthly expenses over WhatsApp.

Rules:
- Reply with plain text only — no markdown, no headers, no bullets
- Keep answers under 200 characters when possible
- Use dollar amounts with 2 decimals (e.g., $45.23)
- If the data doesn't support the question, say so briefly
- Don't speculate beyond the data provided`;

export function looksLikeQuery(text) {
  const t = (text || '').trim();
  if (t.startsWith('?')) return true;
  if (/^(how|what|show|list|top|compare|when|where|which)\b/i.test(t)) return true;
  return false;
}

export async function answerQuery(text) {
  const monthName = new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' });
  let sheetId;
  try {
    sheetId = await getCurrentMonthSheetId(monthName);
  } catch (e) {
    return `Couldn't find sheet for ${monthName}.`;
  }

  const cleaned = text.replace(/^\?\s*/, '').trim();
  if (!cleaned || /^help$/i.test(cleaned)) {
    return helpMessage();
  }

  // ── Layer 1: deterministic patterns ──
  const deterministic = await tryDeterministic(cleaned, sheetId, monthName);
  if (deterministic) return deterministic;

  // ── Layer 2/3: Groq (free) then Claude fallback ──
  return await answerWithAI(cleaned, sheetId, monthName);
}

function helpMessage() {
  return [
    'Ask a question about your budget. Examples:',
    '? budget — remaining per category',
    '? total — spent this month',
    '? grocery — single category status',
    '? last 5 — recent transactions',
    '? salary — current salary',
    '? top — top spend categories',
    'Or just ask: "how much on travel?", "compare to last month?"',
  ].join('\n');
}

async function tryDeterministic(cleaned, sheetId, monthName) {
  const lower = cleaned.toLowerCase();

  // "last N" / "recent"
  const lastMatch = lower.match(/^(?:last|recent)\s*(\d+)?$/);
  if (lastMatch) {
    const n = Math.min(parseInt(lastMatch[1] || '5', 10), 20);
    const recent = await getRecentExpenses(sheetId, n);
    if (recent.length === 0) return `No recent transactions in ${monthName}.`;
    const lines = [`Last ${recent.length} transactions:`];
    for (const r of recent) {
      const date = r.txDate || (r.timestamp || '').slice(0, 10);
      lines.push(`${date} · ${r.vendor || 'Unknown'} · $${r.amount?.toFixed(2)} (${r.category})`);
    }
    return lines.join('\n');
  }

  // "budget" / "remaining" / "left"
  if (/^(budget|remaining|left|status)$/i.test(cleaned)) {
    const { categories, salary, leftFromSalary } = await getTotals(sheetId);
    const active = categories.filter(c => c.budget > 0);
    if (active.length === 0) return 'No category budgets set for this month.';

    const lines = [`Budget remaining (${monthName}):`];
    active
      .sort((a, b) => a.remaining - b.remaining)
      .forEach(c => {
        const pct = c.budget > 0 ? Math.round((c.spent / c.budget) * 100) : 0;
        lines.push(`${c.name}: $${c.remaining.toFixed(2)} left (${pct}% used)`);
      });
    if (leftFromSalary != null) lines.push(`Left from salary: $${leftFromSalary.toFixed(2)}`);
    return lines.join('\n');
  }

  // "total" / "spent"
  if (/^(total|spent|month)$/i.test(cleaned)) {
    const { categories, salary } = await getTotals(sheetId);
    const totalSpent = categories.reduce((sum, c) => sum + c.spent, 0);
    const lines = [`${monthName} totals:`, `Total spent: $${totalSpent.toFixed(2)}`];
    if (salary != null) lines.push(`Salary: $${salary.toFixed(2)}`, `Remaining: $${(salary - totalSpent).toFixed(2)}`);
    return lines.join('\n');
  }

  // "salary"
  if (/^salary$/i.test(cleaned)) {
    const { salary } = await getTotals(sheetId);
    return salary != null ? `Salary: $${salary.toFixed(2)}` : 'No salary set for this month.';
  }

  // "top" / "top N"
  const topMatch = lower.match(/^top\s*(\d+)?$/);
  if (topMatch) {
    const n = Math.min(parseInt(topMatch[1] || '3', 10), 10);
    const { categories } = await getTotals(sheetId);
    const sorted = categories.filter(c => c.spent > 0).sort((a, b) => b.spent - a.spent).slice(0, n);
    if (sorted.length === 0) return 'No spending yet this month.';
    const lines = [`Top ${sorted.length} categories (${monthName}):`];
    sorted.forEach((c, i) => lines.push(`${i + 1}. ${c.name}: $${c.spent.toFixed(2)}`));
    return lines.join('\n');
  }

  // Single category lookup — match against known categories
  const matched = CATEGORIES.find(c => c.toLowerCase() === lower);
  if (matched) {
    const { categories } = await getTotals(sheetId);
    const cat = categories.find(c => c.name.toLowerCase() === matched.toLowerCase());
    if (!cat) return `No data for ${matched} this month.`;
    const pct = cat.budget > 0 ? Math.round((cat.spent / cat.budget) * 100) : 0;
    return `${cat.name} (${monthName}):\nSpent: $${cat.spent.toFixed(2)}\nBudget: $${cat.budget.toFixed(2)}\nRemaining: $${cat.remaining.toFixed(2)} (${pct}% used)`;
  }

  return null;
}

async function callGroq(question, summary, monthName) {
  if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY not configured');

  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GROQ_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      max_tokens: 400,
      messages: [
        { role: 'system', content: QUERY_SYSTEM_PROMPT },
        { role: 'user', content: `Current month context (${monthName}):\n${summary}\n\nQuestion: ${question}` },
      ],
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Groq API: ${err?.error?.message || res.status}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || '';
}

async function answerWithAI(question, sheetId, monthName) {
  const summary = await buildMonthSummary(sheetId, monthName);

  // Layer 2: Groq (free)
  try {
    const answer = await callGroq(question, summary, monthName);
    if (answer) return answer;
  } catch (e) {
    console.warn('query: Groq failed, falling back to Claude:', e.message);
  }

  // Layer 3: Claude fallback
  if (!ANTHROPIC_API_KEY) {
    return "I can't answer that — AI is not configured. Try: ? budget, ? total, ? last 5";
  }

  const isComplex = /\b(why|compare|trend|vs|versus|last month|previous|analyze|reason)\b/i.test(question);
  const model = isComplex ? SONNET_MODEL : HAIKU_MODEL;

  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 400,
        system: [
          { type: 'text', text: QUERY_SYSTEM_PROMPT },
          {
            type: 'text',
            text: `Current month context (${monthName}):\n${summary}`,
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [{ role: 'user', content: question }],
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.error(`LLM-002 — Agent API error, query Claude (${model}):`, err?.error?.message || res.status);
      return "Sorry, I couldn't answer that right now. Try a simpler query like '? budget' or '? total'.";
    }

    const data = await res.json();
    const answer = data.content?.[0]?.text || '';
    return answer.trim() || "I don't have enough data to answer that.";
  } catch (e) {
    console.error('LLM-002 — Agent API error (query):', e.message);
    return "Sorry, I couldn't reach the AI. Try '? budget' or '? total'.";
  }
}

async function buildMonthSummary(sheetId, monthName) {
  const { categories, salary, leftFromSalary } = await getTotals(sheetId);
  const recent = await getRecentExpenses(sheetId, 10);

  const lines = [`Month: ${monthName}`];
  if (salary != null) lines.push(`Salary: $${salary.toFixed(2)}`);
  if (leftFromSalary != null) lines.push(`Left from salary: $${leftFromSalary.toFixed(2)}`);

  const totalSpent = categories.reduce((sum, c) => sum + c.spent, 0);
  lines.push(`Total spent: $${totalSpent.toFixed(2)}`);

  lines.push('', 'Categories:');
  categories
    .filter(c => c.budget > 0 || c.spent > 0)
    .forEach(c => {
      lines.push(`  ${c.name}: spent $${c.spent.toFixed(2)} of $${c.budget.toFixed(2)} budget ($${c.remaining.toFixed(2)} left)`);
    });

  if (recent.length > 0) {
    lines.push('', 'Recent transactions:');
    recent.forEach(r => {
      const date = r.txDate || (r.timestamp || '').slice(0, 10);
      lines.push(`  ${date} · ${r.vendor} · $${r.amount?.toFixed(2)} (${r.category})`);
    });
  }

  return lines.join('\n');
}
