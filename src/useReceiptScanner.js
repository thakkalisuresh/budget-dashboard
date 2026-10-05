import { useState, useRef, useEffect, useCallback } from 'react';
import { checkExistingExpense, fuzzyNamesMatch, fetchAllLoggedTransactions, fetchDetailRows, markNonMonthly, normalizeStatementDate, todayIso } from './sheetsApi.js';
import { addOrUpdateExpense } from './useExpense.js';
import { applySmartRules, applyCardRules } from './smartRules.js';
import {
  extractFromFile, validateCategories, checkDuplicates, resolveCardName,
  loadFxCache, saveFxCache, isPlausibleRate, warmClaudeProxy,
} from './receiptHelpers.js';
import { startScanTiming } from './scanTiming.js';
import { resolveMCC } from './vendorMCC.js';
import { matchesSplitVendor } from './itemCategorizer.js';
import { buildCategoryItems, buildSplitNote } from './splitNotes.js';
import { txNoteKey } from './transactionNotes.js';
import { resolveKnownItems, pendingItems, applyLlmSuggestions, groupItems, foldRemainder } from './splitResolve.js';
import { fetchItemMemory, appendItemMemory } from './sheetItemMemory.js';
import { buildMemoryRows, learnedExamples, newSplitId } from './itemMemory.js';
import { categorizeItemsWithLLM } from './itemCategorizeApi.js';
import { CATEGORIES } from './sheetHelpers.js';

// How many receipt/statement images to extract at once when several files are
// selected. The Vision proxy allows 20 req/min per user, so 4 in flight stays
// well under the limit while cutting a multi-file scan to ~1/4 of the serial time.
const EXTRACT_CONCURRENCY = 4;

const CSR = 'Chase Sapphire Reserve';
const TRAVEL_MCCS = new Set(['4511', '7011', 'CHASE_PORTAL']);

