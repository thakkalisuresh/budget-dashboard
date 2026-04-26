import React, { useState, useRef, useEffect } from 'react';
import { X, Send, Zap } from 'lucide-react';
import { addOrUpdateExpense, CATEGORIES } from './sheetsApi.js';
import { LogoSpark } from './FundientLogo.jsx';

function buildQuickPrompts({ expenses, overallRemaining, notesString, rulesData }) {
  const prompts = [];

  // 1. Most over-budget category, or biggest spender
  const overBudget = [...expenses].filter(e => e.remaining < 0).sort((a, b) => a.remaining - b.remaining);
  const biggest    = [...expenses].sort((a, b) => b.actual - a.actual)[0];
  if (overBudget.length > 0) {
    prompts.push(`Why am I over on ${overBudget[0].name}?`);
  } else if (biggest) {
    prompts.push(`How is my ${biggest.name} spending looking?`);
  } else {
    prompts.push('Am I on track this month?');
  }

  // 2. Spending headroom or cut-back advice
  if (overallRemaining < 0) {
    prompts.push('Where can I cut back?');
  } else {
    prompts.push('How much can I safely spend for the rest of the month?');
  }

  // 3. 50/30/20 or non-monthly note if present
  if (notesString) {
    prompts.push('What would my balance be without one-off expenses?');
  } else if (rulesData) {
    prompts.push("What's my 50/30/20 status?");
  } else {
    prompts.push("What's my biggest expense category?");
  }

  return prompts;
}

function buildSystemPrompt({
  expenses, salaryReceived, totalActual, totalBudget, overallRemaining,
  monthName, nonRecurringRemaining, potentialDifference, notesString, rulesData,
}) {
  const now = new Date();
  const dayOfMonth  = now.getDate();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const dateStr     = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  const expenseLines = expenses.map(e => {
    const status = e.remaining > 0
      ? `$${e.remaining.toFixed(2)} remaining`
      : e.remaining === 0
        ? 'exactly at budget'
        : `$${Math.abs(e.remaining).toFixed(2)} over budget`;
    return `  - ${e.name}: spent $${e.actual.toFixed(2)} of $${e.budget.toFixed(2)} budget (${status})`;
  }).join('\n');

  let rulesSection = '';
  if (rulesData) {
    rulesSection = `
50/30/20 Budget Rules:
  Needs   (50%): $${Number(rulesData.needs?.total   || 0).toFixed(2)} spent / $${Number(rulesData.needs?.target   || 0).toFixed(2)} target (${rulesData.needs?.pct   || 0}%)
  Wants   (30%): $${Number(rulesData.wants?.total   || 0).toFixed(2)} spent / $${Number(rulesData.wants?.target   || 0).toFixed(2)} target (${rulesData.wants?.pct   || 0}%)
  Savings (20%): $${Number(rulesData.savings?.total || 0).toFixed(2)} spent / $${Number(rulesData.savings?.target || 0).toFixed(2)} target (${rulesData.savings?.pct || 0}%)`;
  }

  return `You are a friendly, concise personal budget assistant for ${monthName || 'this month'}.

Today: ${dateStr} (Day ${dayOfMonth} of ${daysInMonth} — ${daysInMonth - dayOfMonth} days remaining in the month)

Current budget snapshot:
  Monthly Salary: $${salaryReceived.toFixed(2)}
  Total Spent:    $${totalActual.toFixed(2)}
  Total Budget:   $${totalBudget.toFixed(2)}
  Net Remaining:  ${overallRemaining >= 0 ? `$${overallRemaining.toFixed(2)} under budget` : `$${Math.abs(overallRemaining).toFixed(2)} over budget`}
  Balance without non-monthly expenses: $${nonRecurringRemaining.toFixed(2)}
  Budgeted vs actual difference: $${potentialDifference.toFixed(2)}
${rulesSection}

Expense breakdown:
${expenseLines || '  (no expense data yet)'}
${notesString ? `\nNon-monthly / random expenses note: "${notesString}"` : ''}

Available expense categories (use exactly as written): ${CATEGORIES.join(', ')}

Rules:
- Answer concisely — 2 to 4 sentences unless more detail is genuinely needed.
- Always use $ for dollar amounts.
- Be encouraging but honest about overspending.
- If asked something unrelated to budgeting, politely redirect.
- If the user wants to add or log an expense, use the add_expense tool. Confirm with the user if the category or amount is unclear.`;
}

