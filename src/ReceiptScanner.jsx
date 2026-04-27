import React, { useState, useRef } from 'react';
import { Camera, X, Plus, AlertCircle } from 'lucide-react';
import { CATEGORIES, addOrUpdateExpense, appendRandomExpenseNote } from './sheetsApi.js';

const DEV_API_KEY = import.meta.env.VITE_ANTHROPIC_API_KEY;
const IS_DEV      = import.meta.env.DEV;
const CLAUDE_URL  = IS_DEV ? 'https://api.anthropic.com/v1/messages' : '/api/claude';
const MAX_PX      = 1600;   // max dimension after resize
const JPEG_Q      = 0.85;   // jpeg quality
const MAX_PDF_MB  = 5;

// ── helpers ──────────────────────────────────────────────────────────────────

/** Resize + re-encode image to JPEG using canvas */
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

/** File → base64 string (no data-URL prefix) */
function toBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/** Send image/PDF to Claude Haiku and extract receipt fields */
async function extractReceipt(file) {
  let blob = file;
  let mediaType = file.type;

  if (file.type === 'application/pdf') {
    if (file.size > MAX_PDF_MB * 1024 * 1024) {
      throw new Error(`PDF is too large (max ${MAX_PDF_MB} MB). Try a screenshot of the receipt instead.`);
    }
  } else {
    // Compress — handles any size iPhone photo
    blob      = await compressImage(file);
    mediaType = 'image/jpeg';
  }

  const base64 = await toBase64(blob);

  const contentBlock = file.type === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
    : { type: 'image',    source: { type: 'base64', media_type: mediaType,          data: base64 } };

  const prompt = `You are a receipt parser. Extract from this receipt or bill:
1. Vendor / store name
2. Total amount paid (final total including tax, as a plain number)
3. Best matching category from this exact list: ${CATEGORIES.join(', ')}

Respond with ONLY a valid JSON object — no extra text:
{"vendor": "Store Name", "amount": 45.23, "category": "Grocery"}

Rules:
- amount must be a number with no $ sign, or null if unclear
- category must be exactly one value from the list, or null if none fit
- vendor is the business name only, or null if unreadable
- If the receipt is too blurry or unreadable, return {"vendor":null,"amount":null,"category":null}`;

  const res = await fetch(CLAUDE_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(IS_DEV && DEV_API_KEY ? {
        'x-api-key': DEV_API_KEY,
        'anthropic-dangerous-direct-browser-access': 'true',
      } : {}),
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 256,
      stream: true,
      messages: [{
        role: 'user',
        content: [contentBlock, { type: 'text', text: prompt }],
      }],
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    console.error('Anthropic API error:', JSON.stringify(err));
    throw new Error(err?.error?.message || JSON.stringify(err));
  }

  // Collect streamed text
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

  return { vendor: null, amount: null, category: null };
}

// ── component ─────────────────────────────────────────────────────────────────

