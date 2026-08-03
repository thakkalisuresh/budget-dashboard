import React, { useState, useEffect, useRef } from 'react';
import { X, Edit2, Check, Trash2, AlertTriangle, MessageSquare, Repeat, CalendarX, Plus, CreditCard, ChevronRight, ChevronDown, FolderInput } from 'lucide-react';
import { updateVendorName, updateVendorAmounts, updateTransactionDate, unmarkNonMonthly, renameNonMonthly, markNonMonthly, formatTxDate, todayIso, updatePaymentMethod, updateHistoryPaymentMethod, moveTransactionCategory } from './sheetsApi.js';
import { CategoryPickerSheet } from './CategoryPickerSheet.jsx';
import { findHighlightTarget, uuidSelector } from './txHighlight.js';
import { txNoteKey } from './transactionNotes.js';
import { relearnMovedSplit } from './sheetItemMemory.js';
import { isRecurring } from './recurringExpenses.js';

// ── Vendor logo helpers ───────────────────────────────────────────────────────

/** Common vendor name → domain mappings */
const VENDOR_DOMAINS = {
  'walmart':        'walmart.com',
  'safeway':        'safeway.com',
  'whole foods':    'wholefoodsmarket.com',
  'wfm':            'wholefoodsmarket.com',
  'costco':         'costco.com',
  'target':         'target.com',
  'amazon':         'amazon.com',
  'amazon prime':   'amazon.com',
  'netflix':        'netflix.com',
  'spotify':        'spotify.com',
  'walgreens':      'walgreens.com',
  'cvs':            'cvs.com',
  'trader joe':     'traderjoes.com',
  'kroger':         'kroger.com',
  'instacart':      'instacart.com',
  'doordash':       'doordash.com',
  'uber':           'uber.com',
  'lyft':           'lyft.com',
  'airbnb':         'airbnb.com',
  'delta':          'delta.com',
  'southwest':      'southwest.com',
  'chipotle':       'chipotle.com',
  'starbucks':      'starbucks.com',
  'mcdonald':       'mcdonalds.com',
  'comcast':        'comcast.com',
  'at&t':           'att.com',
  'verizon':        'verizon.com',
  'pg&e':           'pge.com',
  'robinhood':      'robinhood.com',
  'apple':          'apple.com',
  'google':         'google.com',
  'microsoft':      'microsoft.com',
  'ikea':           'ikea.com',
  'wayfair':        'wayfair.com',
  'mayuri':         'mayurifoods.com',
  'yellow cab':     'yellowcab.com',
  'seattle yellow': 'yellowcab.com',
};

function vendorDomain(name) {
  if (!name) return null;
  const lower = name.toLowerCase().trim();
  for (const [key, domain] of Object.entries(VENDOR_DOMAINS)) {
    if (lower.includes(key)) return domain;
  }
  return null;
}

const CUSTOM_VENDOR_DOMAINS_KEY = 'budget_vendor_domains';

function getCustomVendorDomains() {
  try { return JSON.parse(localStorage.getItem(CUSTOM_VENDOR_DOMAINS_KEY) || '{}'); } catch { return {}; }
}

function setCustomVendorDomain(vendorName, domain) {
  const map = getCustomVendorDomains();
  map[vendorName.toLowerCase()] = domain;
  localStorage.setItem(CUSTOM_VENDOR_DOMAINS_KEY, JSON.stringify(map));
}

function resolveVendorDomain(name) {
  if (!name) return null;
  const lower = name.toLowerCase().trim();
  // Check custom overrides first
  const custom = getCustomVendorDomains();
  if (custom[lower]) return custom[lower];
  // Fall back to built-in map
  return vendorDomain(name);
}

/**
 * Favicon URL for a domain. Uses Google's gstatic faviconV2 endpoint — the
 * older www.google.com/s2/favicons path now 301-redirects to HTML, so <img>
 * loads from it fail. faviconV2 returns a real PNG (and honours the size).
 */
function faviconUrl(domain, size = 64) {
  return `https://t3.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=https://${domain}&size=${size}`;
}

function VendorLogo({ name, size = 22, onEditDomain }) {
  const [failed, setFailed] = useState(false);
  const domain = resolveVendorDomain(name);
  const letter = (name || '?')[0].toUpperCase();

  const AVATAR_COLORS = [
    'oklch(60% 0.19 265)', // indigo
    'oklch(68% 0.17 162)', // emerald
    'oklch(76% 0.16 75)',  // amber
    'oklch(60% 0.22 25)',  // rose
    'oklch(62% 0.20 295)', // violet
    'oklch(66% 0.17 220)', // sky
  ];
  const avatar = (
    <div
      onClick={onEditDomain}
      className="rounded-lg flex items-center justify-center text-white font-black flex-shrink-0 cursor-pointer hover:opacity-80 transition-opacity"
      style={{ width: size, height: size, fontSize: size * 0.5, background: AVATAR_COLORS[letter.charCodeAt(0) % 6] }}
      title="Tap to set vendor logo"
    >
      {letter}
    </div>
  );

  if (!domain || failed) return avatar;

  return (
    <img
      src={faviconUrl(domain)}
      alt={name}
      onError={() => setFailed(true)}
      onClick={onEditDomain}
      className="rounded-md object-contain flex-shrink-0 cursor-pointer hover:opacity-80 transition-opacity"
      style={{ width: size, height: size }}
      title="Tap to change vendor logo"
    />
  );
}

/**
 * rows: Array of { rowIndex, description, amounts: number[] }
 */