export function ChatAgent({
  expenses, salaryReceived, totalActual, totalBudget, overallRemaining, monthName,
  accessToken, sheetId, onRefresh,
  nonRecurringRemaining = 0, potentialDifference = 0, notesString = '', rulesData,
}) {
  const [open, setOpen]         = useState(false);
  const [messages, setMessages] = useState([]); // display messages
  const [input, setInput]       = useState('');
  const [streaming, setStreaming]   = useState(false);
  const [toolRunning, setToolRunning] = useState(false);
  const messagesEndRef  = useRef(null);
  const inputRef        = useRef(null);
  const apiHistoryRef   = useRef([]); // full API conversation (includes tool_use / tool_result)

  const apiKey = import.meta.env.VITE_ANTHROPIC_API_KEY;
  const hasKey = apiKey && apiKey !== 'your_api_key_here';
  const isBusy = streaming || toolRunning;

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Focus input when panel opens
  useEffect(() => {
    if (open && hasKey) setTimeout(() => inputRef.current?.focus(), 150);
  }, [open, hasKey]);

  // ── Tool definitions ───────────────────────────────────────────────────────

  const tools = [
    {
      name: 'add_expense',
      description: 'Add or update an expense entry in the budget spreadsheet. Use this when the user asks to log, record, or add a purchase.',
      input_schema: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            description: `Expense category — must be exactly one of: ${CATEGORIES.join(', ')}`,
            enum: CATEGORIES,
          },
          vendor: {
            type: 'string',
            description: 'The vendor name or expense description (e.g. "Walmart", "Netflix", "Shell Gas")',
          },
          amount: {
            type: 'number',
            description: 'The expense amount in dollars (positive number)',
          },
          is_random: {
            type: 'boolean',
            description: 'Set to true if this is a one-off / non-monthly expense (default: false)',
          },
        },
        required: ['category', 'vendor', 'amount'],
      },
    },
  ];

  // ── Tool executor ─────────────────────────────────────────────────────────

  const executeTool = async (toolName, toolInput) => {
    if (toolName === 'add_expense') {
      const { category, vendor, amount, is_random = false } = toolInput;
      await addOrUpdateExpense(
        category, vendor, Number(amount), accessToken, sheetId, monthName, 'chat', is_random
      );
      if (onRefresh) onRefresh();
      return `Successfully added $${Number(amount).toFixed(2)} for "${vendor}" under ${category}.`;
    }
    return 'Unknown tool.';
  };

  // ── API helpers ───────────────────────────────────────────────────────────

  const buildBody = (history, stream) => ({
    model: 'claude-haiku-4-5',
    max_tokens: 1024,
    system: buildSystemPrompt({
      expenses, salaryReceived, totalActual, totalBudget, overallRemaining, monthName,
      nonRecurringRemaining, potentialDifference, notesString, rulesData,
    }),
    messages: history,
    tools,
    stream,
  });

  const callApi = async (history, stream = true) => {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(buildBody(history, stream)),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error?.message || `API error ${res.status}`);
    }
    return res;
  };

  // ── Streaming reader — returns assistantContent array + stopReason ─────────

  const streamResponse = async (history) => {
    const res = await callApi(history, true);
    const reader  = res.body.getReader();
    const decoder = new TextDecoder();

    // contentBlocks[index] tracks each SSE content block
    const contentBlocks = {};
    let stopReason = null;

    // Add empty placeholder for the assistant bubble
    setMessages(prev => [...prev, { role: 'assistant', content: '' }]);

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });

      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);

          if (parsed.type === 'content_block_start') {
            contentBlocks[parsed.index] = { ...parsed.content_block, inputJson: '' };
          }

          if (parsed.type === 'content_block_delta') {
            const blk = contentBlocks[parsed.index];
            if (!blk) continue;
            if (parsed.delta.type === 'text_delta') {
              blk.text = (blk.text || '') + parsed.delta.text;
              // Live-update the assistant bubble
              const liveText = blk.text;
              setMessages(prev => {
                const next = [...prev];
                next[next.length - 1] = { role: 'assistant', content: liveText };
                return next;
              });
            }
            if (parsed.delta.type === 'input_json_delta') {
              blk.inputJson = (blk.inputJson || '') + parsed.delta.partial_json;
            }
          }

          if (parsed.type === 'message_delta') {
            stopReason = parsed.delta?.stop_reason;
          }
        } catch { /* skip malformed SSE lines */ }
      }
    }

    // Build the canonical assistant content array for API history
    const assistantContent = Object.entries(contentBlocks)
      .sort(([a], [b]) => Number(a) - Number(b))
      .flatMap(([, blk]) => {
        if (blk.type === 'text' && blk.text) {
          return [{ type: 'text', text: blk.text }];
        }
        if (blk.type === 'tool_use') {
          let parsedInput = {};
          try { parsedInput = JSON.parse(blk.inputJson || '{}'); } catch {}
          return [{ type: 'tool_use', id: blk.id, name: blk.name, input: parsedInput }];
        }
        return [];
      });

    const assistantText = assistantContent.find(b => b.type === 'text')?.text || '';
    return { assistantText, assistantContent, stopReason };
  };

  // ── Main send logic ────────────────────────────────────────────────────────

  const sendMessage = async (text) => {
    const trimmed = text.trim();
    if (!trimmed || isBusy || !hasKey) return;

    setInput('');
    setStreaming(true);

    // Add user message to both display and API history
    setMessages(prev => [...prev, { role: 'user', content: trimmed }]);
    apiHistoryRef.current = [...apiHistoryRef.current, { role: 'user', content: trimmed }];

    try {
      const { assistantContent, stopReason } = await streamResponse(apiHistoryRef.current);

      // Record assistant turn in API history
      apiHistoryRef.current = [...apiHistoryRef.current, {
        role: 'assistant',
        content: assistantContent,
      }];

      // ── Tool use branch ────────────────────────────────────────────────────
      if (stopReason === 'tool_use') {
        setStreaming(false);
        setToolRunning(true);

        const toolBlock = assistantContent.find(b => b.type === 'tool_use');
        if (toolBlock) {
          // Show a "working…" status bubble
          setMessages(prev => [
            ...prev,
            { role: 'assistant', content: '⚡ Adding expense to your spreadsheet…', isToolStatus: true },
          ]);

          let toolResultContent;
          let isError = false;
          try {
            toolResultContent = await executeTool(toolBlock.name, toolBlock.input);
          } catch (toolErr) {
            toolResultContent = `Error: ${toolErr.message}`;
            isError = true;
          }

          // Add tool_result to API history
          apiHistoryRef.current = [...apiHistoryRef.current, {
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: toolBlock.id,
              content: toolResultContent,
              ...(isError ? { is_error: true } : {}),
            }],
          }];

          // Remove status bubble, add empty placeholder for Claude's follow-up
          setMessages(prev => [
            ...prev.filter(m => !m.isToolStatus),
            { role: 'assistant', content: '' },
          ]);

          setToolRunning(false);
          setStreaming(true);

          // Non-streaming follow-up (cleaner after tool execution)
          const finalRes  = await callApi(apiHistoryRef.current, false);
          const finalJson = await finalRes.json();
          const finalText = finalJson.content?.find(b => b.type === 'text')?.text || '✅ Done!';

          setMessages(prev => {
            const next = [...prev];
            next[next.length - 1] = { role: 'assistant', content: finalText };
            return next;
          });
          apiHistoryRef.current = [...apiHistoryRef.current, {
            role: 'assistant',
            content: finalText,
          }];
        }
      }
    } catch (e) {
      setMessages(prev => {
        const next = [...prev];
        // Replace last (possibly empty) assistant bubble with error
        if (next.length > 0 && next[next.length - 1].role === 'assistant') {
          next[next.length - 1] = { role: 'assistant', content: `Sorry, I hit an error: ${e.message}` };
        } else {
          next.push({ role: 'assistant', content: `Sorry, I hit an error: ${e.message}` });
        }
        return next;
      });
    } finally {
      setStreaming(false);
      setToolRunning(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  };

  const handleClear = () => {
    setMessages([]);
    apiHistoryRef.current = [];
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <>
      {/* Floating button — above home indicator */}
      <button
        onClick={() => setOpen(o => !o)}
        title="fund-ient"
        style={{ bottom: 'calc(env(safe-area-inset-bottom) + 1.5rem)', right: '1.5rem' }}
        className={`fixed z-50 w-14 h-14 rounded-full shadow-2xl flex items-center justify-center transition-all duration-200 ${
          open
            ? 'bg-slate-600 dark:bg-slate-700 scale-95'
            : 'bg-indigo-600 hover:bg-indigo-700 hover:scale-110 shadow-indigo-300 dark:shadow-indigo-900/50'
        }`}
      >
        {open
          ? <X className="w-6 h-6 text-white" />
          : <LogoSpark size={30} />}
      </button>

      {/* Chat panel */}
      {open && (
        <div
          className="fixed z-50 w-80 sm:w-96 bg-white dark:bg-slate-800 rounded-[2rem] shadow-2xl border border-slate-100 dark:border-slate-700 flex flex-col overflow-hidden"
          style={{
            bottom: 'calc(env(safe-area-inset-bottom) + 5.5rem)',
            right: '1.5rem',
            maxHeight: 'calc(100vh - env(safe-area-inset-top) - env(safe-area-inset-bottom) - 9rem)',
          }}
        >
          {/* Header */}
          <div className="px-5 py-4 bg-indigo-600 flex items-center gap-3 flex-shrink-0">
            <div className="flex-shrink-0">
              <LogoSpark size={34} />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-black text-white tracking-tight">fund-ient</p>
              <p className="text-[10px] text-indigo-200 truncate">
                {monthName ? `Viewing ${monthName}` : 'Your budget assistant'}
              </p>
            </div>
            {messages.length > 0 && (
              <button
                onClick={handleClear}
                className="ml-auto text-indigo-200 hover:text-white text-[10px] font-bold transition-colors flex-shrink-0"
              >
                Clear
              </button>
            )}
          </div>

          {/* No API key warning */}
          {!hasKey && (
            <div className="flex-1 flex items-center justify-center p-6 text-center">
              <div className="space-y-2">
                <p className="text-2xl">🔑</p>
                <p className="text-sm font-bold text-slate-700 dark:text-slate-200">API key missing</p>
                <p className="text-xs text-slate-400 leading-relaxed">
                  Add <code className="bg-slate-100 dark:bg-slate-700 px-1 rounded text-indigo-500">VITE_ANTHROPIC_API_KEY</code> to your <code className="bg-slate-100 dark:bg-slate-700 px-1 rounded text-indigo-500">.env</code> file and restart the dev server.
                </p>
              </div>
            </div>
          )}

          {/* Messages */}
          {hasKey && (
            <>
              <div className="flex-1 overflow-y-auto p-4 space-y-3 min-h-0">

                {/* Empty state — quick prompts */}
                {messages.length === 0 && (
                  <div className="space-y-2 pt-1">
                    <p className="text-xs text-slate-400 text-center mb-3">
                      Ask me anything about your {monthName || 'current'} budget
                    </p>
                    {buildQuickPrompts({ expenses, overallRemaining, notesString, rulesData }).map((prompt, i) => (
                      <button
                        key={i}
                        onClick={() => sendMessage(prompt)}
                        disabled={isBusy}
                        className="w-full text-left text-xs px-3 py-2.5 bg-slate-50 dark:bg-slate-700/60 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 hover:text-indigo-600 dark:hover:text-indigo-400 text-slate-600 dark:text-slate-300 rounded-xl transition-colors font-medium border border-slate-100 dark:border-slate-600 disabled:opacity-50"
                      >
                        {prompt}
                      </button>
                    ))}
                  </div>
                )}

                {/* Message bubbles */}
                {messages.map((msg, i) => (
                  <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                    {msg.isToolStatus ? (
                      <div className="max-w-[85%] px-4 py-2.5 rounded-2xl text-xs bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 font-bold flex items-center gap-2">
                        <Zap className="w-3.5 h-3.5 animate-pulse flex-shrink-0" />
                        {msg.content}
                      </div>
                    ) : (
                      <div className={`max-w-[85%] px-4 py-2.5 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap ${
                        msg.role === 'user'
                          ? 'bg-indigo-600 text-white rounded-br-sm'
                          : 'bg-slate-100 dark:bg-slate-700 text-slate-800 dark:text-slate-100 rounded-bl-sm'
                      }`}>
                        {msg.content
                          ? msg.content
                          : isBusy && i === messages.length - 1
                            ? (
                              <span className="flex gap-1 items-center py-0.5">
                                <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                                <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                                <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                              </span>
                            )
                            : null
                        }
                      </div>
                    )}
                  </div>
                ))}
                <div ref={messagesEndRef} />
              </div>

              {/* Input bar */}
              <div className="p-3 border-t border-slate-100 dark:border-slate-700 flex gap-2 flex-shrink-0">
                <input
                  ref={inputRef}
                  type="text"
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={toolRunning ? 'Adding expense…' : 'Ask about your budget…'}
                  disabled={isBusy}
                  className="flex-1 bg-slate-50 dark:bg-slate-700/60 border border-slate-200 dark:border-slate-600 text-slate-900 dark:text-slate-100 rounded-xl px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500/40 placeholder:text-slate-400 disabled:opacity-50 min-w-0"
                />
                <button
                  onClick={() => sendMessage(input)}
                  disabled={!input.trim() || isBusy}
                  className="w-9 h-9 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed rounded-xl flex items-center justify-center transition-colors flex-shrink-0"
                >
                  <Send className="w-4 h-4 text-white" />
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}
