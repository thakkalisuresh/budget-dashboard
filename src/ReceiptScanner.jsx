import React, { useState, useRef } from 'react';
import { Camera, X, Plus, AlertCircle, CheckCircle, ChevronRight, Upload, FileText } from 'lucide-react';
import { CATEGORIES, fetchDetailRows, checkExistingExpense, fuzzyNamesMatch, fetchAllLoggedTransactions, getAllCategoryNames, markNonMonthly } from './sheetsApi.js';
import { addOrUpdateExpense } from './useExpense.js';
import { applySmartRules } from './smartRules.js';

const CLAUDE_URL = '/api/claude'; // always via edge function — no direct browser API calls
const MAX_PX     = 1600;
const JPEG_Q     = 0.85;
const MAX_PDF_MB = 5;

// Cache the last good FX rate locally — survives 24h. Used as fallback if the
// upstream API is wrong/rate-limited/compromised so we don't write a wildly
// incorrect USD amount based on a malicious rate.
const FX_CACHE_KEY = 'budget_fx_rate_cache';
const FX_CACHE_TTL = 24 * 60 * 60 * 1000;

// Order-of-magnitude bounds. A rate outside this window for the listed currency
// is almost certainly wrong — we fall back to cache or static defaults.
const FX_PLAUSIBLE = {
  USD: [1, 1],
  EUR: [0.7, 1.5],
  GBP: [0.6, 1.3],
  CAD: [1.0, 2.0],
  AUD: [1.0, 2.5],
  JPY: [80, 200],
  INR: [60, 120],
  CHF: [0.7, 1.5],
  CNY: [5, 9],
  MXN: [15, 30],
  SGD: [1.1, 2.0],
};

function loadFxCache(currency) {
  try {
    const raw = localStorage.getItem(FX_CACHE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    const entry = obj?.[currency];
    if (entry && Date.now() - entry.t < FX_CACHE_TTL) return entry.r;
  } catch { /* ignore */ }
  return null;
}

function saveFxCache(currency, rate) {
  try {
    const raw = localStorage.getItem(FX_CACHE_KEY) || '{}';
    const obj = JSON.parse(raw);
    obj[currency] = { r: rate, t: Date.now() };
    localStorage.setItem(FX_CACHE_KEY, JSON.stringify(obj));
  } catch { /* ignore */ }
}

function isPlausibleRate(currency, rate) {
  if (typeof rate !== 'number' || !isFinite(rate) || rate <= 0) return false;
  const bounds = FX_PLAUSIBLE[currency];
  if (!bounds) return rate > 0 && rate < 1e6; // unknown currency: just guard against absurdities
  return rate >= bounds[0] && rate <= bounds[1];
}

// ── MIME validation via magic bytes (not file extension) ─────────────────────
async function detectMimeType(file) {
  const buf   = await file.slice(0, 12).arrayBuffer();
  const bytes = new Uint8Array(buf);
  const b     = (i) => bytes[i];

  if (b(0) === 0xFF && b(1) === 0xD8 && b(2) === 0xFF) return 'image/jpeg';
  if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4E && b(3) === 0x47) return 'image/png';
  if (b(0) === 0x47 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x38) return 'image/gif';
  if (b(0) === 0x25 && b(1) === 0x50 && b(2) === 0x44 && b(3) === 0x46) return 'application/pdf';
  if (b(0) === 0x52 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x46 &&
      b(8) === 0x57 && b(9) === 0x45 && b(10) === 0x42 && b(11) === 0x50) return 'image/webp';
  // HEIC/HEIF — ftyp box at offset 4
  if (b(4) === 0x66 && b(5) === 0x74 && b(6) === 0x79 && b(7) === 0x70) return 'image/heic';
  return null;
}

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif', 'application/pdf',
]);

// ── helpers ──────────────────────────────────────────────────────────────────

function compressImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, MAX_PX / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width  = Math.round(img.width  * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Compression failed')), 'image/jpeg', JPEG_Q);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not load image')); };
    img.src = url;
  });
}

function toBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/** Send image/PDF to Claude and extract receipt OR statement transactions */
async function extractFromFile(file, accessToken) {
  // Validate actual file content via magic bytes — don't trust the file extension
  const detectedMime = await detectMimeType(file);
  if (!detectedMime || !ALLOWED_MIME_TYPES.has(detectedMime)) {
    throw new Error('Unsupported file type. Please upload an image or PDF.');
  }

  let blob = file;
  let mediaType = detectedMime;

  if (detectedMime === 'application/pdf') {
    if (file.size > MAX_PDF_MB * 1024 * 1024) {
      throw new Error(`PDF is too large (max ${MAX_PDF_MB} MB). Try a screenshot instead.`);
    }
  } else {
    blob      = await compressImage(file);
    mediaType = 'image/jpeg';
  }

  const base64 = await toBase64(blob);
  const contentBlock = file.type === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
    : { type: 'image',    source: { type: 'base64', media_type: mediaType,          data: base64 } };

  const prompt = `You are a financial document parser. Analyse this image and determine if it is:
1. A RECEIPT — a single-vendor purchase document (grocery receipt, restaurant bill, invoice)
2. A BANK STATEMENT or transaction list — multiple rows of transactions from different merchants

If it is a RECEIPT, return exactly this JSON:
{"type":"receipt","vendor":"Store Name","amount":45.23,"category":"Grocery","currency":"USD"}

If it is a BANK STATEMENT or transaction list, return exactly this JSON:
{"type":"statement","transactions":[
  {"vendor":"Merchant Name","amount":12.34,"category":"Grocery","date":"04/27/2026","txType":"debit"},
  {"vendor":"Another Store","amount":56.78,"category":"Shopping","date":"04/26/2026","txType":"debit"}
]}

Categories to use (pick the closest match): ${CATEGORIES.join(', ')}

Rules:
- RECEIPT: amount is the final total including tax. currency is the 3-letter ISO code visible on the receipt (e.g. USD, CAD, EUR, GBP). Default to USD if not shown.
- STATEMENT: include ONLY debit/purchase transactions where money left the account. For each transaction set txType to "debit" or "credit".
- CRITICAL: If a transaction has a negative amount, a minus sign, is shown in red, or is labeled as refund/credit/return/reversal/payment, set txType to "credit". Do NOT include credits in the results.
- Clean up truncated bank merchant names (e.g. "SEATTLEYELLOWCA HOLD" → "Seattle Yellow Cab", "WF SUPERMARKET" → "Whole Foods")
- amount must be a positive number with no $ sign, or null if unclear
- category must be exactly one value from the list, or null if none fit
- date: use the date shown in the statement as-is, or null if not visible
- If the image is unreadable, return {"type":"receipt","vendor":null,"amount":null,"category":null,"currency":"USD"}
- Respond with ONLY valid JSON — no extra text`;

  const headers = { 'content-type': 'application/json' };
  if (accessToken) headers['authorization'] = `Bearer ${accessToken}`;
  const res = await fetch(CLAUDE_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 1024,
      stream: true,
      messages: [{ role: 'user', content: [contentBlock, { type: 'text', text: prompt }] }],
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    console.error('Anthropic API error:', JSON.stringify(err));
    throw new Error(err?.error?.message || JSON.stringify(err));
  }

  const reader  = res.body.getReader();
  const decoder = new TextDecoder();
  let fullText  = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    for (const line of chunk.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;
      try {
        const parsed = JSON.parse(data);
        if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
          fullText += parsed.delta.text;
        }
      } catch { /* skip malformed lines */ }
    }
  }

  try {
    const match = fullText.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
  } catch { /* fall through */ }

  return { type: 'receipt', vendor: null, amount: null, category: null };
}

/** Validate transaction categories — replace anything not in CATEGORIES with 'Misc' */
function validateCategories(transactions) {
  const valid = new Set(CATEGORIES);
  return transactions.map(t => ({
    ...t,
    category: valid.has(t.category) ? t.category : 'Misc',
  }));
}

/** Check extracted statement transactions against existing logged expenses to flag duplicates.
 *  Checks across ALL active categories — not just the Claude-assigned one — so a transaction
 *  logged in Entertainment won't slip through if Claude assigned it to Utilities.
 *  Also corrects the category to match wherever it was actually found.
 */
async function checkDuplicates(transactions, accessToken, sheetId, allCategories = []) {
  // Get real-time category list — includes static + any custom categories added since last load
  const liveCategories = getAllCategoryNames();

  const categoriesToFetch = [...new Set([
    ...transactions.map(t => t.category).filter(Boolean),
    ...allCategories,
    ...liveCategories,
  ])];

  const existingMap = {};
  await Promise.all(categoriesToFetch.map(async (cat) => {
    try {
      const rows = await fetchDetailRows(cat, accessToken, sheetId);
      existingMap[cat] = rows;
    } catch { existingMap[cat] = []; }
  }));

  return transactions.map(t => {
    let isDuplicate = false;
    let matchedCategory = null;

    // Check every fetched category, not just the one Claude picked
    for (const [cat, rows] of Object.entries(existingMap)) {
      const found = rows.some(row => {
        const amountMatch = row.amounts?.some(a => Math.abs(a - t.amount) < 0.05);
        if (!amountMatch) return false;
        return fuzzyNamesMatch(row.description, t.vendor);
      });
      if (found) { isDuplicate = true; matchedCategory = cat; break; }
    }

    return {
      ...t,
      // Correct the category to where it was actually found
      category: matchedCategory || t.category,
      selected: !isDuplicate,
      isDuplicate,
    };
  });
}

// ── component ─────────────────────────────────────────────────────────────────

