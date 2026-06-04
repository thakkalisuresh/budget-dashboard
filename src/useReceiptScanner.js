import { useState, useRef, useEffect } from 'react';
import { CATEGORIES, checkExistingExpense, fuzzyNamesMatch, fetchAllLoggedTransactions, markNonMonthly, normalizeStatementDate, todayIso } from './sheetsApi.js';
import { addOrUpdateExpense } from './useExpense.js';
import { applySmartRules, applyCardRules } from './smartRules.js';
import {
  extractFromFile, validateCategories, checkDuplicates, resolveCardName,
  loadFxCache, saveFxCache, isPlausibleRate,
} from './receiptHelpers.js';
import { resolveMCC } from './vendorMCC.js';

const CSR = 'Chase Sapphire Reserve';
const TRAVEL_MCCS = new Set(['4511', '7011', 'CHASE_PORTAL']);

export function useReceiptScanner({ accessToken, sheetId, monthName, onSuccess, activeCategories = [], scanTriggerRef, smartRules = [], cards = [], cardRules = [], onSaveRecurring }) {
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

  useEffect(() => {
    if (scanTriggerRef) scanTriggerRef.current = () => fileInputRef.current?.click();
  }, [scanTriggerRef]);

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

    const receiptFiles = [];
    let allStmtTransactions = [];

    for (let i = 0; i < files.length; i++) {
      setProcessingProgress({ current: i + 1, total: files.length });
      try {
        const result = await extractFromFile(files[i], accessToken, cards);
        if (result.type === 'statement' && result.transactions?.length) {
          const stmtCard = resolveCardName(result.paymentMethod, cards);
          const debits = result.transactions.filter(t => t.txType !== 'credit').map(t => ({
            ...t, isNonMonthly: false, isRecurring: false,
            card: stmtCard || applyCardRules(t.vendor, t.category, cardRules) || '',
          }));
          allStmtTransactions = [...allStmtTransactions, ...debits];
        } else {
          receiptFiles.push(files[i]);
        }
      } catch {
        receiptFiles.push(files[i]);
      }
    }

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

    if (queue.length > 0) {
      await processReceiptFile(queue[0]);
      return;
    }

    setPhase('summary');
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
    handleFileChange, handleConfirm, doReceiptSave, handleSkip,
    handleStatementImport, handleClose, openRowEdit, saveRowEdit, setRowCard,
    setScanError,
  };
}
