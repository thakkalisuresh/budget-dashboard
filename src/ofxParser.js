let _seq = 0;
function uid() { return `tx-${Date.now()}-${++_seq}`; }

function parseOFXDate(str) {
  if (!str) return null;
  const m = str.match(/^(\d{4})(\d{2})(\d{2})/);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function getField(block, tag) {
  const re = new RegExp(`<${tag}>([^<\n\r]+)`, 'i');
  return (block.match(re)?.[1] || '').trim();
}

function extractBlocks(text) {
  // OFX 2.x — proper XML with closing tags
  const xmlBlocks = [];
  const xmlRe = /<STMTTRN>([\s\S]*?)<\/STMTTRN>/gi;
  let m;
  while ((m = xmlRe.exec(text)) !== null) xmlBlocks.push(m[1]);
  if (xmlBlocks.length > 0) return xmlBlocks;

  // OFX 1.x — SGML without closing tags; split on opening tag
  return text.split(/<STMTTRN>/i).slice(1).map(chunk =>
    chunk.split(/<(?:\/STMTTRN|STMTTRN|BANKTRANLIST|STMTRS|OFX)>/i)[0]
  );
}

export function parseOFX(text, fileName = '') {
  try {
    const blocks = extractBlocks(text);
    const transactions = [];

    for (const block of blocks) {
      const rawAmt = parseFloat(getField(block, 'TRNAMT') || '0');
      if (rawAmt === 0 && !getField(block, 'NAME') && !getField(block, 'MEMO')) continue;

      const trnType = getField(block, 'TRNTYPE').toUpperCase();
      const vendor  = getField(block, 'NAME') || getField(block, 'MEMO') || 'Unknown';

      transactions.push({
        id:        uid(),
        date:      parseOFXDate(getField(block, 'DTPOSTED') || getField(block, 'DTUSER')),
        vendor,
        rawVendor: vendor,
        amount:    Math.abs(rawAmt),
        type:      (trnType === 'CREDIT' || rawAmt > 0) ? 'credit' : 'purchase',
        bank:      'ofx',
        sourceFile: fileName,
      });
    }

    if (transactions.length === 0)
      return { transactions: [], bank: 'ofx', error: 'No transactions found in OFX file.' };
    return { transactions, bank: 'ofx', error: null };
  } catch (e) {
    return { transactions: [], bank: 'ofx', error: `Failed to parse OFX: ${e.message}` };
  }
}
