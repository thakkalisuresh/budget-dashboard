/**
 * Claude API fallback for PDF statements that PDF.js can't parse.
 *
 * Two cases:
 *  1. PDF.js extracted text but found 0 transactions — send the text to Claude.
 *  2. PDF is scanned/image-based (no text) — send base64-encoded PDF to Claude
 *     using the native document type so Claude can read it visually.
 *
 * Returns the same shape as parsePdfStatement:
 *   { transactions, bank, error }
 */

const CLAUDE_PROXY = '/api/claude';

const EXTRACT_PROMPT = `Extract every debit/purchase transaction from this bank statement.
Return ONLY a JSON array — no explanation, no markdown fences.
Each item: { "date": "MM/DD/YYYY", "vendor": "Clean Vendor Name", "amount": 12.99, "type": "debit" }
Rules:
- Include ONLY debit/purchase transactions — charges where money left the account
- If a transaction has a negative amount, a minus sign, or is labeled as credit/refund/return/reversal, set "type": "credit" — do NOT include these in results
- amount is always a positive number (no $ sign)
- vendor: clean name only, no store numbers, no city/state, title case
- skip: payments, transfers, ACH, Zelle, Venmo, autopay, direct deposit, wire transfers
- if year is missing from date, omit it (use MM/DD)`;

let _seq = 0;
function uid() { return `claude-${Date.now()}-${++_seq}`; }

/**
 * Call the Claude proxy and return parsed transactions.
 * @param {object} messageContent - Anthropic messages[0].content value
 */
async function callClaude(messageContent, accessToken) {
  const headers = { 'Content-Type': 'application/json' };
  if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;
  const res = await fetch(CLAUDE_PROXY, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 4096,
      messages: [{ role: 'user', content: messageContent }],
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `Claude API error ${res.status}`);
  }

  const data = await res.json();
  const raw = data?.content?.[0]?.text || '';

  // Strip markdown fences if present
  const json = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  return JSON.parse(json);
}

/**
 * Parse a PDF using Claude as fallback.
 * @param {File} file - The PDF file
 * @param {string[]} lines - Text lines already extracted by PDF.js (may be empty)
 */
export async function parsePdfWithClaude(file, lines = [], accessToken) {
  let messageContent;

  if (lines.length > 0) {
    // Text-based PDF — send the extracted text (much cheaper than sending the PDF image).
    // SEC-10: strip angle brackets so malicious PDFs can't inject closing XML tags.
    const text = lines.join('\n').replace(/[<>]/g, '');
    messageContent = `${EXTRACT_PROMPT}\n\n<statement>\n${text}\n</statement>`;
  } else {
    // Scanned/image PDF — send as base64 document so Claude can read it visually
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const base64 = btoa(binary);

    messageContent = [
      {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: base64 },
      },
      { type: 'text', text: EXTRACT_PROMPT },
    ];
  }

  let raw = [];
  try {
    raw = await callClaude(messageContent, accessToken);
  } catch (e) {
    return { transactions: [], bank: 'unknown', error: `Claude parse failed: ${e.message}` };
  }

  if (!Array.isArray(raw)) {
    return { transactions: [], bank: 'unknown', error: 'Claude returned unexpected format' };
  }

  const transactions = raw
    .filter(t => t.vendor && typeof t.amount === 'number' && t.amount > 0 && t.type !== 'credit')
    .map(t => ({
      id: uid(),
      date: t.date || '',
      vendor: t.vendor,
      amount: t.amount,
      type: 'purchase',
      source: file.name,
    }));

  return { transactions, bank: 'claude', error: null };
}
