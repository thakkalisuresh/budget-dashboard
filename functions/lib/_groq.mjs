/**
 * Shared Groq settings for categorization and extraction.
 *
 * The model ids live here, once. A hardcoded id that Groq retires fails as a
 * plain 4xx that every caller swallowed, so a dead model went unnoticed for as
 * long as the fallbacks covered for it — see reportGroqFailure below.
 *
 * Constants, not env overrides: nothing binds a model name into the functions
 * runtime, so an env read would always resolve to the default while implying
 * otherwise (same reasoning as _agent.mjs).
 *
 * Also used by _agent.mjs (tool calls) and _query.mjs (NL queries).
 */
export const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

/** Text extraction and category suggestions. A reasoning model — see groqParams. */
export const GROQ_TEXT_MODEL = 'openai/gpt-oss-120b';

/** Image extraction. */
export const GROQ_VISION_MODEL = 'qwen/qwen3.8-27b';

/**
 * Extra request fields a model needs.
 *
 * gpt-oss reasons before it answers and the reasoning tokens count against
 * max_tokens, so left alone a small budget is spent on thinking and `content`
 * comes back empty. Low effort keeps latency and cost near a plain model's.
 */
export function groqParams(model) {
  return model === GROQ_TEXT_MODEL ? { reasoning_effort: 'low' } : {};
}

/**
 * The answer text of a chat completion, or ''.
 *
 * Only `content` is the answer; a reasoning model's chain of thought arrives in
 * `message.reasoning` and must never be parsed as one. Empty content usually
 * means the token budget ran out mid-thought.
 */
export function groqContent(data) {
  const content = data?.choices?.[0]?.message?.content;
  return typeof content === 'string' ? content.trim() : '';
}

/**
 * Report a failed Groq call so it reaches the daily digest, once per distinct
 * failure per process — categorization runs on every charge, and a dead model
 * would otherwise write a digest row per charge.
 *
 * An unknown model (model_not_found, or a 400/404 naming the model) gets its
 * own code, LLM-004, since the fix is a code change rather than a retry. Rate
 * limits are transient and stay out of the digest. Never throws.
 */
const reported = new Set();
export const __resetGroqReports = () => reported.clear();

export async function reportGroqFailure(model, status, error) {
  if (status === 429) return;
  const detail = error?.message || `HTTP ${status}`;
  const gone = error?.code === 'model_not_found' || status === 404 || status === 400;
  const code = gone ? 'LLM-004' : 'LLM-001';
  const key = `${code}:${model}:${status}`;
  if (reported.has(key)) return;
  reported.add(key);
  try {
    // Loaded on demand: _error-log pulls in firebase-admin, and this module is
    // imported by pure extraction/categorization code that shouldn't need it.
    const { reportError } = await import('./_error-log.mjs');
    await reportError(code, new Error(`Groq ${model}: ${detail}`), { model, status });
  } catch { /* the reporter already swallows its own failures; belt and braces */ }
}
