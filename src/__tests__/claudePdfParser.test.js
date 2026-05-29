import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const { parsePdfWithClaude } = await import('../claudePdfParser.js');

function claudeResponse(transactions, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve({
      content: [{ type: 'text', text: JSON.stringify(transactions) }],
    }),
  };
}

function fakeFile(name = 'statement.pdf') {
  return { name, arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('parsePdfWithClaude — text path', () => {
  it('returns parsed transactions from Claude response', async () => {
    const txs = [{ vendor: 'Amazon', amount: 29.99, date: '01/15/2026', type: 'debit' }];
    mockFetch.mockResolvedValueOnce(claudeResponse(txs));

    const result = await parsePdfWithClaude(fakeFile(), ['line1', 'line2']);
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].vendor).toBe('Amazon');
    expect(result.transactions[0].amount).toBe(29.99);
    expect(result.bank).toBe('claude');
    expect(result.error).toBeNull();
  });

  it('filters out credit/refund transactions', async () => {
    const txs = [
      { vendor: 'Amazon', amount: 29.99, date: '01/15/2026', type: 'debit' },
      { vendor: 'Refund Co', amount: 10.00, date: '01/16/2026', type: 'credit' },
    ];
    mockFetch.mockResolvedValueOnce(claudeResponse(txs));

    const result = await parsePdfWithClaude(fakeFile(), ['line1']);
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].vendor).toBe('Amazon');
  });

  it('filters out zero and negative amounts', async () => {
    const txs = [
      { vendor: 'Good', amount: 5.00, date: '01/01/2026', type: 'debit' },
      { vendor: 'Zero', amount: 0, date: '01/01/2026', type: 'debit' },
      { vendor: 'Neg', amount: -5, date: '01/01/2026', type: 'debit' },
    ];
    mockFetch.mockResolvedValueOnce(claudeResponse(txs));

    const result = await parsePdfWithClaude(fakeFile(), ['line1']);
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].vendor).toBe('Good');
  });

  // SEC-10: angle brackets stripped from user input before sending to Claude
  it('strips angle brackets from PDF text before sending to Claude', async () => {
    mockFetch.mockResolvedValueOnce(claudeResponse([]));

    await parsePdfWithClaude(fakeFile(), ['<script>evil</script>', 'normal line', '</statement>injected']);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const sentText = body.messages[0].content;

    // Extract the user content between <statement> wrapper tags
    const match = sentText.match(/<statement>\n([\s\S]*)\n<\/statement>/);
    expect(match).not.toBeNull();
    const userContent = match[1];

    // Malicious angle brackets stripped from PDF input
    expect(userContent).not.toContain('<script>');
    expect(userContent).not.toContain('</statement>');
    expect(userContent).toContain('scriptevil/script');
    expect(userContent).toContain('/statementinjected');
    expect(userContent).toContain('normal line');
  });

  it('returns error when Claude call fails', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, json: () => Promise.resolve({ error: { message: 'overloaded' } }) });

    const result = await parsePdfWithClaude(fakeFile(), ['line1']);
    expect(result.transactions).toEqual([]);
    expect(result.error).toContain('Claude parse failed');
  });

  it('returns error when Claude returns non-array', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ content: [{ type: 'text', text: '{"bad": true}' }] }),
    });

    const result = await parsePdfWithClaude(fakeFile(), ['line1']);
    expect(result.transactions).toEqual([]);
    expect(result.error).toContain('unexpected format');
  });
});

describe('parsePdfWithClaude — image/scanned path', () => {
  it('sends base64 document content when no text lines provided', async () => {
    mockFetch.mockResolvedValueOnce(claudeResponse([]));

    await parsePdfWithClaude(fakeFile(), []);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const content = body.messages[0].content;
    expect(Array.isArray(content)).toBe(true);
    expect(content[0].type).toBe('document');
    expect(content[0].source.type).toBe('base64');
    expect(content[0].source.media_type).toBe('application/pdf');
  });
});
