let _seq = 0;
function uid() { return `tx-${Date.now()}-${++_seq}`; }

function parseMT940Date(yymmdd) {
  if (!yymmdd || yymmdd.length < 6) return null;
  const yy   = parseInt(yymmdd.slice(0, 2), 10);
  const yyyy = yy > 50 ? `19${yymmdd.slice(0, 2)}` : `20${yymmdd.slice(0, 2)}`;
  return `${yyyy}-${yymmdd.slice(2, 4)}-${yymmdd.slice(4, 6)}`;
}

export function parseMT940(text, fileName = '') {
  const lines       = text.split(/\r?\n/);
  const transactions = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith(':61:')) continue;

    // :61: format: YYMMDD[MMDD][C/D][R]Amount[N]TRCDRef//BankRef
    const body     = line.slice(4);
    const dcMatch  = body.match(/^(\d{6})(?:\d{4})?([CD]R?)/);
    if (!dcMatch) continue;

    const dateStr  = dcMatch[1];
    const dc       = dcMatch[2][0]; // C or D
    const rest     = body.slice(dcMatch[0].length);
    const amtMatch = rest.match(/^([\d,]+)/);
    if (!amtMatch) continue;

    const amount = parseFloat(amtMatch[1].replace(',', '.'));

    // :86: description on the next line(s)
    let vendor = 'Unknown';
    if (i + 1 < lines.length && lines[i + 1].trim().startsWith(':86:')) {
      i++;
      vendor = lines[i].trim().slice(4).trim() || 'Unknown';
      // Some banks continue :86: across multiple lines (no tag prefix)
      while (i + 1 < lines.length && lines[i + 1].trim() &&
             !lines[i + 1].trim().match(/^:\d{2}[A-Z]?:/)) {
        i++;
        vendor += ' ' + lines[i].trim();
      }
      vendor = vendor.trim();
    }

    transactions.push({
      id:        uid(),
      date:      parseMT940Date(dateStr),
      vendor,
      rawVendor: vendor,
      amount,
      type:      dc === 'D' ? 'purchase' : 'credit',
      bank:      'mt940',
      sourceFile: fileName,
    });
  }

  if (transactions.length === 0)
    return { transactions: [], bank: 'mt940', error: 'No transactions found in MT940 file.' };
  return { transactions, bank: 'mt940', error: null };
}