export function useReceiptScanner({ accessToken, sheetId, monthName, onSuccess, activeCategories = [], scanTriggerRef, smartRules = [], cards = [], cardRules = [], onSaveRecurring, onSaveTransactionNotes, splitReceiptVendors = [], userId = '' }) {
  const [phase, setPhase]         = useState('idle');
  const [scanError, setScanError] = useState('');
  const [processingProgress, setProcessingProgress] = useState(null);
  const [unmatchedLogged, setUnmatchedLogged]       = useState([]);

  const [queue, setQueue]           = useState([]);
  const [queueIndex, setQueueIndex] = useState(0);
  const [wasUnreadable, setWasUnreadable] = useState(false);
  const [vendor, setVendor]     = useState('');
  const [amount, setAmount]     = useState('');
  const [category, setCategory] = useState('');
  const [isRandom, setIsRandom] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState('');
  const [bookingMethod, setBookingMethod] = useState('');
  const [tip, setTip]           = useState('');
  const [formErr, setFormErr]   = useState('');
  const [dupWarning, setDupWarning] = useState(false);
  const [savedReceipts, setSavedReceipts] = useState([]);
  const [foreignCurrency, setForeignCurrency] = useState(null);
  const [showCurrencyPrompt, setShowCurrencyPrompt] = useState(false);

  const [stmtTransactions, setStmtTransactions] = useState([]);
  const [stmtSavedCount, setStmtSavedCount]     = useState(0);

  // Split-receipt state (Costco/Amazon → per-category split).
  // ONE flat list holds every line item, whether learned history, the keyword
  // tables, the LLM or the user decided it — and every one of them is editable
  // on the review screen. Keeping the auto-sorted ones read-only (as this used
  // to) meant a wrong keyword answer could never be corrected, so item memory
  // would keep relearning the same mistake.
  const [splitVendor, setSplitVendor]       = useState('');
  const [splitTotal, setSplitTotal]         = useState(0);
  const [splitPaymentMethod, setSplitPaymentMethod] = useState('');
  const [splitItems, setSplitItems]         = useState([]);   // [{ name, amount, category, source, suggestion, confidence }]
  const [splitAsking, setSplitAsking]       = useState(false); // batched LLM call in flight
  const [splitSavedSummary, setSplitSavedSummary] = useState(null);

  // Item memory is loaded once per page load and reused across every receipt in
  // the queue; the fetch is a round-trip and the log rarely changes mid-scan.
  const memoryRef = useRef(null);
  const loadMemory = useCallback(async () => {
    if (memoryRef.current) return memoryRef.current;
    memoryRef.current = await fetchItemMemory(userId, accessToken);
    return memoryRef.current;
  }, [userId, accessToken]);

  const [editingIndex, setEditingIndex]   = useState(null);
  const [editVendor, setEditVendor]       = useState('');
  const [editAmount, setEditAmount]       = useState('');
  const [editCategory, setEditCategory]   = useState('');
  const [editCard, setEditCard]           = useState('');
  const [editErr, setEditErr]             = useState('');

  // Resolve a card for a transaction: Vision result → fuzzy match → card rules → ''
  const resolveCard = (visionCard, vendorName, categoryName) =>
    resolveCardName(visionCard, cards) || applyCardRules(vendorName, categoryName, cardRules) || '';

  const fileInputRef = useRef(null);

  // Boot the Vision proxy (kills Firebase cold start) and pre-warm the
  // duplicate-check cache. Called the instant the user shows scan intent —
  // clicking the button / opening the picker — so the ~4s cold start overlaps
  // with them choosing a file instead of being felt on the real request.
  const warmup = useCallback(() => {
    warmClaudeProxy();
    if (accessToken && sheetId) {
      for (const cat of activeCategories) {
        fetchDetailRows(cat, accessToken, sheetId, monthName).catch(() => {});
      }
    }
  }, [accessToken, sheetId, monthName, activeCategories]);

  useEffect(() => {
    if (!scanTriggerRef) return;
    scanTriggerRef.current = () => {
      warmup();
      fileInputRef.current?.click();
    };
  }, [scanTriggerRef, warmup]);

  // ── process a single receipt file ──────────────────────────────────────────
  const processReceiptFile = async (file) => {
    setPhase('processing');
    setScanError('');
    setDupWarning(false);
    try {
      const result = await extractFromFile(file, accessToken, cards);

      if (result.type === 'statement' && result.transactions?.length) {
        const debitsOnly = result.transactions.filter(t => t.txType !== 'credit');
        const stmtCard = resolveCardName(result.paymentMethod, cards);
        const withFlags = debitsOnly.map(t => ({
          ...t, isNonMonthly: false, isRecurring: false,
          card: stmtCard || applyCardRules(t.vendor, t.category, cardRules) || '',
        }));
        const checked = await checkDuplicates(validateCategories(withFlags), accessToken, sheetId, activeCategories, monthName);
        setStmtTransactions(checked);
        setPhase('statement-reviewing');
        return;
      }

      // Split-receipt vendor (Costco, Amazon…) with itemized lines → split by category
      if (matchesSplitVendor(result.vendor, splitReceiptVendors) &&
          Array.isArray(result.items) && result.items.length > 0 && result.amount != null) {
        const vendorName = result.vendor;
        const memory = await loadMemory();

        // Layers 1–2 are instant, so show the screen straight away rather than
        // holding a fully-decided receipt behind a network call.
        const resolved = resolveKnownItems(result.items, { memory, vendor: vendorName });
        setSplitVendor(vendorName);
        setSplitTotal(result.amount);
        setSplitPaymentMethod(resolveCard(result.paymentMethod, vendorName, result.category || 'Misc'));
        setSplitItems(resolved);
        setPhase('split-reviewing');

        // Layer 3: one batched call for whatever is left, folded in when it
        // lands. The user can start picking meanwhile — anything they have
        // already answered is left alone.
        const pending = pendingItems(resolved);
        if (pending.length > 0) {
          setSplitAsking(true);
          try {
            const results = await categorizeItemsWithLLM({
              vendor: vendorName,
              items: pending.map(p => p.item),
              categories: CATEGORIES,
              examples: learnedExamples(memory, vendorName),
              accessToken,
            });
            // applyLlmSuggestions skips anything the user answered meanwhile.
            setSplitItems(prev => applyLlmSuggestions(prev, pending, results));
          } finally {
            setSplitAsking(false);
          }
        }
        return;
      }

      const unreadable = !result.vendor && result.amount == null && !result.category;
      setWasUnreadable(unreadable);
      setVendor(result.vendor || '');
      const ruleCategory = applySmartRules(result.vendor, smartRules);
      const resolvedCategory = ruleCategory || result.category || 'Misc';
      setCategory(resolvedCategory);
      setPaymentMethod(resolveCard(result.paymentMethod, result.vendor, resolvedCategory));
      setIsRandom(false);
      setFormErr('');
      setForeignCurrency(null);
      setShowCurrencyPrompt(false);

      const detectedCurrency = (result.currency || 'USD').toUpperCase();
      if (detectedCurrency !== 'USD' && result.amount != null) {
        let usableRate = null;
        try {
          const rateRes = await fetch(`https://open.er-api.com/v6/latest/USD`);
          const rateData = await rateRes.json();
          const raw = rateData?.rates?.[detectedCurrency];
          if (isPlausibleRate(detectedCurrency, raw)) {
            usableRate = raw;
            saveFxCache(detectedCurrency, raw);
          } else if (typeof raw === 'number') {
            console.warn(`FX rate for ${detectedCurrency} (${raw}) outside plausible bounds — falling back to cache`);
          }
        } catch { /* network failed */ }
        if (usableRate == null) usableRate = loadFxCache(detectedCurrency);
        if (usableRate != null) {
          const converted = result.amount / usableRate;
          setForeignCurrency({ original: result.amount, currency: detectedCurrency, rate: usableRate, converted });
          setAmount(converted.toFixed(2));
          setShowCurrencyPrompt(true);
        } else {
          setAmount(result.amount != null ? String(result.amount) : '');
        }
      } else {
        setAmount(result.amount != null ? String(result.amount) : '');
      }

      setPhase('confirming');
    } catch (err) {
      setScanError(err.message || 'Failed to read file. Please try again.');
      setPhase('idle');
      setQueue([]);
      setQueueIndex(0);
    }
  };

  // ── file(s) selected ───────────────────────────────────────────────────────
  const handleFileChange = async (e) => {
    const files = Array.from(e.target.files || []);
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (!files.length) return;

    setSavedReceipts([]);
    setQueueIndex(0);
    setScanError('');
    setUnmatchedLogged([]);

    if (files.length === 1) {
      setQueue(files);
      await processReceiptFile(files[0]);
      return;
    }

    setPhase('processing');
    setProcessingProgress({ current: 0, total: files.length });

    // Extract all files concurrently (bounded pool) instead of one-at-a-time.
    // Results are collected by index so the receipt queue keeps its file order.
    const results = new Array(files.length);
    let completed = 0;
    let cursor = 0;
    const runWorker = async () => {
      while (cursor < files.length) {
        const i = cursor++;
        try {
          results[i] = await extractFromFile(files[i], accessToken, cards);
        } catch {
          results[i] = null; // treat as a receipt fallback below
        }
        completed++;
        setProcessingProgress({ current: completed, total: files.length });
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(EXTRACT_CONCURRENCY, files.length) }, runWorker)
    );

    const receiptFiles = [];
    let allStmtTransactions = [];
    results.forEach((result, i) => {
      if (result?.type === 'statement' && result.transactions?.length) {
        const stmtCard = resolveCardName(result.paymentMethod, cards);
        const debits = result.transactions.filter(t => t.txType !== 'credit').map(t => ({
          ...t, isNonMonthly: false, isRecurring: false,
          card: stmtCard || applyCardRules(t.vendor, t.category, cardRules) || '',
        }));
        allStmtTransactions = [...allStmtTransactions, ...debits];
      } else {
        receiptFiles.push(files[i]);
      }
    });

    setProcessingProgress(null);

    if (allStmtTransactions.length > 0) {
      const checked = await checkDuplicates(validateCategories(allStmtTransactions), accessToken, sheetId, activeCategories, monthName);
      setStmtTransactions(checked);
      if (receiptFiles.length > 0) {
        setQueue(receiptFiles);
        setQueueIndex(0);
      }
      setPhase('statement-reviewing');
    } else {
      setQueue(receiptFiles);
      await processReceiptFile(receiptFiles[0]);
    }
  };

  // ── confirm & save single receipt ──────────────────────────────────────────
  const doReceiptSave = async () => {
    const amt = parseFloat(amount);
    setDupWarning(false);
    setPhase('saving');
    try {
      // txDate is null (receipts have no parsed date → logged as today). The
      // "one-time/random" flag is applied via markNonMonthly, not the date slot.
      const DINING_CATS = new Set(['Eating Out', 'Thakkali']);
      const tipAmt = DINING_CATS.has(category) ? (Math.max(0, parseFloat(tip) || 0)) : 0;
      const effectiveAmt = tipAmt > 0 ? Math.round((amt + tipAmt) * 100) / 100 : amt;
      const effectiveBM = (paymentMethod === CSR && TRAVEL_MCCS.has(resolveMCC(vendor.trim(), category))) ? bookingMethod : '';
      await addOrUpdateExpense(category, vendor.trim(), effectiveAmt, accessToken, sheetId, monthName, 'scan', null, paymentMethod, effectiveBM);
      if (isRandom) {
        try { await markNonMonthly(sheetId, accessToken, vendor.trim(), amt); } catch { /* non-fatal */ }
      }

      const newSaved = [...savedReceipts, { vendor: vendor.trim(), amount: amt, category }];
      setSavedReceipts(newSaved);
      onSuccess?.();

      const nextIndex = queueIndex + 1;
      if (nextIndex < queue.length) {
        setQueueIndex(nextIndex);
        await processReceiptFile(queue[nextIndex]);
      } else {
        setQueue([]);
        setQueueIndex(0);
        setPhase('summary');
      }
    } catch (err) {
      setFormErr(err.message || 'Failed to save. Please try again.');
      setPhase('confirming');
    }
  };

  const handleConfirm = async () => {
    setFormErr('');
    setDupWarning(false);
    if (!vendor.trim())         { setFormErr('Please enter a vendor name.');  return; }
    if (!category)              { setFormErr('Please select a category.');    return; }
    const amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0) { setFormErr('Please enter a valid amount.'); return; }

    setPhase('saving');
    const isDuplicate = await checkExistingExpense(category, vendor.trim(), amt, accessToken, sheetId);
    setPhase('confirming');
    if (isDuplicate) { setDupWarning(true); return; }

    await doReceiptSave();
  };

  const handleSkip = async () => {
    const nextIndex = queueIndex + 1;
    if (nextIndex < queue.length) {
      setQueueIndex(nextIndex);
      await processReceiptFile(queue[nextIndex]);
    } else {
      savedReceipts.length > 0 ? setPhase('summary') : handleClose();
    }
  };

  // ── import selected statement transactions ─────────────────────────────────
  const handleStatementImport = async () => {
    const toImport = stmtTransactions.filter(t => t.selected);
    if (!toImport.length) { handleClose(); return; }

    const timing = startScanTiming('import');
    setPhase('statement-importing');
    let count = 0;
    for (const t of toImport) {
      try {
        await addOrUpdateExpense(
          t.category || 'Misc', t.vendor, t.amount,
          accessToken, sheetId, monthName, 'import',
          normalizeStatementDate(t.date) || todayIso(), t.card || ''
        );
        if (t.isNonMonthly) {
          try { await markNonMonthly(sheetId, accessToken, t.vendor, t.amount); } catch { /* non-fatal */ }
        }
        if (t.isRecurring) {
          onSaveRecurring?.({ category: t.category || 'Misc', vendor: t.vendor, amount: t.amount });
        }
        count++;
      } catch { /* skip failures silently */ }
    }
    timing.mark('write');
    setStmtSavedCount(count);
    onSuccess?.();

    if (activeCategories.length > 0) {
      try {
        const allLogged = await fetchAllLoggedTransactions(activeCategories, accessToken, sheetId);
        const unmatched = allLogged.filter(logged =>
          !stmtTransactions.some(stmt => {
            const amtMatch = Math.abs((stmt.amount || 0) - logged.amount) < 0.05;
            return amtMatch && fuzzyNamesMatch(logged.vendor, stmt.vendor);
          })
        );
        setUnmatchedLogged(unmatched);
      } catch { /* non-critical */ }
    }
    timing.mark('reconcile');
    timing.end({ imported: count, total: toImport.length });

    if (queue.length > 0) {
      await processReceiptFile(queue[0]);
      return;
    }

    setPhase('summary');
  };

  // ── split helpers ────────────────────────────────────────────────────────
  // A user edit marks the item 'user', which is what makes it a correction
  // rather than a confirmation when it reaches item memory.
  const setSplitItemCategory = (i, category) =>
    setSplitItems(prev => prev.map((it, j) => j === i ? { ...it, category, source: 'user', suggestion: null } : it));

  // Live per-category totals, tax/fees remainder folded into the largest group.
  const splitGroups = groupItems(splitItems);
  const computeSplitGroups = () => foldRemainder(splitGroups, splitTotal);

  const splitReady = splitItems.length > 0 && splitItems.every(it => !!it.category);

  const handleSplitSave = async () => {
    setFormErr('');
    if (!splitReady) { setFormErr('Pick a category for every item first.'); return; }
    setPhase('split-saving');
    try {
      const { groups, remainder, remainderCategory } = computeSplitGroups();
      // Every item now lives in splitItems, so there are no separate auto groups.
      const itemsByCategory = buildCategoryItems([], splitItems);
      const vendor = splitVendor.trim();
      const splitId = newSplitId();
      const logged = [];
      const notes  = {};
      for (const [category, amount] of Object.entries(groups)) {
        if (amount <= 0) continue;
        await addOrUpdateExpense(category, vendor, amount, accessToken, sheetId, monthName, 'scan', null, splitPaymentMethod, '');
        logged.push({ category, amount });
        // Key off the amount actually written — the remainder has already been
        // folded in, and a key built from the pre-fold subtotal would never be
        // read back. Only categories that actually saved get a note.
        const note = buildSplitNote(itemsByCategory[category] || [], {
          remainder: category === remainderCategory ? remainder : 0,
        });
        // splitId ties this transaction back to its rows in the item-memory
        // log, so moving it to another category later can re-teach every item
        // it was made of. Cheap to store; the note text itself is capped and
        // truncated, so it cannot be parsed back into a reliable item list.
        if (note) notes[txNoteKey(sheetId, category, vendor, amount)] = { ...note, splitId };
      }
      // One settings write for the whole split: updateSettings is async and
      // batched, so calling it per category would queue N saves of the same blob.
      if (Object.keys(notes).length > 0) onSaveTransactionNotes?.(notes);

      // Teach item memory what this receipt decided. Every item is recorded,
      // not just the hand-picked ones: the user saw the whole list and pressed
      // Save, which endorses the automatic answers too — and recording them
      // makes memory, rather than the keyword table, the thing that answers
      // next time. appendItemMemory never throws; a lost lesson costs a tap,
      // and the expenses are already written by this point.
      appendItemMemory(
        buildMemoryRows({ userId, vendor, items: splitItems, splitId }),
        accessToken
      ).then(ok => { if (ok) memoryRef.current = null; });

      setSplitSavedSummary({ vendor: splitVendor, groups: logged });
      setSavedReceipts(prev => [...prev, ...logged.map(g => ({ vendor: splitVendor.trim(), amount: g.amount, category: g.category }))]);
      onSuccess?.();

      const nextIndex = queueIndex + 1;
      if (nextIndex < queue.length) {
        setQueueIndex(nextIndex);
        await processReceiptFile(queue[nextIndex]);
      } else {
        setQueue([]);
        setQueueIndex(0);
        setPhase('summary');
      }
    } catch (err) {
      setFormErr(err.message || 'Failed to save the split. Please try again.');
      setPhase('split-reviewing');
    }
  };

  const handleClose = () => {
    setPhase('idle');
    setScanError('');
    setFormErr('');
    setQueue([]);
    setQueueIndex(0);
    setSavedReceipts([]);
    setStmtTransactions([]);
    setStmtSavedCount(0);
    setEditingIndex(null);
    setDupWarning(false);
    setProcessingProgress(null);
    setUnmatchedLogged([]);
    setForeignCurrency(null);
    setShowCurrencyPrompt(false);
    setSplitVendor('');
    setSplitTotal(0);
    setSplitPaymentMethod('');
    setSplitItems([]);
    setSplitAsking(false);
    setSplitSavedSummary(null);
  };

  // ── row edit helpers ───────────────────────────────────────────────────────
  const openRowEdit = (i) => {
    const t = stmtTransactions[i];
    setEditVendor(t.vendor || '');
    setEditAmount(t.amount != null ? String(t.amount) : '');
    setEditCategory(t.category || '');
    setEditCard(t.card || '');
    setEditErr('');
    setEditingIndex(i);
  };

  const saveRowEdit = () => {
    if (!editVendor.trim())                   { setEditErr('Please enter a vendor name.');  return; }
    const amt = parseFloat(editAmount);
    if (isNaN(amt) || amt <= 0)               { setEditErr('Please enter a valid amount.'); return; }
    if (!editCategory)                        { setEditErr('Please select a category.');    return; }
    setStmtTransactions(prev => prev.map((t, i) =>
      i === editingIndex ? { ...t, vendor: editVendor.trim(), amount: amt, category: editCategory, card: editCard } : t
    ));
    setEditingIndex(null);
  };

  // Set the card on a single statement row inline
  const setRowCard = (i, card) =>
    setStmtTransactions(prev => prev.map((t, j) => j === i ? { ...t, card } : t));

  return {
    // State
    phase, scanError, processingProgress, unmatchedLogged,
    queue, queueIndex, wasUnreadable,
    vendor, setVendor, amount, setAmount, category, setCategory,
    isRandom, setIsRandom, paymentMethod, setPaymentMethod, bookingMethod, setBookingMethod, tip, setTip, formErr, dupWarning, setDupWarning,
    savedReceipts, foreignCurrency, showCurrencyPrompt,
    stmtTransactions, setStmtTransactions, stmtSavedCount,
    // Split state
    splitVendor, splitTotal, splitPaymentMethod, splitGroups, splitItems, splitReady, splitAsking, splitSavedSummary,
    editingIndex, setEditingIndex, editVendor, setEditVendor,
    editAmount, setEditAmount, editCategory, setEditCategory,
    editCard, setEditCard, editErr,
    cards,
    fileInputRef,
    // Derived
    totalInQueue: queue.length,
    currentNum: queueIndex + 1,
    selectedCount: stmtTransactions.filter(t => t.selected).length,
    duplicateCount: stmtTransactions.filter(t => t.isDuplicate).length,
    // Handlers
    warmup,
    handleFileChange, handleConfirm, doReceiptSave, handleSkip,
    handleStatementImport, handleClose, openRowEdit, saveRowEdit, setRowCard,
    setSplitItemCategory, handleSplitSave,
    setScanError,
  };
}