export function DetailPanel({ expense, rows, loading, onClose, accessToken, sheetId, onRefresh, currencySymbol = '$', onVendorRenamed, monthName, transactionNotes = {}, onUpdateNote, nonMonthlyVendors = [], onNonMonthlyChanged, onAddExpense, onAddForVendor, highlight = null, recurringExpenses = [], onToggleRecurring, cards = [], userId = '' }) {
  const total = rows ? rows.reduce((s, r) => s + r.amounts.reduce((a, b) => a + b, 0), 0) : 0;
  // Scroll container, so the arrive-from-ledger highlight can find its row.
  const listRef = useRef(null);

  // Editing state
  const [editingVendor, setEditingVendor]   = useState(null);
  const [editingAmount, setEditingAmount]   = useState(null);
  const [deletingVendor, setDeletingVendor] = useState(null);
  const [saving, setSaving]                 = useState(false);
  const [error, setError]                   = useState('');
  const [editingDomain, setEditingDomain]   = useState(null);
  const [, forceLogoRefresh]               = useState(0);
  // Card edit state
  const [editingCardRow, setEditingCardRow] = useState(null); // { rowIndex, uuid }
  const [cardDraft, setCardDraft]           = useState('');
  // Transaction-level note dialog
  const [noteDialog, setNoteDialog]         = useState(null); // { key, vendor, amount, data }
  const [noteDraft, setNoteDraft]           = useState({ note: '', tags: [] });
  const [noteTagInput, setNoteTagInput]     = useState('');
  // Vendor grouping (display-only): collapse same-vendor transactions into one card
  const [openVendor, setOpenVendor]         = useState(null); // expanded group key
  const [editingGroup, setEditingGroup]     = useState(null); // { key, value }
  const [deletingGroup, setDeletingGroup]   = useState(null); // group key pending delete
  const [editingDate, setEditingDate]       = useState(null); // { rowIndex, value }
  // Move-to-category picker: { members: [row, …], vendor, subtitle }
  const [movingTx, setMovingTx]             = useState(null);

  // Shared with the ledger and the split flow so the three can't drift — a note
  // written under a key nothing reads back is invisible, not broken.
  const noteKeyFor = (vendor, amt) => txNoteKey(sheetId, expense, vendor, amt);

  const openNoteDialog = (vendor, amt) => {
    const key  = noteKeyFor(vendor, amt);
    const data = transactionNotes[key] || { note: '', tags: [] };
    setNoteDraft({ ...data });
    setNoteTagInput('');
    setNoteDialog({ key, vendor, amount: amt, data });
  };

  const saveNoteDialog = () => {
    if (!noteDialog) return;
    onUpdateNote?.(noteDialog.key, { ...noteDraft });
    setNoteDialog(null);
  };

  const deleteNoteDialog = () => {
    if (!noteDialog) return;
    onUpdateNote?.(noteDialog.key, { note: '', tags: [] });
    setNoteDialog(null);
  };

  const addNoteTag = () => {
    const tag = noteTagInput.trim().replace(/^#/, '');
    if (tag && !noteDraft.tags.includes(tag)) setNoteDraft(d => ({ ...d, tags: [...d.tags, tag] }));
    setNoteTagInput('');
  };

  const inputCls = "rounded-xl px-3 py-1.5 text-sm outline-none w-full";
  const inputStyle = { background: 'var(--sur-5)', border: '1px solid var(--sur-15)', color: 'var(--color-text)' };

  const withSave = async (fn) => {
    setSaving(true);
    setError('');
    try {
      await fn();
      onRefresh?.();
    } catch (e) {
      setError(e.message || 'Failed to save. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  // ── Vendor name + date edit ──────────────────────────────────────────────
  const saveVendorName = (row) => {
    const newName       = editingVendor?.value?.trim();
    const wasNonMonthly = editingVendor?.wasNonMonthly ?? false;
    const isNonMonthly  = editingVendor?.isNonMonthly  ?? false;
    if (!newName) { setEditingVendor(null); return; }
    withSave(async () => {
      if (newName !== row.description) {
        await updateVendorName(expense, row.rowIndex, newName, accessToken, sheetId, row.description, row._v2);
        await renameNonMonthly(sheetId, accessToken, row.description, newName);
        onVendorRenamed?.(row.description, newName);
      }
      if (row._v2 && editingVendor?.date !== undefined && editingVendor.date !== row.date) {
        await updateTransactionDate(expense, row.rowIndex, editingVendor.date, accessToken, sheetId);
      }
      if (isNonMonthly !== wasNonMonthly) {
        const total = row.amounts.reduce((a, b) => a + b, 0);
        if (isNonMonthly) await markNonMonthly(sheetId, accessToken, newName, total);
        else              await unmarkNonMonthly(sheetId, accessToken, newName);
        onNonMonthlyChanged?.();
      }
      setEditingVendor(null);
    });
  };

  // ── Amount edit ─────────────────────────────────────────────────────────
  const saveAmount = (row) => {
    const newVal = parseFloat(editingAmount?.value);
    if (isNaN(newVal) || newVal <= 0) { setEditingAmount(null); return; }
    withSave(async () => {
      const newAmounts = row.amounts.map((a, i) =>
        i === editingAmount.amtIndex ? newVal : a
      );
      const prevTotal = row.amounts.reduce((a, b) => a + b, 0);
      await updateVendorAmounts(expense, row.rowIndex, newAmounts, accessToken, sheetId, row.description, prevTotal, row.uuids || [], row._v2);
      setEditingAmount(null);
    });
  };

  // ── Amount delete (single transaction) ─────────────────────────────────
  const deleteAmount = (row, amtIndex) => {
    if (!window.confirm(
      row.amounts.length === 1
        ? `Delete this transaction and clear the "${row.description}" row entirely?`
        : `Remove ${currencySymbol}${row.amounts[amtIndex].toFixed(2)} from "${row.description}"?`
    )) return;
    withSave(async () => {
      const newAmounts = row.amounts.filter((_, i) => i !== amtIndex);
      const newUuids   = (row.uuids || []).filter((_, i) => i !== amtIndex);
      const prevTotal  = row.amounts.reduce((a, b) => a + b, 0);
      await updateVendorAmounts(expense, row.rowIndex, newAmounts, accessToken, sheetId, row.description, prevTotal, newUuids, row._v2);
      if (newAmounts.length === 0) await unmarkNonMonthly(sheetId, accessToken, row.description);
    });
  };

  // ── Delete entire vendor (all transactions) ─────────────────────────────
  const deleteAllAmounts = (row) => {
    withSave(async () => {
      const prevTotal = row.amounts.reduce((a, b) => a + b, 0);
      await updateVendorAmounts(expense, row.rowIndex, [], accessToken, sheetId, row.description, prevTotal, [], row._v2);
      await unmarkNonMonthly(sheetId, accessToken, row.description);
      setDeletingVendor(null);
    });
  };

  // ── Vendor grouping (display-only) ───────────────────────────────────────
  // Collapse multiple same-vendor sheet rows into one collapsible card. Each
  // member keeps its own rowIndex/uuids, so all per-transaction writes are
  // unchanged. Single-member groups render exactly like before (renderExpenseCard).
  const groups = Object.values(
    (rows || []).reduce((acc, row) => {
      const key = (row.description || '').trim().toLowerCase();
      (acc[key] ||= { vendor: row.description, key, members: [] }).members.push(row);
      return acc;
    }, {})
  );
  const groupTotal = (g) => g.members.reduce((s, r) => s + r.amounts.reduce((a, b) => a + b, 0), 0);

  // ── Arrive-from-ledger highlight ──────────────────────────────────────────
  // Tapping a ledger row opens this panel pointed at one transaction. Expand its
  // vendor group if collapsed, scroll it into view and flash it — otherwise a
  // search result drops you at the top of a long list with no clue which row you
  // came for.
  useEffect(() => {
    if (!highlight?.uuid && !highlight?.vendor) return;
    if (loading || !rows?.length) return;

    const owner = findHighlightTarget(groups, highlight);
    if (!owner) return;

    let scrollTimer;
    // Deferred rather than run inline: expanding is a state update, and the
    // scroll needs the expanded rows laid out before it can measure anything.
    const expandTimer = setTimeout(() => {
      if (owner.members.length > 1) setOpenVendor(owner.key);
      scrollTimer = setTimeout(() => {
        const uuid = highlight.uuid
          || (owner.members.flatMap(m => m.uuids || []).filter(Boolean)[0]);
        const el = uuid ? listRef.current?.querySelector(uuidSelector(uuid)) : null;
        if (!el) return;
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        el.classList.add('tx-flash');
        // Removing the class lets a second arrival re-trigger the animation.
        scrollTimer = setTimeout(() => el.classList.remove('tx-flash'), 1600);
      }, 60);
    }, 0);

    return () => { clearTimeout(expandTimer); clearTimeout(scrollTimer); };
    // `groups` is derived from rows each render; depending on rows is equivalent
    // and avoids re-running the scroll on every unrelated re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlight?.uuid, highlight?.vendor, highlight?.amount, loading, rows]);

  const isVendorNonMonthly = (name) => nonMonthlyVendors.includes((name || '').toLowerCase());
  const isVendorRecurring  = (name) => isRecurring(recurringExpenses, expense, name);

  // Recurring is a property of the VENDOR, not of one month's charge: the
  // template list is keyed (category, vendor) with no per-transaction identity.
  // So the toggle sits on the vendor header, where the one-time flag already is.
  const toggleRecurring = (vendorName, amount, txDate) => {
    onToggleRecurring?.({
      category: expense,
      vendor: vendorName,
      amount,
      // Carried so imports land on the right day with the right card instead of
      // always the 1st with no card.
      dayOfMonth: /^\d{4}-\d{2}-(\d{2})/.exec(txDate || '')?.[1] ? Number(/^\d{4}-\d{2}-(\d{2})/.exec(txDate)[1]) : undefined,
      card: (rows || []).find(r => r.description === vendorName)?.paymentMethod || '',
      on: !isVendorRecurring(vendorName),
    });
  };

  // Rename a whole vendor group → fan out across every member row.
  const saveGroupName = (g) => {
    const newName = editingGroup?.value?.trim();
    if (!newName) { setEditingGroup(null); return; }
    withSave(async () => {
      if (newName !== g.vendor) {
        for (const m of g.members) {
          await updateVendorName(expense, m.rowIndex, newName, accessToken, sheetId, m.description, m._v2);
        }
        await renameNonMonthly(sheetId, accessToken, g.vendor, newName);
        onVendorRenamed?.(g.vendor, newName);
      }
      setEditingGroup(null);
    });
  };

  // Delete every transaction for a vendor group.
  const deleteGroup = (g) => {
    withSave(async () => {
      for (const m of g.members) {
        const prevTotal = m.amounts.reduce((a, b) => a + b, 0);
        await updateVendorAmounts(expense, m.rowIndex, [], accessToken, sheetId, m.description, prevTotal, [], m._v2);
      }
      await unmarkNonMonthly(sheetId, accessToken, g.vendor);
      setDeletingGroup(null);
    });
  };

  // Move transaction(s) to another category (sheet tab). members: 1 row for a
  // single transaction, or every row of a vendor group.
  const doMove = (targetCategory) => {
    const mv = movingTx;
    if (!mv) return;
    withSave(async () => {
      for (const m of mv.members) {
        await moveTransactionCategory(expense, targetCategory, m, accessToken, sheetId, monthName, null);
      }
      relearnMovedTransaction(mv, targetCategory);
      setMovingTx(null);
    });
  };

  // A moved transaction that came from a split receipt carries a splitId in its
  // note. Re-teach every line item behind it, and carry the note across to the
  // new category — the note is keyed by category, so leaving it behind would
  // both lose the item list and orphan the splitId, making a second move
  // unteachable. Best-effort throughout: the move itself has already succeeded.
  const relearnMovedTransaction = (mv, targetCategory) => {
    for (const m of mv.members) {
      for (const amt of m.amounts) {
        const oldKey = noteKeyFor(mv.vendor, amt);
        const data = transactionNotes[oldKey];
        if (!data?.splitId) continue;
        relearnMovedSplit({
          userId, accessToken,
          splitId: data.splitId,
          fromCategory: expense,
          toCategory: targetCategory,
        }).catch(() => {});
        onUpdateNote?.(txNoteKey(sheetId, targetCategory, mv.vendor, amt), data);
        onUpdateNote?.(oldKey, { note: '', tags: [] });
      }
    }
  };

  const openMoveFor = (members, vendor) => {
    const total = members.reduce((s, r) => s + r.amounts.reduce((a, b) => a + b, 0), 0);
    const count = members.reduce((s, r) => s + r.amounts.length, 0);
    setMovingTx({
      members,
      vendor,
      subtitle: `${count > 1 ? `${count} transactions · ` : ''}${currencySymbol}${total.toFixed(2)}`,
    });
  };

  // Toggle one-time/non-monthly flag for a whole vendor group.
  const toggleGroupNonMonthly = (g) => {
    const isNm = isVendorNonMonthly(g.vendor);
    withSave(async () => {
      if (isNm) await unmarkNonMonthly(sheetId, accessToken, g.vendor);
      else      await markNonMonthly(sheetId, accessToken, g.vendor, groupTotal(g));
      onNonMonthlyChanged?.();
    });
  };

  // Edit a single transaction's date (member row inside a group).
  const saveDate = (row) => {
    const newDate = editingDate?.value;
    withSave(async () => {
      if (newDate && newDate !== row.date) {
        await updateTransactionDate(expense, row.rowIndex, newDate, accessToken, sheetId);
      }
      setEditingDate(null);
    });
  };

  // ── Card badge / inline editor for a single transaction (shared by group members) ──
  const renderCardCell = (row) => {
    if (!row._v2 || cards.length === 0) {
      return row.paymentMethod ? (
        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full"
          style={{ background: 'var(--color-accent-subtle)', color: 'var(--color-accent-text)', border: '1px solid var(--color-accent-border)' }}>
          💳 {row.paymentMethod}
        </span>
      ) : null;
    }
    if (editingCardRow?.rowIndex === row.rowIndex) {
      return (
        <div className="flex items-center gap-1">
          <select autoFocus value={cardDraft} onChange={e => setCardDraft(e.target.value)}
            className="text-[10px] font-bold rounded-lg px-1.5 py-0.5 outline-none"
            style={{ background: 'var(--color-surface)', border: '1px solid var(--sur-20)', color: 'var(--color-text)' }}>
            <option value="">— Remove card —</option>
            {cards.filter(c => !c.toLowerCase().includes('debit') && !c.toLowerCase().includes('bank') && c.toLowerCase() !== 'cash').map(c => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <button onClick={() => withSave(async () => {
              const uuid = row.uuids?.[0] || '';
              await updatePaymentMethod(expense, row.rowIndex, cardDraft, accessToken, sheetId);
              if (uuid) await updateHistoryPaymentMethod(sheetId, accessToken, uuid, cardDraft);
              setEditingCardRow(null); onRefresh?.();
            })} disabled={saving}
            className="p-0.5 rounded text-white disabled:opacity-40 transition-colors" style={{ background: 'var(--color-accent)' }}>
            <Check className="w-3 h-3" />
          </button>
          <button onClick={() => setEditingCardRow(null)} className="p-0.5 rounded transition-colors" style={{ color: 'var(--color-text-muted)' }}>
            <X className="w-3 h-3" />
          </button>
        </div>
      );
    }
    return (
      <div className="flex items-center gap-1">
        {row.paymentMethod ? (
          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full"
            style={{ background: 'var(--color-accent-subtle)', color: 'var(--color-accent-text)', border: '1px solid var(--color-accent-border)' }}>
            💳 {row.paymentMethod}
          </span>
        ) : (
          <span className="text-[10px] italic" style={{ color: 'var(--color-text-muted)', opacity: 0.5 }}>No card</span>
        )}
        <button onClick={() => { setEditingCardRow({ rowIndex: row.rowIndex, uuid: row.uuids?.[0] || '' }); setCardDraft(row.paymentMethod || ''); }}
          className="p-0.5 rounded transition-colors" title="Edit card" style={{ color: 'var(--color-text-muted)' }}>
          <CreditCard className="w-3 h-3" />
        </button>
      </div>
    );
  };

  // ── One transaction line inside an expanded vendor group ──
  const renderMemberRow = (row) => {
    const subtotal = row.amounts.reduce((a, b) => a + b, 0);
    const single   = row.amounts.length === 1;
    return (
      <div key={row.rowIndex} style={{ borderTop: '1px solid var(--sur-6)' }}>
        <div className="flex items-center gap-2 px-4 py-2 group hover:bg-[var(--sur-5)] transition-colors">
          {/* Date */}
          {editingDate?.rowIndex === row.rowIndex ? (
            <>
              <input type="date" value={editingDate.value}
                onChange={e => setEditingDate(ed => ({ ...ed, value: e.target.value }))}
                className="rounded-lg px-2 py-1 text-xs outline-none" style={inputStyle} autoFocus disabled={saving} />
              <button onClick={() => saveDate(row)} disabled={saving} className="p-1 rounded-lg flex-shrink-0" style={{ color: 'var(--color-success)' }}>
                <Check className="w-3.5 h-3.5" />
              </button>
              <button onClick={() => setEditingDate(null)} className="p-1 rounded-lg flex-shrink-0" style={{ color: 'var(--color-text-muted)' }}>
                <X className="w-3.5 h-3.5" />
              </button>
            </>
          ) : (
            <button onClick={() => setEditingDate({ rowIndex: row.rowIndex, value: row.date || todayIso() })}
              className="text-[11px] font-bold flex-shrink-0"
              style={{ color: row.date ? 'var(--color-text-muted)' : 'var(--color-accent-text)' }}>
              {row.date ? formatTxDate(row.date) : '— add date'}
            </button>
          )}
          {/* Card */}
          <div className="min-w-0">{renderCardCell(row)}</div>
          <div className="flex-1" />
          {/* Amount + actions (single-amount fast path) */}
          {single && editingAmount?.rowIndex === row.rowIndex && editingAmount?.amtIndex === 0 ? (
            <>
              <span className="text-sm" style={{ color: 'var(--color-text-muted)' }}>{currencySymbol}</span>
              <input type="number" step="0.01" min="0.01" className={`${inputCls} w-24`} style={inputStyle}
                value={editingAmount.value}
                onChange={e => setEditingAmount(ea => ({ ...ea, value: e.target.value }))}
                onKeyDown={e => e.key === 'Enter' && saveAmount(row)} autoFocus disabled={saving} />
              <button onClick={() => saveAmount(row)} disabled={saving} className="p-1 rounded-lg flex-shrink-0" style={{ color: 'var(--color-success)' }}>
                <Check className="w-3.5 h-3.5" />
              </button>
              <button onClick={() => setEditingAmount(null)} className="p-1 rounded-lg flex-shrink-0" style={{ color: 'var(--color-text-muted)' }}>
                <X className="w-3.5 h-3.5" />
              </button>
            </>
          ) : (
            <>
              <span className="text-sm font-black tabular-nums" style={{ color: 'var(--color-text)' }}>
                {currencySymbol}{subtotal.toFixed(2)}
              </span>
              {single && (
                <div className="flex gap-0.5 items-center opacity-0 group-hover:opacity-100 transition-opacity">
                  {(() => {
                    const key = noteKeyFor(row.description, row.amounts[0]);
                    const data = transactionNotes[key];
                    const has = data?.note || data?.tags?.length > 0;
                    return (
                      <button onClick={() => openNoteDialog(row.description, row.amounts[0])}
                        className="p-1 rounded-lg transition-colors"
                        style={{ color: has ? 'var(--color-accent-text)' : 'var(--color-text-muted)' }}
                        title={has ? 'View/edit note' : 'Add note / tag'}>
                        <MessageSquare className="w-3.5 h-3.5" />
                      </button>
                    );
                  })()}
                  <button onClick={() => openMoveFor([row], row.description)}
                    className="p-1 rounded-lg transition-colors hover:bg-[var(--sur-5)]" style={{ color: 'var(--color-text-muted)' }} title="Move to another category">
                    <FolderInput className="w-3.5 h-3.5" />
                  </button>
                  <button onClick={() => setEditingAmount({ rowIndex: row.rowIndex, amtIndex: 0, value: String(row.amounts[0]) })}
                    className="p-1 rounded-lg transition-colors hover:bg-[var(--sur-5)]" style={{ color: 'var(--color-text-muted)' }} title="Edit amount">
                    <Edit2 className="w-3.5 h-3.5" />
                  </button>
                  <button onClick={() => deleteAmount(row, 0)}
                    className="p-1 rounded-lg transition-colors hover:bg-[var(--sur-5)]" style={{ color: 'var(--color-text-muted)' }} title="Delete transaction">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
            </>
          )}
        </div>
        {/* Defensive: members with >1 amount (rare) list each amount with actions */}
        {!single && row.amounts.map((amt, amtIndex) => (
          <div key={amtIndex} className="flex items-center gap-2 px-4 py-1.5 pl-10 group hover:bg-[var(--sur-5)] transition-colors">
            <span className="text-xs w-4 text-right flex-shrink-0" style={{ color: 'var(--color-text-muted)' }}>{amtIndex + 1}.</span>
            <span className="text-sm font-medium tabular-nums flex-1" style={{ color: 'var(--color-text)' }}>
              {currencySymbol}{amt.toFixed(2)}
            </span>
            <div className="flex gap-0.5 items-center opacity-0 group-hover:opacity-100 transition-opacity">
              <button onClick={() => openNoteDialog(row.description, amt)} className="p-1 rounded-lg" style={{ color: 'var(--color-text-muted)' }} title="Add note / tag">
                <MessageSquare className="w-3.5 h-3.5" />
              </button>
              <button onClick={() => setEditingAmount({ rowIndex: row.rowIndex, amtIndex, value: String(amt) })} className="p-1 rounded-lg hover:bg-[var(--sur-5)]" style={{ color: 'var(--color-text-muted)' }}>
                <Edit2 className="w-3.5 h-3.5" />
              </button>
              <button onClick={() => deleteAmount(row, amtIndex)} className="p-1 rounded-lg hover:bg-[var(--sur-5)]" style={{ color: 'var(--color-text-muted)' }}>
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        ))}
      </div>
    );
  };

  // ── A collapsible card for a vendor with multiple transactions ──
  const renderGroupCard = (g) => {
    const expanded = openVendor === g.key;
    const total    = groupTotal(g);
    const isNm      = isVendorNonMonthly(g.vendor);
    const isRec     = isVendorRecurring(g.vendor);
    return (
      <div key={g.key} data-tx-uuid={g.members.flatMap(m => m.uuids || []).filter(Boolean).join(' ')}
        className="rounded-2xl overflow-hidden" style={{ background: 'var(--sur-4)', border: '1px solid var(--sur-8)' }}>
        {deletingGroup === g.key ? (
          <div className="flex items-center gap-2 px-4 py-2.5"
            style={{ background: 'oklch(62% 0.22 25 / 12%)', borderBottom: '1px solid oklch(62% 0.22 25 / 20%)' }}>
            <AlertTriangle className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--color-danger)' }} />
            <span className="text-xs font-bold flex-1 min-w-0 truncate" style={{ color: 'var(--color-danger)' }}>
              Delete <span className="font-black">{g.vendor}</span> + all {g.members.length} transactions?
            </span>
            <button onClick={() => setDeletingGroup(null)} disabled={saving}
              className="px-2.5 py-1 rounded-lg text-xs font-bold transition-colors flex-shrink-0" style={{ color: 'var(--color-text-muted)' }}>
              Cancel
            </button>
            <button onClick={() => deleteGroup(g)} disabled={saving}
              className="px-2.5 py-1 rounded-lg text-xs font-black text-white transition-colors flex-shrink-0 disabled:opacity-50" style={{ background: 'var(--color-danger)' }}>
              {saving ? '…' : 'Delete All'}
            </button>
          </div>
        ) : editingGroup?.key === g.key ? (
          <div className="flex items-center gap-2 px-4 py-2.5" style={{ borderBottom: '1px solid var(--sur-8)' }}>
            <input className={inputCls} style={inputStyle} value={editingGroup.value}
              onChange={e => setEditingGroup(eg => ({ ...eg, value: e.target.value }))}
              onKeyDown={e => e.key === 'Enter' && saveGroupName(g)} autoFocus disabled={saving} />
            <button onClick={() => saveGroupName(g)} disabled={saving} className="p-1.5 rounded-lg flex-shrink-0" style={{ color: 'var(--color-success)' }}>
              <Check className="w-4 h-4" />
            </button>
            <button onClick={() => setEditingGroup(null)} className="p-1.5 rounded-lg flex-shrink-0" style={{ color: 'var(--color-text-muted)' }}>
              <X className="w-4 h-4" />
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2 px-4 py-2.5" style={{ borderBottom: expanded ? '1px solid var(--sur-6)' : 'none' }}>
            <button onClick={() => setOpenVendor(expanded ? null : g.key)} className="flex items-center gap-2 flex-1 min-w-0 text-left">
              {expanded ? <ChevronDown className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--color-text-muted)' }} />
                        : <ChevronRight className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--color-text-muted)' }} />}
              <VendorLogo name={g.vendor} size={22} onEditDomain={() => setEditingDomain({ vendorName: g.vendor, draft: resolveVendorDomain(g.vendor) || '' })} />
              <div className="flex-1 min-w-0">
                <span className="text-sm font-black block truncate" style={{ color: 'var(--color-text)' }}>{g.vendor}</span>
                <span className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>{g.members.length} transactions</span>
              </div>
            </button>
            <span className="text-sm font-black tabular-nums ml-2 flex-shrink-0" style={{ color: 'var(--color-text-muted)' }}>
              {currencySymbol}{total.toFixed(2)}
            </span>
            {onToggleRecurring && (
              <button onClick={() => toggleRecurring(g.vendor, g.members[g.members.length - 1]?.amounts?.[0] ?? 0, g.members[g.members.length - 1]?.date)} disabled={saving}
                title={isRec ? `Stop importing ${g.vendor} into new months` : `Import ${g.vendor} into every new month`}
                className="p-1.5 rounded-lg transition-colors flex-shrink-0"
                style={isRec ? { color: 'var(--color-accent-text)', background: 'var(--color-accent-subtle)' } : { color: 'var(--color-text-muted)' }}>
                <Repeat className="w-3.5 h-3.5" />
              </button>
            )}
            <button onClick={() => toggleGroupNonMonthly(g)} disabled={saving}
              title={isNm ? 'Remove one-time flag' : 'Mark as one-time expense'}
              className="p-1.5 rounded-lg transition-colors flex-shrink-0"
              style={isNm ? { color: 'var(--color-accent-text)', background: 'var(--color-accent-subtle)' } : { color: 'var(--color-text-muted)' }}>
              <CalendarX className="w-3.5 h-3.5" />
            </button>
            {onAddForVendor && (
              <button onClick={() => onAddForVendor(g.vendor)}
                className="p-1.5 rounded-lg transition-colors flex-shrink-0 hover:bg-[var(--sur-5)]"
                title={`Add another ${g.vendor} transaction`} style={{ color: 'var(--color-text-muted)' }}>
                <Plus className="w-3.5 h-3.5" />
              </button>
            )}
            <button onClick={() => openMoveFor(g.members, g.vendor)}
              className="p-1.5 rounded-lg transition-colors flex-shrink-0 hover:bg-[var(--sur-5)]" title="Move all to another category" style={{ color: 'var(--color-text-muted)' }}>
              <FolderInput className="w-3.5 h-3.5" />
            </button>
            <button onClick={() => setEditingGroup({ key: g.key, value: g.vendor })}
              className="p-1.5 rounded-lg transition-colors flex-shrink-0 hover:bg-[var(--sur-5)]" title="Rename vendor" style={{ color: 'var(--color-text-muted)' }}>
              <Edit2 className="w-3.5 h-3.5" />
            </button>
            <button onClick={() => setDeletingGroup(g.key)}
              className="p-1.5 rounded-lg transition-colors flex-shrink-0 hover:bg-[var(--sur-5)]" title="Delete entire vendor" style={{ color: 'var(--color-text-muted)' }}>
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
        {expanded && deletingGroup !== g.key && editingGroup?.key !== g.key &&
          g.members.map(renderMemberRow)}
      </div>
    );
  };

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-[55] animate-overlay-in"
        style={{ background: 'oklch(0% 0 0 / 50%)', backdropFilter: 'blur(4px)' }}
        onClick={onClose}
      />

      {/* Panel */}
      <div className="fixed right-0 top-0 h-full w-full max-w-sm glass-heavy z-[60] flex flex-col"
        style={{ borderLeft: '1px solid var(--sur-8)' }}>

        {/* Header — padded below notch */}
        <div className="p-6 flex justify-between items-center flex-shrink-0"
          style={{ paddingTop: 'calc(env(safe-area-inset-top) + 1.5rem)', borderBottom: '1px solid var(--sur-8)' }}
        >
          <div>
            <p className="text-lg font-black" style={{ color: 'var(--color-text)' }}>{expense}</p>
            <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>Itemised breakdown</p>
          </div>
          <div className="flex items-center gap-2">
            {onAddExpense && (
              <button
                onClick={onAddExpense}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold transition-colors"
                style={{ background: 'var(--color-accent)', color: 'white' }}
              >
                <Plus className="w-3.5 h-3.5" />
                Add
              </button>
            )}
            <button
              onClick={onClose}
              className="p-2 rounded-xl transition-colors hover:bg-[var(--sur-5)]"
              style={{ color: 'var(--color-text-muted)' }}
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Error banner */}
        {error && (
          <div className="mx-4 mt-3 px-4 py-2.5 rounded-2xl"
            style={{ background: 'oklch(62% 0.22 25 / 10%)', border: '1px solid oklch(62% 0.22 25 / 20%)' }}>
            <p className="text-xs font-medium" style={{ color: 'var(--color-danger)' }}>{error}</p>
          </div>
        )}

        {/* Body */}
        <div ref={listRef} className="flex-1 overflow-y-auto p-4 space-y-2">

          {loading && (
            <div className="space-y-3 p-2">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="h-12 rounded-2xl animate-pulse" style={{ background: 'var(--sur-6)' }} />
              ))}
            </div>
          )}

          {!loading && rows?.length === 0 && (
            <p className="text-sm text-center py-12" style={{ color: 'var(--color-text-muted)' }}>No transactions found</p>
          )}

          {!loading && groups.map((g) => {
            // Vendors with multiple transactions render as one collapsible group card.
            if (g.members.length > 1) return renderGroupCard(g);
            // Single-transaction vendors render exactly as before.
            const row = g.members[0];
            return (
            <div key={row.rowIndex} data-tx-uuid={(row.uuids || []).filter(Boolean).join(' ')}
              className="rounded-2xl overflow-hidden"
              style={{ background: 'var(--sur-4)', border: '1px solid var(--sur-8)' }}>

              {/* ── Vendor name row ── */}
              {deletingVendor === row.rowIndex ? (
                <div className="flex items-center gap-2 px-4 py-2.5"
                  style={{ background: 'oklch(62% 0.22 25 / 12%)', borderBottom: '1px solid oklch(62% 0.22 25 / 20%)' }}>
                  <AlertTriangle className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--color-danger)' }} />
                  <span className="text-xs font-bold flex-1 min-w-0 truncate" style={{ color: 'var(--color-danger)' }}>
                    Delete <span className="font-black">{row.description}</span> + all {row.amounts.length} transaction{row.amounts.length !== 1 ? 's' : ''}?
                  </span>
                  <button onClick={() => setDeletingVendor(null)} disabled={saving}
                    className="px-2.5 py-1 rounded-lg text-xs font-bold transition-colors flex-shrink-0"
                    style={{ color: 'var(--color-text-muted)' }}>
                    Cancel
                  </button>
                  <button onClick={() => deleteAllAmounts(row)} disabled={saving}
                    className="px-2.5 py-1 rounded-lg text-xs font-black text-white transition-colors flex-shrink-0 disabled:opacity-50"
                    style={{ background: 'var(--color-danger)' }}>
                    {saving ? '…' : 'Delete All'}
                  </button>
                </div>
              ) : editingVendor?.rowIndex === row.rowIndex ? (
                <div className="flex flex-col" style={{ borderBottom: '1px solid var(--sur-8)' }}>
                  <div className="flex items-center gap-2 px-4 py-2.5">
                    <input className={inputCls} style={inputStyle}
                      value={editingVendor.value}
                      onChange={e => setEditingVendor(ev => ({ ...ev, value: e.target.value }))}
                      onKeyDown={e => e.key === 'Enter' && saveVendorName(row)}
                      autoFocus disabled={saving} />
                    <button onClick={() => saveVendorName(row)} disabled={saving}
                      className="p-1.5 rounded-lg transition-colors flex-shrink-0"
                      style={{ color: 'var(--color-success)' }}>
                      <Check className="w-4 h-4" />
                    </button>
                    <button onClick={() => setEditingVendor(null)}
                      className="p-1.5 rounded-lg transition-colors flex-shrink-0"
                      style={{ color: 'var(--color-text-muted)' }}>
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                  {row._v2 && (
                    <div className="px-4 pb-2.5">
                      <p className="text-[10px] font-black uppercase tracking-widest mb-1" style={{ color: 'var(--color-text-muted)' }}>Date</p>
                      <input type="date" value={editingVendor.date ?? row.date ?? ''}
                        onChange={e => setEditingVendor(ev => ({ ...ev, date: e.target.value }))}
                        className={inputCls} style={inputStyle} disabled={saving} />
                    </div>
                  )}
                  <label className="flex items-center gap-2.5 px-4 pb-3 cursor-pointer group">
                    <div className="w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0 transition-colors"
                      style={editingVendor.isNonMonthly
                        ? { background: 'var(--color-accent)', borderColor: 'var(--color-accent)' }
                        : { background: 'var(--sur-5)', borderColor: 'var(--sur-20)' }}
                      onClick={() => setEditingVendor(ev => ({ ...ev, isNonMonthly: !ev.isNonMonthly }))}>
                      {editingVendor.isNonMonthly && <svg className="w-2.5 h-2.5 text-white" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                    </div>
                    <span onClick={() => setEditingVendor(ev => ({ ...ev, isNonMonthly: !ev.isNonMonthly }))}
                      className="text-xs font-bold transition-colors select-none" style={{ color: 'var(--color-text-muted)' }}>
                      One-time / non-monthly expense
                    </span>
                  </label>
                </div>
              ) : (
                <div className="flex items-center gap-2 px-4 py-2.5" style={{ borderBottom: '1px solid var(--sur-6)' }}>
                  <VendorLogo
                    name={row.description} size={22}
                    onEditDomain={() => setEditingDomain({ vendorName: row.description, draft: resolveVendorDomain(row.description) || '' })}
                  />
                  <div className="flex-1 min-w-0">
                    <span className="text-sm font-black block truncate" style={{ color: 'var(--color-text)' }}>
                      {row.description}
                    </span>
                    {row._v2 && (
                      <span onClick={() => {
                          const nm = nonMonthlyVendors.includes(row.description.toLowerCase());
                          setEditingVendor({ rowIndex: row.rowIndex, value: row.description, date: row.date || todayIso(), isNonMonthly: nm, wasNonMonthly: nm });
                        }}
                        className="text-[10px] cursor-pointer"
                        style={{ color: row.date ? 'var(--color-text-muted)' : 'var(--color-accent-text)', fontWeight: row.date ? undefined : 'bold' }}>
                        {row.date ? formatTxDate(row.date) : '— tap to add date'}
                      </span>
                    )}
                    {row._v2 && cards.length > 0 && (
                      editingCardRow?.rowIndex === row.rowIndex ? (
                        <div className="flex items-center gap-1 mt-0.5">
                          <select autoFocus value={cardDraft} onChange={e => setCardDraft(e.target.value)}
                            className="text-[10px] font-bold rounded-lg px-1.5 py-0.5 outline-none"
                            style={{ background: 'var(--color-surface)', border: '1px solid var(--sur-20)', color: 'var(--color-text)' }}>
                            <option value="">— Remove card —</option>
                            {cards.filter(c => !c.toLowerCase().includes('debit') && !c.toLowerCase().includes('bank') && c.toLowerCase() !== 'cash').map(c => (
                              <option key={c} value={c}>{c}</option>
                            ))}
                          </select>
                          <button onClick={() => withSave(async () => {
                              const uuid = row.uuids?.[0] || '';
                              await updatePaymentMethod(expense, row.rowIndex, cardDraft, accessToken, sheetId);
                              if (uuid) await updateHistoryPaymentMethod(sheetId, accessToken, uuid, cardDraft);
                              setEditingCardRow(null); onRefresh?.();
                            })} disabled={saving}
                            className="p-0.5 rounded text-white disabled:opacity-40 transition-colors"
                            style={{ background: 'var(--color-accent)' }}>
                            <Check className="w-3 h-3" />
                          </button>
                          <button onClick={() => setEditingCardRow(null)}
                            className="p-0.5 rounded transition-colors" style={{ color: 'var(--color-text-muted)' }}>
                            <X className="w-3 h-3" />
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-1 mt-0.5">
                          {row.paymentMethod ? (
                            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full"
                              style={{ background: 'var(--color-accent-subtle)', color: 'var(--color-accent-text)', border: '1px solid var(--color-accent-border)' }}>
                              💳 {row.paymentMethod}
                            </span>
                          ) : (
                            <span className="text-[10px] italic" style={{ color: 'var(--color-text-muted)', opacity: 0.5 }}>No card</span>
                          )}
                          <button onClick={() => { setEditingCardRow({ rowIndex: row.rowIndex, uuid: row.uuids?.[0] || '' }); setCardDraft(row.paymentMethod || ''); }}
                            className="p-0.5 rounded transition-colors" title="Edit card"
                            style={{ color: 'var(--color-text-muted)' }}>
                            <CreditCard className="w-3 h-3" />
                          </button>
                        </div>
                      )
                    )}
                    {!row._v2 && row.paymentMethod && (
                      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full"
                        style={{ background: 'var(--color-accent-subtle)', color: 'var(--color-accent-text)', border: '1px solid var(--color-accent-border)' }}>
                        💳 {row.paymentMethod}
                      </span>
                    )}
                    {row.bookingMethod === 'direct' && (
                      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full"
                        style={{ background: 'oklch(78% 0.16 75 / 15%)', color: 'oklch(78% 0.16 75)' }}>
                        ✈️ Direct booking · 4x UR
                      </span>
                    )}
                  </div>
                  <span className="text-sm font-black tabular-nums ml-2 flex-shrink-0" style={{ color: 'var(--color-text-muted)' }}>
                    {currencySymbol}{row.amounts.reduce((a, b) => a + b, 0).toFixed(2)}
                  </span>
                  <button
                    onClick={() => {
                      const isNm = nonMonthlyVendors.includes(row.description.toLowerCase());
                      const total = row.amounts.reduce((a, b) => a + b, 0);
                      withSave(async () => {
                        if (isNm) await unmarkNonMonthly(sheetId, accessToken, row.description);
                        else      await markNonMonthly(sheetId, accessToken, row.description, total);
                        onNonMonthlyChanged?.();
                      });
                    }}
                    disabled={saving}
                    title={nonMonthlyVendors.includes(row.description.toLowerCase()) ? 'Remove one-time flag' : 'Mark as one-time expense'}
                    className="p-1.5 rounded-lg transition-colors flex-shrink-0"
                    style={nonMonthlyVendors.includes(row.description.toLowerCase())
                      ? { color: 'var(--color-accent-text)', background: 'var(--color-accent-subtle)' }
                      : { color: 'var(--color-text-muted)' }}
                  >
                    <CalendarX className="w-3.5 h-3.5" />
                  </button>
                  {onToggleRecurring && (
                    <button
                      onClick={() => toggleRecurring(row.description, row.amounts?.[0] ?? 0, row.date)}
                      disabled={saving}
                      title={isVendorRecurring(row.description)
                        ? `Stop importing ${row.description} into new months`
                        : `Import ${row.description} into every new month`}
                      className="p-1.5 rounded-lg transition-colors flex-shrink-0"
                      style={isVendorRecurring(row.description)
                        ? { color: 'var(--color-accent-text)', background: 'var(--color-accent-subtle)' }
                        : { color: 'var(--color-text-muted)' }}
                    >
                      <Repeat className="w-3.5 h-3.5" />
                    </button>
                  )}
                  {onAddForVendor && (
                    <button onClick={() => onAddForVendor(row.description)}
                      className="p-1.5 rounded-lg transition-colors flex-shrink-0 hover:bg-[var(--sur-5)]"
                      title={`Add another ${row.description} transaction`} style={{ color: 'var(--color-text-muted)' }}>
                      <Plus className="w-3.5 h-3.5" />
                    </button>
                  )}
                  <button onClick={() => openMoveFor([row], row.description)}
                    className="p-1.5 rounded-lg transition-colors flex-shrink-0 hover:bg-[var(--sur-5)]" title="Move to another category"
                    style={{ color: 'var(--color-text-muted)' }}>
                    <FolderInput className="w-3.5 h-3.5" />
                  </button>
                  <button onClick={() => { const nm = nonMonthlyVendors.includes(row.description.toLowerCase()); setEditingVendor({ rowIndex: row.rowIndex, value: row.description, isNonMonthly: nm, wasNonMonthly: nm }); }}
                    className="p-1.5 rounded-lg transition-colors flex-shrink-0 hover:bg-[var(--sur-5)]" title="Rename vendor"
                    style={{ color: 'var(--color-text-muted)' }}>
                    <Edit2 className="w-3.5 h-3.5" />
                  </button>
                  <button onClick={() => { setEditingAmount(null); setDeletingVendor(row.rowIndex); }}
                    className="p-1.5 rounded-lg transition-colors flex-shrink-0 hover:bg-[var(--sur-5)]" title="Delete entire vendor"
                    style={{ color: 'var(--color-text-muted)' }}>
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}

              {/* Individual amounts */}
              {deletingVendor !== row.rowIndex && row.amounts.map((amt, amtIndex) => (
                <div key={amtIndex} className="flex items-center gap-2 px-4 py-2 transition-colors group hover:bg-[var(--sur-5)]">
                  {editingAmount?.rowIndex === row.rowIndex && editingAmount?.amtIndex === amtIndex ? (
                    <>
                      <span className="text-sm" style={{ color: 'var(--color-text-muted)' }}>{currencySymbol}</span>
                      <input type="number" step="0.01" min="0.01"
                        className={`${inputCls} w-28`} style={inputStyle}
                        value={editingAmount.value}
                        onChange={e => setEditingAmount(ea => ({ ...ea, value: e.target.value }))}
                        onKeyDown={e => e.key === 'Enter' && saveAmount(row)}
                        autoFocus disabled={saving} />
                      <button onClick={() => saveAmount(row)} disabled={saving}
                        className="p-1.5 rounded-lg transition-colors flex-shrink-0"
                        style={{ color: 'var(--color-success)' }}>
                        <Check className="w-4 h-4" />
                      </button>
                      <button onClick={() => setEditingAmount(null)}
                        className="p-1.5 rounded-lg transition-colors flex-shrink-0"
                        style={{ color: 'var(--color-text-muted)' }}>
                        <X className="w-4 h-4" />
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="text-xs w-4 text-right flex-shrink-0" style={{ color: 'var(--color-text-muted)' }}>
                        {amtIndex + 1}.
                      </span>
                      <span className="text-sm font-medium tabular-nums flex-1" style={{ color: 'var(--color-text)' }}>
                        {currencySymbol}{amt.toFixed(2)}
                      </span>
                      <div className="flex gap-1 items-center opacity-0 group-hover:opacity-100 transition-opacity">
                        {(() => {
                          const key  = noteKeyFor(row.description, amt);
                          const data = transactionNotes[key];
                          const has  = data?.note || data?.tags?.length > 0;
                          return (
                            <button onClick={() => openNoteDialog(row.description, amt)}
                              className="p-1.5 rounded-lg transition-colors"
                              style={{ color: has ? 'var(--color-accent-text)' : 'var(--color-text-muted)', opacity: has ? 1 : undefined }}
                              title={has ? 'View/edit note' : 'Add note / tag'}>
                              <MessageSquare className="w-3.5 h-3.5" />
                            </button>
                          );
                        })()}
                        <button onClick={() => setEditingAmount({ rowIndex: row.rowIndex, amtIndex, value: String(amt) })}
                          className="p-1.5 rounded-lg transition-colors hover:bg-[var(--sur-5)]"
                          style={{ color: 'var(--color-text-muted)' }}>
                          <Edit2 className="w-3.5 h-3.5" />
                        </button>
                        <button onClick={() => deleteAmount(row, amtIndex)}
                          className="p-1.5 rounded-lg transition-colors hover:bg-[var(--sur-5)]"
                          style={{ color: 'var(--color-text-muted)' }}>
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
            );
          })}
        </div>

        {/* Footer total — padded above home indicator */}
        {!loading && rows && rows.length > 0 && (
          <div className="p-6 flex justify-between items-center flex-shrink-0"
            style={{ borderTop: '1px solid var(--sur-8)', paddingBottom: 'calc(env(safe-area-inset-bottom) + 1.5rem)' }}
          >
            <span className="text-xs font-black uppercase tracking-widest" style={{ color: 'var(--color-text-muted)' }}>Total</span>
            <span className="text-2xl font-black tabular-nums" style={{ color: 'var(--color-text)' }}>
              {currencySymbol}{total.toFixed(2)}
            </span>
          </div>
        )}
      </div>
      {/* Transaction note dialog */}
      {noteDialog && (
        <>
          <div className="fixed inset-0 z-[60] animate-overlay-in" style={{ background: 'oklch(0% 0 0 / 50%)', backdropFilter: 'blur(4px)' }} onClick={() => setNoteDialog(null)} />
          <div className="fixed inset-0 z-[61] flex items-end sm:items-center justify-center sm:p-4">
            <div className="glass-heavy animate-sheet-up rounded-t-3xl sm:rounded-3xl w-full sm:max-w-sm"
              style={{ border: '1px solid var(--sur-10)', borderBottom: 'none' }}>
              <div className="w-10 h-1 rounded-full mx-auto mt-3 mb-1 sm:hidden" style={{ background: 'var(--sur-20)' }} />
              <div className="px-6 pt-5 pb-4 flex items-center justify-between" style={{ borderBottom: '1px solid var(--sur-8)' }}>
                <div>
                  <p className="text-sm font-black" style={{ color: 'var(--color-text)' }}>Note / Tags</p>
                  <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>{noteDialog.vendor} · {currencySymbol}{Number(noteDialog.amount).toFixed(2)}</p>
                </div>
                <button onClick={() => setNoteDialog(null)} className="p-1.5 rounded-xl transition-colors hover:bg-[var(--sur-5)]" style={{ color: 'var(--color-text-muted)' }}>
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="px-6 py-4 space-y-3">
                <textarea rows={3} placeholder="Add a note…" value={noteDraft.note}
                  onChange={e => setNoteDraft(d => ({ ...d, note: e.target.value }))}
                  className="w-full rounded-2xl px-4 py-2.5 text-sm outline-none resize-none"
                  style={{ background: 'var(--sur-5)', border: '1px solid var(--sur-12)', color: 'var(--color-text)' }} />
                <div className="flex gap-2">
                  <input type="text" placeholder="Add tag (Enter)"
                    value={noteTagInput} onChange={e => setNoteTagInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addNoteTag(); } }}
                    className="flex-1 rounded-2xl px-4 py-2 text-sm outline-none"
                    style={{ background: 'var(--sur-5)', border: '1px solid var(--sur-12)', color: 'var(--color-text)' }} />
                  <button onClick={addNoteTag} className="px-3 py-2 text-white text-xs font-bold rounded-2xl transition-colors"
                    style={{ background: 'var(--color-accent)' }}>Add</button>
                </div>
                {noteDraft.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {noteDraft.tags.map(tag => (
                      <span key={tag} onClick={() => setNoteDraft(d => ({ ...d, tags: d.tags.filter(t => t !== tag) }))}
                        className="flex items-center gap-1 text-xs font-bold px-2.5 py-1 rounded-full cursor-pointer"
                        style={{ background: 'var(--color-accent-subtle)', color: 'var(--color-accent-text)', border: '1px solid var(--color-accent-border)' }}>
                        #{tag} ×
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div className="px-6 flex gap-2" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 1.5rem)' }}>
                {(noteDialog.data?.note || noteDialog.data?.tags?.length > 0) && (
                  <button onClick={deleteNoteDialog} className="px-4 py-3 rounded-2xl text-sm font-bold transition-colors"
                    style={{ color: 'var(--color-danger)', background: 'oklch(62% 0.22 25 / 10%)' }}>
                    Delete
                  </button>
                )}
                <button onClick={() => setNoteDialog(null)} className="flex-1 py-3 rounded-2xl text-sm font-bold transition-colors"
                  style={{ background: 'var(--sur-8)', color: 'var(--color-text)' }}>
                  Cancel
                </button>
                <button onClick={saveNoteDialog} className="flex-1 py-3 rounded-2xl text-sm font-bold text-white transition-all"
                  style={{ background: 'var(--color-accent)' }}>
                  Save
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Domain edit modal */}
      {editingDomain && (
        <>
          <div className="fixed inset-0 z-[60] animate-overlay-in" style={{ background: 'oklch(0% 0 0 / 50%)', backdropFilter: 'blur(4px)' }} onClick={() => setEditingDomain(null)} />
          <div className="fixed inset-0 z-[61] flex items-end sm:items-center justify-center sm:p-4">
            <div className="glass-heavy animate-sheet-up rounded-t-3xl sm:rounded-3xl w-full sm:max-w-sm"
              style={{ border: '1px solid var(--sur-10)', borderBottom: 'none' }}>
              <div className="w-10 h-1 rounded-full mx-auto mt-3 mb-1 sm:hidden" style={{ background: 'var(--sur-20)' }} />
              <div className="px-6 pt-5 pb-4 flex items-center justify-between" style={{ borderBottom: '1px solid var(--sur-8)' }}>
                <div>
                  <p className="text-sm font-black" style={{ color: 'var(--color-text)' }}>Vendor Logo</p>
                  <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>{editingDomain.vendorName}</p>
                </div>
                <button onClick={() => setEditingDomain(null)} className="p-1.5 rounded-xl transition-colors hover:bg-[var(--sur-5)]" style={{ color: 'var(--color-text-muted)' }}>
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="px-6 py-5 space-y-3">
                <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>Enter the website domain to use for the logo:</p>
                <input type="text" value={editingDomain.draft}
                  onChange={e => setEditingDomain(d => ({ ...d, draft: e.target.value }))}
                  placeholder="e.g. walmart.com" autoFocus
                  className={inputCls} style={inputStyle} />
                {editingDomain.draft && (
                  <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--color-text-muted)' }}>
                    <span>Preview:</span>
                    <img src={faviconUrl(editingDomain.draft)} alt=""
                      className="w-5 h-5 rounded object-contain" onError={e => e.target.style.display = 'none'} />
                    <span>{editingDomain.draft}</span>
                  </div>
                )}
              </div>
              <div className="px-6 flex gap-3" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 1.5rem)' }}>
                <button onClick={() => setEditingDomain(null)} className="flex-1 py-3 rounded-2xl text-sm font-bold transition-colors"
                  style={{ background: 'var(--sur-8)', color: 'var(--color-text)' }}>
                  Cancel
                </button>
                <button onClick={() => { setCustomVendorDomain(editingDomain.vendorName, editingDomain.draft.trim()); setEditingDomain(null); forceLogoRefresh(n => n + 1); }}
                  className="flex-1 py-3 rounded-2xl text-sm font-bold text-white transition-all"
                  style={{ background: 'var(--color-accent)' }}>
                  Save
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Move-to-category picker */}
      {movingTx && (
        <CategoryPickerSheet
          title="Move to category"
          subtitle={`${movingTx.vendor} · ${movingTx.subtitle}`}
          currentCategory={expense}
          saving={saving}
          onClose={() => setMovingTx(null)}
          onPick={doMove}
        />
      )}
    </>
  );
}
