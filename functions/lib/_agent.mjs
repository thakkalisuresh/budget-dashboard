/**
 * R8: transport-agnostic Claude tool-use loop for the bot's conversational
 * fallback. Raw fetch against the Anthropic Messages API (same style as
 * _extraction.mjs — no SDK). Haiku 4.5 by default: fast + cheap, which suits a
 * per-message household bot where the work is routing + lookups.
 *
 * This module only drives the loop; the caller supplies `tools` (Anthropic tool
 * schemas) and an async `execute(name, input)` that runs them. Any failure
 * (missing key, malformed response, exhausted iterations) throws, so the caller
 * can fall back to a deterministic reply — the bot never hard-depends on AI.
 */

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_URL     = 'https://api.anthropic.com/v1/messages';
const AGENT_MODEL       = process.env.BOT_AGENT_MODEL || 'claude-haiku-4-5';
const MAX_ITERS         = 4;   // hard cap on tool round-trips (webhook is 120s)

async function callClaude({ system, tools, messages }) {
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: AGENT_MODEL,
      max_tokens: 1024,
      system,
      tools,
      messages,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Agent API: ${err?.error?.message || `HTTP ${res.status}`}`);
  }
  return res.json();
}

function textFrom(content) {
  return (content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n')
    .trim();
}

/**
 * Runs the agentic loop. Returns { text, acted } where `text` is the model's
 * final assistant text and `acted` is true if any tool reported that it already
 * sent a user-facing message (so the caller can suppress a redundant reply).
 * Throws on any API/response failure.
 */
export async function runToolLoop({ userText, system, tools, execute, history = [] }) {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not configured');

  // Prior turns let a follow-up resolve what it refers to: "add walgreens 53"
  // then "actually that was on the amex" is meaningless without them. Only plain
  // text turns are carried — replaying old tool_use blocks would invite the model
  // to re-run actions that already happened.
  const messages = [
    ...history
      .filter(m => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
      .map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: userText },
  ];
  let acted = false;

  for (let iter = 0; iter < MAX_ITERS; iter++) {
    const data = await callClaude({ system, tools, messages });
    const content = data?.content;
    if (!Array.isArray(content)) throw new Error('Agent returned no content');

    if (data.stop_reason !== 'tool_use') {
      return { text: textFrom(content), acted };
    }

    // Echo the assistant turn (including tool_use blocks) back verbatim.
    messages.push({ role: 'assistant', content });

    const toolUses = content.filter(b => b.type === 'tool_use');
    const results = [];
    for (const tu of toolUses) {
      let result;
      try {
        const out = await execute(tu.name, tu.input || {});
        if (out && out.userNotified) acted = true;
        result = typeof out === 'string' ? out : (out?.result ?? 'done');
      } catch (e) {
        result = `Error: ${e.message}`;
      }
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: String(result) });
    }
    messages.push({ role: 'user', content: results });
  }

  // Ran out of iterations without a final text turn — give the model one last
  // no-tools pass so it can summarise, otherwise surface what we have.
  const finalData = await callClaude({ system, tools: [], messages });
  return { text: textFrom(finalData?.content), acted };
}