export function ReceiptScanButton({ accessToken, sheetId, monthName, onSuccess }) {
  const [phase, setPhase]           = useState('idle'); // idle | processing | confirming | saving
  const [scanError, setScanError]   = useState('');
  const [wasUnreadable, setWasUnreadable] = useState(false);

  // Confirmation form
  const [vendor, setVendor]     = useState('');
  const [amount, setAmount]     = useState('');
  const [category, setCategory] = useState('');
  const [isRandom, setIsRandom] = useState(false);
  const [formErr, setFormErr]   = useState('');

  const fileInputRef = useRef(null);

  const inputCls    = "w-full bg-slate-50 dark:bg-slate-700/60 border border-slate-200 dark:border-slate-600 text-slate-900 dark:text-slate-100 rounded-2xl px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-400 transition-all placeholder:text-slate-400";
  const inputErrCls = "w-full bg-rose-50 dark:bg-rose-900/20 border border-rose-300 dark:border-rose-700 text-slate-900 dark:text-slate-100 rounded-2xl px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-rose-500/40 placeholder:text-rose-300 transition-all";

  // ── file selected ────────────────────────────────────────────────────────
  const handleFileChange = async (e) => {
    const file = e.target.files?.[0];
    // reset input so the same file can be re-selected after cancel
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (!file) return;

    setPhase('processing');
    setScanError('');

    try {
      const result = await extractReceipt(file);
      const unreadable = !result.vendor && result.amount == null && !result.category;
      setWasUnreadable(unreadable);
      setVendor(result.vendor   || '');
      setAmount(result.amount != null ? String(result.amount) : '');
      setCategory(result.category || 'Misc');
      setIsRandom(false);
      setFormErr('');
      setPhase('confirming');
    } catch (err) {
      setScanError(err.message || 'Failed to read receipt. Please try again.');
      setPhase('idle');
    }
  };

  // ── confirm & save ───────────────────────────────────────────────────────
  const handleConfirm = async () => {
    setFormErr('');
    if (!vendor.trim())                    { setFormErr('Please enter a vendor name.');    return; }
    if (!category)                         { setFormErr('Please select a category.');      return; }
    const amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0)            { setFormErr('Please enter a valid amount.');   return; }

    setPhase('saving');
    try {
      await addOrUpdateExpense(category, vendor.trim(), amt, accessToken, sheetId, monthName, 'scan', isRandom);
      if (isRandom) await appendRandomExpenseNote(sheetId, vendor.trim(), amt, accessToken);
      onSuccess?.();
      setPhase('idle');
    } catch (err) {
      setFormErr(err.message || 'Failed to save. Please try again.');
      setPhase('confirming');
    }
  };

  const handleClose = () => { setPhase('idle'); setScanError(''); setFormErr(''); };

  // ── render ───────────────────────────────────────────────────────────────
  return (
    <>
      {/* Hidden file input — no capture attr so iOS shows "Take Photo / Library / Browse" */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,application/pdf"
        className="hidden"
        onChange={handleFileChange}
      />

      {/* Scan button */}
      <button
        onClick={() => fileInputRef.current?.click()}
        disabled={phase === 'processing'}
        title="Scan a receipt"
        className="flex-shrink-0 flex items-center gap-2 px-4 py-2 sm:px-5 sm:py-2.5 bg-white dark:bg-slate-700 text-slate-600 dark:text-slate-200 border border-slate-200 dark:border-slate-600 rounded-2xl text-sm font-bold hover:bg-slate-50 dark:hover:bg-slate-600 shadow-sm transition-all active:scale-95 disabled:opacity-50"
      >
        {phase === 'processing' ? (
          <>
            <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
            </svg>
            <span className="hidden sm:inline">Reading…</span>
          </>
        ) : (
          <>
            <Camera className="w-4 h-4" />
            <span className="hidden sm:inline">Scan Receipt</span>
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
              <button
                onClick={() => setScanError('')}
                className="w-full py-3 rounded-2xl text-sm font-bold text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors"
              >
                OK
              </button>
            </div>
          </div>
        </>
      )}

      {/* ── Confirmation modal ── */}
      {(phase === 'confirming' || phase === 'saving') && (
        <>
          <div className="fixed inset-0 bg-black/40 dark:bg-black/60 z-40 backdrop-blur-sm" onClick={handleClose} />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="bg-white dark:bg-slate-800 rounded-[2rem] shadow-2xl w-full max-w-md border border-slate-100 dark:border-slate-700 overflow-hidden max-h-[90vh] flex flex-col">

              {/* Header */}
              <div className="px-8 pt-8 pb-6 border-b border-slate-100 dark:border-slate-700 flex items-start justify-between flex-shrink-0">
                <div>
                  <p className="text-lg font-black text-slate-800 dark:text-slate-100">Review Receipt</p>
                  <p className="text-xs text-slate-400 mt-0.5">
                    {wasUnreadable
                      ? "Couldn't read clearly — please fill in manually"
                      : 'Verify the details before saving'}
                  </p>
                </div>
                <button onClick={handleClose} className="p-2 rounded-xl text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors">
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Unreadable warning */}
              {wasUnreadable && (
                <div className="mx-8 mt-5 flex items-start gap-3 px-4 py-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700/40 rounded-2xl flex-shrink-0">
                  <AlertCircle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
                  <p className="text-xs font-medium text-amber-800 dark:text-amber-300 leading-relaxed">
                    The receipt was unclear. All fields need to be filled in manually.
                  </p>
                </div>
              )}

              {/* Form body */}
              <div className="overflow-y-auto flex-1 px-8 py-6 space-y-5">

                {/* Vendor */}
                <div className="space-y-1.5">
                  <label className="text-[11px] font-black uppercase tracking-widest text-slate-400">Vendor / Name</label>
                  <input
                    type="text"
                    value={vendor}
                    onChange={e => setVendor(e.target.value)}
                    placeholder="e.g. Walmart"
                    autoFocus={wasUnreadable}
                    className={!vendor.trim() && formErr ? inputErrCls : inputCls}
                  />
                </div>

                {/* Category */}
                <div className="space-y-1.5">
                  <label className="text-[11px] font-black uppercase tracking-widest text-slate-400">Category</label>
                  <select
                    value={category}
                    onChange={e => setCategory(e.target.value)}
                    className={`${!category && formErr ? inputErrCls : inputCls} cursor-pointer`}
                  >
                    <option value="">Select a category…</option>
                    {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>

                {/* Amount */}
                <div className="space-y-1.5">
                  <label className="text-[11px] font-black uppercase tracking-widest text-slate-400">Amount</label>
                  <div className="relative">
                    <span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 font-bold text-sm">$</span>
                    <input
                      type="number"
                      step="0.01"
                      min="0.01"
                      placeholder="0.00"
                      value={amount}
                      onChange={e => setAmount(e.target.value)}
                      className={`${(!amount || parseFloat(amount) <= 0) && formErr ? inputErrCls : inputCls} pl-8`}
                    />
                  </div>
                </div>

                {/* Random toggle */}
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

                {/* Form error */}
                {formErr && (
                  <p className="text-xs text-rose-500 font-medium bg-rose-50 dark:bg-rose-900/20 px-4 py-2.5 rounded-xl">
                    {formErr}
                  </p>
                )}
              </div>

              {/* Footer */}
              <div className="px-8 pb-8 pt-2 flex gap-3 flex-shrink-0">
                <button
                  onClick={handleClose}
                  disabled={phase === 'saving'}
                  className="flex-1 py-3 rounded-2xl text-sm font-bold text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleConfirm}
                  disabled={phase === 'saving'}
                  className="flex-1 py-3 rounded-2xl text-sm font-bold text-white bg-indigo-600 hover:bg-indigo-700 shadow-lg shadow-indigo-200 dark:shadow-indigo-900/30 transition-all active:scale-[0.98] disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {phase === 'saving'
                    ? <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/></svg>
                    : <Plus className="w-4 h-4" />}
                  {phase === 'saving' ? 'Saving…' : 'Add Expense'}
                </button>
              </div>

            </div>
          </div>
        </>
      )}
    </>
  );
}
