import { describe, it, expect } from 'vitest';
import {
  msgWritten, msgWrittenDuplicate, msgNeedsCategory, msgSplitParked, msgDuplicateSkipped,
  tgCategoryPrompt, tgDuplicateNote, msgConvertFailed, tgConvertFailed, fxNote, money,
} from '../../functions/lib/_wallet-messages.mjs';

const fx = { original: 16, currency: 'EUR', rate: 0.873 };

describe('wallet messages — foreign currency', () => {
  it('formats native amounts with a symbol where there is one, else the code', () => {
    expect(money(16, 'EUR')).toBe('€16.00');
    expect(money(12.5, 'GBP')).toBe('£12.50');
    expect(money(1000, 'INR')).toBe('₹1000.00');
    expect(money(16, 'CHF')).toBe('16.00 CHF');
  });

  it('fxNote is empty without conversion data', () => {
    expect(fxNote(undefined)).toBe('');
    expect(fxNote(null)).toBe('');
    expect(fxNote(fx)).toBe(' (€16.00 converted at 0.873)');
  });

  it('every builder is byte-identical without fx', () => {
    expect(msgWritten({ amount: 18.33, vendor: 'V', card: 'C', category: 'Misc', monthName: 'September 2026' }))
      .toBe('✅ $18.33 at V on C → Misc. Added to your September 2026 budget in Fundient.');
    expect(msgSplitParked({ amount: 5, vendor: 'V' })).toBe('🧾 $5.00 at V — upload the receipt on Telegram to split it, or SKIP to log as one.');
  });

  it('every builder shows the conversion when fx is passed', () => {
    const a = { amount: 18.33, vendor: 'V', fx };
    expect(msgWritten({ ...a, card: 'C', category: 'Misc', monthName: 'September 2026' }))
      .toBe('✅ $18.33 at V (€16.00 converted at 0.873) on C → Misc. Added to your September 2026 budget in Fundient.');
    expect(msgWrittenDuplicate({ ...a, category: 'Misc', monthName: 'September 2026', notified: true })).toContain('$18.33 at V (€16.00 converted at 0.873) → Misc');
    expect(msgNeedsCategory({ ...a, monthName: 'September 2026' })).toContain('$18.33 at V (€16.00 converted at 0.873) —');
    expect(msgSplitParked(a)).toContain('$18.33 at V (€16.00 converted at 0.873) —');
    expect(msgDuplicateSkipped(a)).toContain('$18.33 at V (€16.00 converted at 0.873) looks like');
    expect(tgCategoryPrompt({ ...a, card: 'C', monthName: 'September 2026', suggested: 'Misc' })).toContain('V · $18.33 (€16.00 converted at 0.873) · C · Sep 2026');
    expect(tgDuplicateNote({ ...a, card: 'C', monthName: 'September 2026' })).toContain('V · $18.33 (€16.00 converted at 0.873) · C · Sep 2026');
  });

  it('failure copy', () => {
    expect(msgConvertFailed({ original: 16, currency: 'EUR' })).toBe("⚠️ Couldn't convert €16.00 to dollars — nothing was logged. Add it by hand.");
    expect(tgConvertFailed({ original: 16, currency: 'EUR', vendor: 'Xt' })).toBe("⚠️ Couldn't convert €16.00 at Xt to dollars — not logged. Add it by hand.");
  });
});
