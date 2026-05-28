let _seq = 0;
function uid() { return `tx-${Date.now()}-${++_seq}`; }

function parseQifDate(str) {
  if (!str) return null;
  const s = str.trim().replace(/\s/g, '');
  // MM/DD/YYYY, MM/DD/YY, MM-DD-YYYY, MM.DD.YYYY, MM/DD'YY (Quicken apostrophe)
  const m = s.match(/^(\d{1,2})[\/\-\.'](\d{1,2})[\/\-\.'""](\d{2,4})$/);
  if (m) {
    const [, mm, dd, yr] = m;
    const yyyy = yr.length === 2 ? (parseInt(yr, 10) > 30 ? '19' : '20') + yr : yr;
    return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
  }
  // YYYY-MM-DD already ISO
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return null;
}

export function parseQIF(text, fileName = '') {
  const lines = text.split(/\r?\n/);
  const transactions = [];
  let cur = {};

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('!')) continue;

    const tag = line[0];
    const val = line.slice(1).trim();

    switch (tag) {
      case 'D': cur.date   = parseQifDate(val); break;
      case 'T': cur.amount = parseFloat(val.replace(/[$,]/g, '')); break;
      case 'U': if (cur.amount == null) cur.amount = parseFloat(val.replace(/[$,]/g, '')); break;
      case 'P': cur.payee  = val; break;
      case 'M': cur.memo   = val; break;
      case '^': {
        const amt    = cur.amount ?? 0;
        const vendor = cur.payee || cur.memo;
        if (vendor) {
          transactions.push({
            id:        uid(),
            date:      cur.date || null,
            vendor,
            rawVendor: vendor,
            amount:    Math.abs(amt),
            type:      amt < 0 ? 'purchase' : 'credit',
            bank:      'qif',
            sourceFile: fileName,
          });
        }
        cur = {};
        break;
      }
      default: break;
    }
  }

  if (transactions.length === 0)
    return { transactions: [], bank: 'qif', error: 'No transactions found in QIF file.' };
  return { transactions, bank: 'qif', error: null };
}