export function ReceiptScanButton({ accessToken, sheetId, monthName, onSuccess, activeCategories = [], scanTriggerRef, smartRules = [], onSaveRecurring }) {
  // phase: idle | processing | confirming | saving | statement-reviewing | statement-importing | summary
  const [phase, setPhase]         = useState('idle');
  const [scanError, setScanError] = useState('');
  const [processingProgress, setProcessingProgress] = useState(null); // { current, total }
  const [unmatchedLogged, setUnmatchedLogged]       = useState([]);   // logged but not in statement

  // Single receipt (queue) state
  const [queue, setQueue]           = useState([]);
  const [queueIndex, setQueueIndex] = useState(0);
  const [wasUnreadable, setWasUnreadable] = useState(false);
  const [vendor, setVendor]     = useState('');
  const [amount, setAmount]     = useState('');
  const [category, setCategory] = useState('');
  const [isRandom, setIsRandom] = useState(false);
  const [formErr, setFormErr]   = useState('');
  const [dupWarning, setDupWarning] = useState(false);
  const [savedReceipts, setSavedReceipts] = useState([]);
  const [foreignCurrency, setForeignCurrency] = useState(null); // { original, rate, converted }
  const [showCurrencyPrompt, setShowCurrencyPrompt] = useState(false);

  // Statement state
  const [stmtTransactions, setStmtTransactions] = useState([]); // [{vendor,amount,category,date,selected,isDuplicate}]
  const [stmtSavedCount, setStmtSavedCount]     = useState(0);

  // Row edit state
  const [editingIndex, setEditingIndex]   = useState(null);
  const [editVendor, setEditVendor]       = useState('');
  const [editAmount, setEditAmount]       = useState('');
  const [editCategory, setEditCategory]   = useState('');
  const [editErr, setEditErr]             = useState('');

  const fileInputRef = useRef(null);

  // Expose trigger to parent (FAB speed dial)
  React.useEffect(() => {
    if (scanTriggerRef) scanTriggerRef.current = () => fileInputRef.current?.click();
  }, [scanTriggerRef]);

  const inputCls    = "w-full bg-slate-50 dark:bg-slate-700/60 border border-slate-200 dark:border-slate-600 text-slate-900 dark:text-slate-100 rounded-2xl px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-400 transition-all placeholder:text-slate-400";
  const inputErrCls = "w-full bg-rose-50 dark:bg-rose-900/20 border border-rose-300 dark:border-rose-700 text-slate-900 dark:text-slate-100 rounded-2xl px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-rose-500/40 placeholder:text-rose-300 transition-all";

  // ── process a single receipt file ────────────────────────────────────────
  const processReceiptFile = async (file) => {
    setPhase('processing');
    setScanError('');
    setDupWarning(false);
    try {
      const result = await extractFromFile(file, accessToken);

      // Statement detected — run duplicate check then switch to statement flow
      if (result.type === 'statement' && result.transactions?.length) {
        const debitsOnly = result.transactions.filter(t => t.txType !== 'credit');
        const withFlags = debitsOnly.map(t => ({ ...t, isNonMonthly: false, isRecurring: false }));
        const checked = await checkDuplicates(validateCategories(withFlags), accessToken, sheetId, activeCategories);
        setStmtTransactions(checked);
        setPhase('statement-reviewing');
        return;
      }

      // Single receipt
      const unreadable = !result.vendor && result.amount == null && !result.category;
      setWasUnreadable(unreadable);
      setVendor(result.vendor || '');
      // Smart rules override Claude's category guess
      const ruleCategory = applySmartRules(result.vendor, smartRules);
      setCategory(ruleCategory || result.category || 'Misc');
      setIsRandom(false);
      setFormErr('');
      setForeignCurrency(null);
      setShowCurrencyPrompt(false);

      // Foreign currency detection
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
        } catch {
          /* network failed — fall through to cache */
        }
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

  // ── file(s) selected ─────────────────────────────────────────────────────
  const handleFileChange = async (e) => {
    const files = Array.from(e.target.files || []);
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (!files.length) return;

    setSavedReceipts([]);
    setQueueIndex(0);
    setScanError('');
    setUnmatchedLogged([]);

    // Single file — use existing logic
    if (files.length === 1) {
      setQueue(files);
      await processReceiptFile(files[0]);
      return;
    }

    // Multiple files — process all, merge statements
    setPhase('processing');
    setProcessingProgress({ current: 0, total: files.length });

    const receiptFiles = [];
    let allStmtTransactions = [];

    for (let i = 0; i < files.length; i++) {
      setProcessingProgress({ current: i + 1, total: files.length });
      try {
        const result = await extractFromFile(files[i], accessToken);
        if (result.type === 'statement' && result.transactions?.length) {
          const debits = result.transactions.filter(t => t.txType !== 'credit').map(t => ({ ...t, isNonMonthly: false, isRecurring: false }));
          allStmtTransactions = [...allStmtTransactions, ...debits];
        } else {
          receiptFiles.push(files[i]);
        }
      } catch {
        receiptFiles.push(files[i]); // treat failed files as receipts
      }
    }

    setProcessingProgress(null);

    if (allStmtTransactions.length > 0) {
      const checked = await checkDuplicates(validateCategories(allStmtTransactions), accessToken, sheetId, activeCategories);
      setStmtTransactions(checked);
      // Queue any receipts from this batch for after statement import
      if (receiptFiles.length > 0) {
        setQueue(receiptFiles);
        setQueueIndex(0);
      }
      setPhase('statement-reviewing');
    } else {
      // All receipts
      setQueue(receiptFiles);
      await processReceiptFile(receiptFiles[0]);
    }
  };

  // ── confirm & save single receipt ────────────────────────────────────────
  const doReceiptSave = async () => {
    const amt = parseFloat(amount);
    setDupWarning(false);
    setPhase('saving');
    try {
      await addOrUpdateExpense(category, vendor.trim(), amt, accessToken, sheetId, monthName, 'scan', isRandom);
      // Non-monthly tracking now handled via UserSettings only (no I4 writes)

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
        setPhase('summary'); // shows combined summary (receipts + any prior statement imports)
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

    // Duplicate check
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

  // ── import selected statement transactions ───────────────────────────────
  const handleStatementImport = async () => {
    const toImport = stmtTransactions.filter(t => t.selected);
    if (!toImport.length) { handleClose(); return; }

    setPhase('statement-importing');
    let count = 0;
    for (const t of toImport) {
      try {
        await addOrUpdateExpense(
          t.category || 'Misc', t.vendor, t.amount,
          accessToken, sheetId, monthName, 'import', false
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

    // ── Logged but not in statement ──────────────────────────────────────
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
      } catch { /* non-critical — skip silently */ }
    }

    // ── If receipts are queued from a mixed upload, process them now ─────
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

  // ── row edit helpers ─────────────────────────────────────────────────────
  const openRowEdit = (i) => {
    const t = stmtTransactions[i];
    setEditVendor(t.vendor || '');
    setEditAmount(t.amount != null ? String(t.amount) : '');
    setEditCategory(t.category || '');
    setEditErr('');
    setEditingIndex(i);
  };

  const saveRowEdit = () => {
    if (!editVendor.trim())                   { setEditErr('Please enter a vendor name.');  return; }
    const amt = parseFloat(editAmount);
    if (isNaN(amt) || amt <= 0)               { setEditErr('Please enter a valid amount.'); return; }
    if (!editCategory)                        { setEditErr('Please select a category.');    return; }
    setStmtTransactions(prev => prev.map((t, i) =>
      i === editingIndex ? { ...t, vendor: editVendor.trim(), amount: amt, category: editCategory } : t
    ));
    setEditingIndex(null);
  };

  const totalInQueue   = queue.length;
  const currentNum     = queueIndex + 1;
  const selectedCount  = stmtTransactions.filter(t => t.selected).length;
  const duplicateCount = stmtTransactions.filter(t => t.isDuplicate).length;

  // ── render ───────────────────────────────────────────────────────────────
  return (
    <>
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".jpg,.jpeg,.png,.gif,.webp,.heic,.heif,.pdf,image/*"
        multiple
        className="hidden"
        onChange={handleFileChange}
      />

      {/* Scan / Import button */}
      <button
        onClick={() => fileInputRef.current?.click()}
        disabled={phase === 'processing'}
        title="Scan receipt or import bank statement"
        className="flex-shrink-0 flex items-center gap-2 px-4 py-2 sm:px-5 sm:py-2.5 bg-white dark:bg-slate-700 text-slate-600 dark:text-slate-200 border border-slate-200 dark:border-slate-600 rounded-2xl text-sm font-bold hover:bg-slate-50 dark:hover:bg-slate-600 shadow-sm transition-all active:scale-95 disabled:opacity-50"
      >
        {phase === 'processing' ? (
          <>
            <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
            </svg>
            <span className="hidden sm:inline">
              {processingProgress
                ? `Reading ${processingProgress.current} of ${processingProgress.total}…`
                : 'Reading…'}
            </span>
          </>
        ) : (
          <>
            <Camera className="w-4 h-4" />
            <span className="hidden sm:inline">Scan / Import</span>
          </>
        )}
      </button>

      {/* ── Scan error modal ── */}
      {scanError && (
        <>
          <div className="fixed inset-0 bg-black/40 z-40 backdrop-blur-sm" onClick={() => setScanError('')} />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="bg-white dark:bg-slate-800 rounded-[2rem] shadow-2xl w-full max-w-sm p-8 border border-rose-100 dark:border-rose-900/40 space-y-5">
              <div className="flex items-start gap-4">
                <div className="w-10 h-10 bg-rose-50 dark:bg-rose-900/30 rounded-2xl flex items-center justify-center flex-shrink-0">
                  <AlertCircle className="w-5 h-5 text-rose-500" />
                </div>
                <p className="text-sm font-medium text-slate-700 dark:text-slate-200 leading-relaxed pt-1">{scanError}</p>
              </div>
              <button onClick={() => setScanError('')} className="w-full py-3 rounded-2xl text-sm font-bold text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors">
                OK
              </button>
            </div>
          </div>
        </>
      )}

      {/* ── Single receipt confirmation modal ── */}
      {(phase === 'confirming' || phase === 'saving') && (
        <>
          <div className="fixed inset-0 bg-black/40 dark:bg-black/60 z-40 backdrop-blur-sm" onClick={phase === 'saving' ? undefined : handleClose} />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="bg-white dark:bg-slate-800 rounded-[2rem] shadow-2xl w-full max-w-md border border-slate-100 dark:border-slate-700 overflow-hidden max-h-[90vh] flex flex-col">

              <div className="px-8 pt-8 pb-6 border-b border-slate-100 dark:border-slate-700 flex items-start justify-between flex-shrink-0">
                <div>
                  <div className="flex items-center gap-2">
                    <p className="text-lg font-black text-slate-800 dark:text-slate-100">Review Receipt</p>
                    {totalInQueue > 1 && (
                      <span className="text-xs font-bold px-2.5 py-1 bg-indigo-100 dark:bg-indigo-900/40 text-indigo-600 dark:text-indigo-400 rounded-full">
                        {currentNum} of {totalInQueue}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-slate-400 mt-0.5">
                    {wasUnreadable ? "Couldn't read clearly — please fill in manually" : 'Verify the details before saving'}
                  </p>
                </div>
                <button onClick={phase === 'saving' ? undefined : handleClose} className="p-2 rounded-xl text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors">
                  <X className="w-5 h-5" />
                </button>
              </div>

              {totalInQueue > 1 && (
                <div className="px-8 pt-4 flex-shrink-0">
                  <div className="w-full bg-slate-100 dark:bg-slate-700 rounded-full h-1.5">
                    <div className="bg-indigo-500 h-1.5 rounded-full transition-all duration-300" style={{ width: `${(currentNum / totalInQueue) * 100}%` }} />
                  </div>
                </div>
              )}

              {wasUnreadable && (
                <div className="mx-8 mt-5 flex items-start gap-3 px-4 py-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700/40 rounded-2xl flex-shrink-0">
                  <AlertCircle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
                  <p className="text-xs font-medium text-amber-800 dark:text-amber-300 leading-relaxed">The receipt was unclear. All fields need to be filled in manually.</p>
                </div>
              )}

              <div className="overflow-y-auto flex-1 px-8 py-6 space-y-5">

                {/* Foreign currency notice */}
                {showCurrencyPrompt && foreignCurrency && (
                  <div className="flex items-start gap-3 px-4 py-3 bg-sky-50 dark:bg-sky-900/20 border border-sky-200 dark:border-sky-700/40 rounded-2xl">
                    <span className="text-lg flex-shrink-0">💱</span>
                    <div>
                      <p className="text-xs font-black text-sky-800 dark:text-sky-300">Foreign currency detected</p>
                      <p className="text-xs text-sky-700 dark:text-sky-400 mt-0.5 leading-relaxed">
                        Receipt shows <span className="font-black">{foreignCurrency.currency} {foreignCurrency.original.toFixed(2)}</span>.
                        Converted to <span className="font-black">USD {foreignCurrency.converted.toFixed(2)}</span> at today's rate
                        (1 USD = {foreignCurrency.rate.toFixed(4)} {foreignCurrency.currency}).
                      </p>
                    </div>
                  </div>
                )}

                <div className="space-y-1.5">
                  <label className="text-[11px] font-black uppercase tracking-widest text-slate-400">Vendor / Name</label>
                  <input type="text" value={vendor} onChange={e => setVendor(e.target.value)} placeholder="e.g. Walmart" autoFocus={wasUnreadable} className={!vendor.trim() && formErr ? inputErrCls : inputCls} />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[11px] font-black uppercase tracking-widest text-slate-400">Category</label>
                  <select value={category} onChange={e => setCategory(e.target.value)} className={`${!category && formErr ? inputErrCls : inputCls} cursor-pointer`}>
                    <option value="">Select a category…</option>
                    {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <label className="text-[11px] font-black uppercase tracking-widest text-slate-400">Amount</label>
                  <div className="relative">
                    <span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 font-bold text-sm">$</span>
                    <input type="number" step="0.01" min="0.01" placeholder="0.00" value={amount} onChange={e => setAmount(e.target.value)} className={`${(!amount || parseFloat(amount) <= 0) && formErr ? inputErrCls : inputCls} pl-8`} />
                  </div>
                </div>
                <label className="flex items-start gap-3 cursor-pointer group">
                  <div className="relative flex-shrink-0 mt-0.5">
                    <input type="checkbox" checked={isRandom} onChange={e => setIsRandom(e.target.checked)} className="sr-only" />
                    <div className={`w-5 h-5 rounded-md border-2 flex items-center justify-center transition-colors ${isRandom ? 'bg-indigo-600 border-indigo-600' : 'border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700'}`}>
                      {isRandom && <svg className="w-3 h-3 text-white" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                    </div>
                  </div>
                  <div>
                    <p className="text-sm font-bold text-slate-700 dark:text-slate-200 group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">One-time / random expense</p>
                    <p className="text-xs text-slate-400 mt-0.5">Marks this as a non-monthly expense</p>
                  </div>
                </label>
                {formErr && <p className="text-xs text-rose-500 font-medium bg-rose-50 dark:bg-rose-900/20 px-4 py-2.5 rounded-xl">{formErr}</p>}

                {/* Duplicate warning */}
                {dupWarning && (
                  <div className="flex items-start gap-3 px-4 py-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700/40 rounded-2xl">
                    <svg className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg>
                    <p className="text-xs font-medium text-amber-800 dark:text-amber-300 leading-relaxed">
                      <span className="font-black">{vendor.trim()} ${parseFloat(amount).toFixed(2)}</span> is already logged in <span className="font-black">{category}</span> this month. Add it again?
                    </p>
                  </div>
                )}
              </div>

              <div className="px-8 pb-8 pt-2 flex gap-3 flex-shrink-0">
                {totalInQueue > 1 && !dupWarning ? (
                  <button onClick={handleSkip} disabled={phase === 'saving'} className="flex-1 py-3 rounded-2xl text-sm font-bold text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors disabled:opacity-50">Skip</button>
                ) : (
                  <button onClick={dupWarning ? () => setDupWarning(false) : handleClose} disabled={phase === 'saving'} className="flex-1 py-3 rounded-2xl text-sm font-bold text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors disabled:opacity-50">
                    {dupWarning ? 'Go Back' : 'Cancel'}
                  </button>
                )}
                <button
                  onClick={dupWarning ? doReceiptSave : handleConfirm}
                  disabled={phase === 'saving'}
                  className={`flex-1 py-3 rounded-2xl text-sm font-bold text-white shadow-lg transition-all active:scale-[0.98] disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2 ${
                    dupWarning
                      ? 'bg-amber-500 hover:bg-amber-600 shadow-amber-200 dark:shadow-amber-900/30'
                      : 'bg-indigo-600 hover:bg-indigo-700 shadow-indigo-200 dark:shadow-indigo-900/30'
                  }`}
                >
                  {phase === 'saving' ? (
                    <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/></svg>
                  ) : totalInQueue > 1 && currentNum < totalInQueue && !dupWarning ? (
                    <ChevronRight className="w-4 h-4" />
                  ) : (
                    <Plus className="w-4 h-4" />
                  )}
                  {phase === 'saving' ? 'Saving…' : dupWarning ? 'Add Anyway' : totalInQueue > 1 && currentNum < totalInQueue ? 'Save & Next' : 'Add Expense'}
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {/* ── Statement review modal ── */}
      {(phase === 'statement-reviewing' || phase === 'statement-importing') && (
        <>
          <div className="fixed inset-0 bg-black/40 dark:bg-black/60 z-40 backdrop-blur-sm" onClick={phase === 'statement-importing' ? undefined : handleClose} />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="bg-white dark:bg-slate-800 rounded-[2rem] shadow-2xl w-full max-w-lg border border-slate-100 dark:border-slate-700 overflow-hidden max-h-[90vh] flex flex-col">

              {/* Header */}
              <div className="px-6 pt-7 pb-5 border-b border-slate-100 dark:border-slate-700 flex items-start justify-between flex-shrink-0">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <FileText className="w-5 h-5 text-indigo-500" />
                    <p className="text-lg font-black text-slate-800 dark:text-slate-100">
                      {stmtTransactions.length} Transaction{stmtTransactions.length !== 1 ? 's' : ''} Found
                    </p>
                  </div>
                  <p className="text-xs text-slate-400">
                    {selectedCount} selected for import
                    {duplicateCount > 0 && (
                      <span className="ml-2 text-amber-500 font-bold">· {duplicateCount} possible duplicate{duplicateCount !== 1 ? 's' : ''} unchecked</span>
                    )}
                  </p>
                </div>
                <button onClick={phase === 'statement-importing' ? undefined : handleClose} className="p-2 rounded-xl text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors">
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Duplicate warning */}
              {duplicateCount > 0 && (
                <div className="mx-6 mt-4 flex items-start gap-3 px-4 py-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700/40 rounded-2xl flex-shrink-0">
                  <AlertCircle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
                  <p className="text-xs font-medium text-amber-800 dark:text-amber-300 leading-relaxed">
                    {duplicateCount} transaction{duplicateCount !== 1 ? 's' : ''} already appear to be logged this month and have been unchecked. Review before importing.
                  </p>
                </div>
              )}

              {/* Select all / deselect all */}
              <div className="px-6 pt-4 pb-2 flex items-center gap-3 flex-shrink-0">
                <button
                  onClick={() => setStmtTransactions(prev => prev.map(t => ({ ...t, selected: true })))}
                  className="text-xs font-bold text-indigo-600 dark:text-indigo-400 hover:underline"
                >
                  Select all
                </button>
                <span className="text-slate-300 dark:text-slate-600">·</span>
                <button
                  onClick={() => setStmtTransactions(prev => prev.map(t => ({ ...t, selected: false })))}
                  className="text-xs font-bold text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:underline"
                >
                  Deselect all
                </button>
              </div>

              {/* Transaction list */}
              <div className="overflow-y-auto flex-1 px-6 pb-4 space-y-2">
                {stmtTransactions.map((t, i) => (
                  <div
                    key={i}
                    className={`flex flex-col p-3 rounded-2xl border transition-all bg-white dark:bg-slate-700/50 ${
                      t.selected
                        ? 'border-indigo-400 dark:border-indigo-500 shadow-sm shadow-indigo-100 dark:shadow-none'
                        : 'border-slate-200 dark:border-slate-600/40'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                    {/* Checkbox — toggles selection only */}
                    <div
                      onClick={() => setStmtTransactions(prev => prev.map((x, j) => j === i ? { ...x, selected: !x.selected } : x))}
                      className={`w-5 h-5 rounded-md border-2 flex items-center justify-center flex-shrink-0 transition-colors cursor-pointer ${
                        t.selected ? 'bg-indigo-600 border-indigo-600' : 'border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700'
                      }`}
                    >
                      {t.selected && <svg className="w-3 h-3 text-white" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                    </div>

                    {/* Details — tapping opens edit modal */}
                    <div className="flex-1 min-w-0 cursor-pointer" onClick={() => openRowEdit(i)}>
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-bold text-slate-800 dark:text-slate-100 truncate">
                          {t.vendor || 'Unknown'}
                        </p>
                        {t.isDuplicate && (
                          <span className="text-[10px] font-black px-2 py-0.5 bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400 rounded-full whitespace-nowrap">Already logged</span>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
                          {t.category || 'No category'}
                        </span>
                        {t.date && <span className="text-xs text-slate-400">· {t.date}</span>}
                      </div>
                    </div>

                    {/* Amount + edit icon */}
                    <div className="flex items-center gap-2 flex-shrink-0 cursor-pointer" onClick={() => openRowEdit(i)}>
                      <p className="text-sm font-black text-slate-700 dark:text-slate-200">${t.amount?.toFixed(2)}</p>
                      <svg className="w-3.5 h-3.5 text-slate-300 dark:text-slate-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536M9 13l6.586-6.586a2 2 0 112.828 2.828L11.828 15.828a2 2 0 01-1.414.586H9v-2a2 2 0 01.586-1.414z" />
                      </svg>
                    </div>
                    </div>
                    {/* One-time / recurring toggles */}
                    <div className="flex gap-3 mt-1.5 pl-8">
                    <label className="flex items-center gap-1.5 cursor-pointer" onClick={e => e.stopPropagation()}>
                      <div
                        onClick={() => setStmtTransactions(prev => prev.map((x, j) => j === i ? { ...x, isNonMonthly: !x.isNonMonthly, isRecurring: x.isNonMonthly ? x.isRecurring : false } : x))}
                        className={`w-3.5 h-3.5 rounded border flex items-center justify-center flex-shrink-0 cursor-pointer ${t.isNonMonthly ? 'bg-indigo-600 border-indigo-600' : 'border-slate-300 dark:border-slate-600'}`}
                      >
                        {t.isNonMonthly && <svg className="w-2.5 h-2.5 text-white" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                      </div>
                      <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400">One-time</span>
                    </label>
                    <label className="flex items-center gap-1.5 cursor-pointer" onClick={e => e.stopPropagation()}>
                      <div
                        onClick={() => setStmtTransactions(prev => prev.map((x, j) => j === i ? { ...x, isRecurring: !x.isRecurring } : x))}
                        className={`w-3.5 h-3.5 rounded border flex items-center justify-center flex-shrink-0 cursor-pointer ${t.isRecurring ? 'bg-emerald-500 border-emerald-500' : 'border-slate-300 dark:border-slate-600'}`}
                      >
                        {t.isRecurring && <svg className="w-2.5 h-2.5 text-white" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                      </div>
                      <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400">Recurring</span>
                    </label>
                  </div>
                  </div>
                ))}
              </div>

              {/* Footer */}
              <div className="px-6 pb-7 pt-3 flex gap-3 flex-shrink-0 border-t border-slate-100 dark:border-slate-700">
                <button onClick={handleClose} disabled={phase === 'statement-importing'} className="flex-1 py-3 rounded-2xl text-sm font-bold text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors disabled:opacity-50">
                  Cancel
                </button>
                <button
                  onClick={handleStatementImport}
                  disabled={phase === 'statement-importing' || selectedCount === 0}
                  className="flex-1 py-3 rounded-2xl text-sm font-bold text-white bg-indigo-600 hover:bg-indigo-700 shadow-lg shadow-indigo-200 dark:shadow-indigo-900/30 transition-all active:scale-[0.98] disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {phase === 'statement-importing' ? (
                    <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/></svg>
                  ) : (
                    <Upload className="w-4 h-4" />
                  )}
                  {phase === 'statement-importing' ? 'Importing…' : `Import ${selectedCount} Transaction${selectedCount !== 1 ? 's' : ''}`}
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {/* ── Row edit modal ── */}
      {editingIndex !== null && (
        <>
          <div className="fixed inset-0 bg-black/40 dark:bg-black/60 z-[60] backdrop-blur-sm" onClick={() => setEditingIndex(null)} />
          <div className="fixed inset-0 z-[61] flex items-end sm:items-center justify-center sm:p-4">
            <div className="bg-white dark:bg-slate-800 rounded-t-[2rem] sm:rounded-[2rem] shadow-2xl w-full sm:max-w-sm border border-slate-100 dark:border-slate-700 overflow-hidden">
              <div className="w-10 h-1 bg-slate-200 dark:bg-slate-600 rounded-full mx-auto mt-3 mb-1 sm:hidden" />

              {/* Header */}
              <div className="px-6 pt-5 pb-4 border-b border-slate-100 dark:border-slate-700 flex items-center justify-between">
                <p className="text-base font-black text-slate-800 dark:text-slate-100">Edit Transaction</p>
                <button onClick={() => setEditingIndex(null)} className="p-1.5 rounded-xl text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors">
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Fields */}
              <div className="px-6 py-5 space-y-4">
                <div className="space-y-1.5">
                  <label className="text-[11px] font-black uppercase tracking-widest text-slate-400">Vendor / Name</label>
                  <input
                    type="text"
                    value={editVendor}
                    onChange={e => setEditVendor(e.target.value)}
                    placeholder="e.g. Whole Foods"
                    autoFocus
                    className={inputCls}
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[11px] font-black uppercase tracking-widest text-slate-400">Amount</label>
                  <div className="relative">
                    <span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 font-bold text-sm">$</span>
                    <input
                      type="number"
                      step="0.01"
                      min="0.01"
                      placeholder="0.00"
                      value={editAmount}
                      onChange={e => setEditAmount(e.target.value)}
                      className={`${inputCls} pl-8`}
                    />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <label className="text-[11px] font-black uppercase tracking-widest text-slate-400">Category</label>
                  <select value={editCategory} onChange={e => setEditCategory(e.target.value)} className={`${inputCls} cursor-pointer`}>
                    <option value="">Select a category…</option>
                    {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                {editErr && (
                  <p className="text-xs text-rose-500 font-medium bg-rose-50 dark:bg-rose-900/20 px-4 py-2.5 rounded-xl">{editErr}</p>
                )}
              </div>

              {/* Footer */}
              <div className="px-6 pb-6 pt-1 flex gap-3" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 1.5rem)' }}>
                <button onClick={() => setEditingIndex(null)} className="flex-1 py-3 rounded-2xl text-sm font-bold text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors">
                  Cancel
                </button>
                <button onClick={saveRowEdit} className="flex-1 py-3 rounded-2xl text-sm font-bold text-white bg-indigo-600 hover:bg-indigo-700 shadow-lg shadow-indigo-200 dark:shadow-indigo-900/30 transition-all active:scale-[0.98] flex items-center justify-center gap-2">
                  <CheckCircle className="w-4 h-4" /> Save
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {/* ── Summary modal (receipt queue or statement import) ── */}
      {phase === 'summary' && (
        <>
          <div className="fixed inset-0 bg-black/40 dark:bg-black/60 z-40 backdrop-blur-sm" onClick={handleClose} />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="bg-white dark:bg-slate-800 rounded-[2rem] shadow-2xl w-full max-w-md border border-slate-100 dark:border-slate-700 overflow-hidden max-h-[90vh] flex flex-col">

              <div className="px-8 pt-8 pb-6 border-b border-slate-100 dark:border-slate-700 flex-shrink-0">
                <div className="flex items-center gap-3 mb-1">
                  <div className="w-9 h-9 bg-emerald-100 dark:bg-emerald-900/30 rounded-2xl flex items-center justify-center">
                    <CheckCircle className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
                  </div>
                  <p className="text-lg font-black text-slate-800 dark:text-slate-100">
                    {stmtSavedCount > 0
                      ? `${stmtSavedCount} Transaction${stmtSavedCount !== 1 ? 's' : ''} Imported`
                      : savedReceipts.length === 1 ? '1 Receipt Added' : `${savedReceipts.length} Receipts Added`}
                  </p>
                </div>
                <p className="text-xs text-slate-400 ml-12">All expenses saved to {monthName}</p>
              </div>

              <div className="overflow-y-auto flex-1 px-8 py-6 space-y-3">
                {/* Imported transactions */}
                {stmtSavedCount > 0
                  ? stmtTransactions.filter(t => t.selected).map((t, i) => (
                      <div key={i} className="flex items-center justify-between py-3 px-4 bg-slate-50 dark:bg-slate-700/50 rounded-2xl">
                        <div>
                          <p className="text-sm font-bold text-slate-800 dark:text-slate-100">{t.vendor}</p>
                          <p className="text-xs text-slate-400 mt-0.5">{t.category}</p>
                        </div>
                        <p className="text-sm font-black text-slate-700 dark:text-slate-200">${t.amount?.toFixed(2)}</p>
                      </div>
                    ))
                  : savedReceipts.map((r, i) => (
                      <div key={i} className="flex items-center justify-between py-3 px-4 bg-slate-50 dark:bg-slate-700/50 rounded-2xl">
                        <div>
                          <p className="text-sm font-bold text-slate-800 dark:text-slate-100">{r.vendor}</p>
                          <p className="text-xs text-slate-400 mt-0.5">{r.category}</p>
                        </div>
                        <p className="text-sm font-black text-slate-700 dark:text-slate-200">${r.amount.toFixed(2)}</p>
                      </div>
                    ))
                }

                {/* Logged but not found in statement */}
                {unmatchedLogged.length > 0 && (
                  <div className="pt-2">
                    <div className="flex items-center gap-2 mb-3">
                      <AlertCircle className="w-4 h-4 text-amber-500 flex-shrink-0" />
                      <p className="text-xs font-black text-amber-700 dark:text-amber-400 uppercase tracking-wide">
                        Not found in statement ({unmatchedLogged.length})
                      </p>
                    </div>
                    <div className="flex items-start gap-2 px-3 py-2.5 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700/40 rounded-2xl mb-3">
                      <p className="text-xs text-amber-800 dark:text-amber-300 leading-relaxed">
                        These expenses are logged this month but didn't appear in the uploaded statement. They may be on a different account.
                      </p>
                    </div>
                    {unmatchedLogged.map((t, i) => (
                      <div key={i} className="flex items-center justify-between py-2.5 px-4 bg-amber-50/60 dark:bg-amber-900/10 border border-amber-100 dark:border-amber-800/30 rounded-2xl mb-2">
                        <div>
                          <p className="text-sm font-bold text-slate-700 dark:text-slate-300">{t.vendor}</p>
                          <p className="text-xs text-slate-400 mt-0.5">{t.category}</p>
                        </div>
                        <p className="text-sm font-black text-amber-600 dark:text-amber-400">${t.amount.toFixed(2)}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="px-8 pb-8 pt-2 flex gap-3 flex-shrink-0">
                <button onClick={handleClose} className="flex-1 py-3 rounded-2xl text-sm font-bold text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors">
                  Done
                </button>
                <button
                  onClick={() => { handleClose(); setTimeout(() => fileInputRef.current?.click(), 50); }}
                  className="flex-1 py-3 rounded-2xl text-sm font-bold text-white bg-indigo-600 hover:bg-indigo-700 shadow-lg shadow-indigo-200 dark:shadow-indigo-900/30 transition-all active:scale-[0.98] flex items-center justify-center gap-2"
                >
                  <Camera className="w-4 h-4" />
                  Scan More
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
}
