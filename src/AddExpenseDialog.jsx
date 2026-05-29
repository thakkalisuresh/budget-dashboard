import React, { useState, useEffect, useRef } from 'react';
import { X, Plus, Zap, Sparkles, MapPin, Loader2 } from 'lucide-react';
import { CATEGORIES, fetchDetailRows, checkExistingExpense, markNonMonthly, todayIso } from './sheetsApi.js';
import { addOrUpdateExpense } from './useExpense.js';
import { applySmartRules } from './smartRules.js';

const VENDOR_EXAMPLES = {
  'Grocery':       "e.g. Walmart, Costco, Trader Joe's…",
  'Eating Out':    'e.g. Wingstop, Dominos, Chipotle…',
  'Misc':          'e.g. Amazon, Target…',
  'Travel':        'e.g. Delta, Airbnb, Uber…',
  'Entertainment': 'e.g. Netflix, AMC, Spotify…',
  'Thakkali':      'e.g. Thakkali…',
  'Investment':    'e.g. Robinhood, Fidelity…',
  'Car Payments':  'e.g. Toyota, Tesla, Insurance…',
  'Utilities':     'e.g. PG&E, Water, Gas…',
  'Rent':          'e.g. Landlord, Apartment…',
  'Health':        'e.g. CVS, Doctor, Pharmacy…',
  'Furniture':     'e.g. IKEA, Wayfair, Amazon…',
  'Holiday':       'e.g. Hotels, Flights, Gifts…',
  'Wi-Fi':         'e.g. Comcast, AT&T…',
};

export function AddExpenseDialog({ accessToken, sheetId, monthName, onClose, onSuccess, categories: categoriesProp, onSaveRecurring, onSaveTransactionNote, smartRules = [], prefillCategory = null, lockCategory = false, prefillVendor = '', prefillAmount = '', geoTagEnabled = false, geoPrivacyBlur = true }) {
  const categoryList = categoriesProp?.length ? categoriesProp : CATEGORIES;
  const [category, setCategory]         = useState(prefillCategory || '');
  const [vendor, setVendor]             = useState(prefillVendor);
  const [ruleHint, setRuleHint]         = useState(''); // category auto-filled by a rule
  const [amount, setAmount]             = useState(prefillAmount);
  const [txDate, setTxDate]             = useState(todayIso);
  const [isNonMonthly, setIsNonMonthly] = useState(false);
  const [isRecurring, setIsRecurring]   = useState(false);
  const [saving, setSaving]             = useState(false);
  const submittingRef = useRef(false);
  const [error, setError]               = useState('');
  const [dupWarning, setDupWarning]     = useState(false);
  const [queued, setQueued]             = useState(false);
  const [addedToast, setAddedToast]     = useState(false);
  // Note / tag
  const [showNote, setShowNote]         = useState(false);
  const [txNote, setTxNote]             = useState('');
  const [txTagInput, setTxTagInput]     = useState('');
  const [txTags, setTxTags]             = useState([]);

  // Geo-tagging
  const [geoEnabled, setGeoEnabled]     = useState(false);
  const [geoLocation, setGeoLocation]   = useState(null); // {lat, lng}
  const [geoLoading, setGeoLoading]     = useState(false);
  const [geoError, setGeoError]         = useState('');

  const handleGeoToggle = async (enabled) => {
    setGeoEnabled(enabled);
    setGeoError('');
    if (!enabled) { setGeoLocation(null); return; }
    setGeoLoading(true);
    try {
      const pos = await new Promise((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 10000 })
      );
      const blur = (v) => geoPrivacyBlur ? Math.round(v * 200) / 200 : v;
      setGeoLocation({ lat: blur(pos.coords.latitude), lng: blur(pos.coords.longitude) });
    } catch {
      setGeoEnabled(false);
      setGeoError('Location access denied or unavailable');
    } finally {
      setGeoLoading(false);
    }
  };

  const addTxTag = () => {
    const tag = txTagInput.trim().replace(/^#/, '');
    if (tag && !txTags.includes(tag)) setTxTags(prev => [...prev, tag]);
    setTxTagInput('');
  };

  // Autocomplete state
  const [allVendors, setAllVendors]     = useState([]);
  const [suggestions, setSuggestions]   = useState([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [loadingVendors, setLoadingVendors]   = useState(false);
  const vendorInputRef = useRef(null);
  const suggestionsRef = useRef(null);

  // ── Natural-language quick-add ────────────────────────────────────────────
  const [nlText, setNlText]       = useState('');
  const [nlLoading, setNlLoading] = useState(false);
  const [nlError, setNlError]     = useState('');

  const parseNlExpense = async () => {
    if (!nlText.trim()) return;
    setNlLoading(true);
    setNlError('');
    try {
      const res = await fetch('/api/claude', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5',
          max_tokens: 256,
          system: [
            'You are an expense parser. Extract info from natural language expense descriptions.',
            `Return ONLY valid JSON: {"vendor":string,"amount":number|null,"date":"YYYY-MM-DD"|null,"category":string|null}`,
            `Today is ${todayIso}. Resolve relative dates like "yesterday" or "last monday" to ISO dates.`,
            `Available categories: ${categoryList.join(', ')}.`,
            'Use null for any field you cannot determine. No commentary, just JSON.',
          ].join(' '),
          messages: [{ role: 'user', content: nlText.trim() }],
        }),
      });
      if (!res.ok) throw new Error('api error');
      const data    = await res.json();
      const text    = data.content?.[0]?.text || '';
      const jsonStr = text.match(/\{[\s\S]*\}/)?.[0];
      if (!jsonStr) throw new Error('no json');
      const parsed = JSON.parse(jsonStr);
      if (parsed.vendor)   setVendor(parsed.vendor);
      if (parsed.amount != null) setAmount(String(parsed.amount));
      if (parsed.category && categoryList.includes(parsed.category)) setCategory(parsed.category);
      if (parsed.date)     setTxDate(parsed.date);
      setNlText('');
    } catch {
      setNlError('Couldn\'t parse — try "coffee 4.50 today eating out"');
    } finally {
      setNlLoading(false);
    }
  };

  const inputCls = "w-full bg-slate-50 dark:bg-slate-700/60 border border-slate-200 dark:border-slate-600 text-slate-900 dark:text-slate-100 rounded-2xl px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-400 transition-all placeholder:text-slate-400";

  // Fetch existing vendors when category changes
  useEffect(() => {
    if (!category) { setAllVendors([]); setSuggestions([]); return; }
    setLoadingVendors(true);
    setSuggestions([]);
    fetchDetailRows(category, accessToken, sheetId, monthName)
      .then(rows => setAllVendors(rows.map(r => r.description)))
      .catch(() => setAllVendors([]))
      .finally(() => setLoadingVendors(false));
  }, [category, accessToken]);

  // Filter suggestions as user types
  const handleVendorChange = (e) => {
    const val = e.target.value;
    setVendor(val);
    if (val.trim().length === 0) {
      setSuggestions([]);
      setShowSuggestions(false);
      setRuleHint('');
      return;
    }
    // Auto-fill category from smart rules
    const matched = applySmartRules(val, smartRules);
    if (matched && categoryList.includes(matched)) {
      setCategory(matched);
      setRuleHint(matched);
    } else {
      setRuleHint('');
    }
    const filtered = allVendors.filter(v =>
      v.toLowerCase().startsWith(val.trim().toLowerCase())
    );
    setSuggestions(filtered);
    setShowSuggestions(filtered.length > 0);
  };

  const pickSuggestion = (name) => {
    setVendor(name);
    setSuggestions([]);
    setShowSuggestions(false);
    // Move focus to amount field
    setTimeout(() => {
      document.getElementById('expense-amount')?.focus();
    }, 50);
  };

  const doSave = async () => {
    const amt = parseFloat(amount);
    setSaving(true);
    setDupWarning(false);
    try {
      const result = await addOrUpdateExpense(category, vendor.trim(), amt, accessToken, sheetId, monthName, 'manual', txDate);
      if (result?.queued) {
        if (isRecurring) onSaveRecurring?.({ category, vendor: vendor.trim(), amount: amt });
        setQueued(true);
        setSaving(false);
        onSuccess?.({ queued: true, category, vendor: vendor.trim(), amount: amt });
        setTimeout(onClose, 1800);
        return;
      }
      if (isNonMonthly) await markNonMonthly(sheetId, accessToken, vendor.trim(), amt);
      if (isRecurring) onSaveRecurring?.({ category, vendor: vendor.trim(), amount: amt });
      // Save transaction note/tags/location if provided
      if ((txNote.trim() || txTags.length > 0 || geoLocation) && onSaveTransactionNote) {
        const key = `${sheetId}_${category}_${vendor.trim().toLowerCase()}_${amt.toFixed(2)}`;
        onSaveTransactionNote(key, {
          note: txNote.trim(),
          tags: txTags,
          ...(geoLocation ? { location: { ...geoLocation, vendor: vendor.trim(), category, amount: amt } } : {}),
        });
      }
      onSuccess?.();
      onClose();
    } catch (err) {
      setError(err.message || 'Something went wrong. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const doSaveAndAnother = async () => {
    const amt = parseFloat(amount);
    setSaving(true);
    setDupWarning(false);
    try {
      const result = await addOrUpdateExpense(category, vendor.trim(), amt, accessToken, sheetId, monthName, 'manual', txDate);
      if (result?.queued) {
        if (isRecurring) onSaveRecurring?.({ category, vendor: vendor.trim(), amount: amt });
        onSuccess?.({ queued: true, category, vendor: vendor.trim(), amount: amt });
      } else {
        if (isNonMonthly) await markNonMonthly(sheetId, accessToken, vendor.trim(), amt);
        if (isRecurring) onSaveRecurring?.({ category, vendor: vendor.trim(), amount: amt });
        // Save transaction note/tags/location if provided
        if ((txNote.trim() || txTags.length > 0 || geoLocation) && onSaveTransactionNote) {
          const key = `${sheetId}_${category}_${vendor.trim().toLowerCase()}_${amt.toFixed(2)}`;
          onSaveTransactionNote(key, {
            note: txNote.trim(),
            tags: txTags,
            ...(geoLocation ? { location: { ...geoLocation, vendor: vendor.trim(), category, amount: amt } } : {}),
          });
        }
        onSuccess?.();
      }
      // Reset for next entry — keep category and date
      setVendor('');
      setAmount('');
      setIsNonMonthly(false);
      setError('');
      setDupWarning(false);
      setShowNote(false);
      setTxNote('');
      setTxTags([]);
      setGeoEnabled(false);
      setGeoLocation(null);
      setGeoError('');
      setAddedToast(true);
      setTimeout(() => setAddedToast(false), 2000);
    } catch (err) {
      setError(err.message || 'Something went wrong. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (submittingRef.current) return;
    submittingRef.current = true;
    setError('');
    setDupWarning(false);
    if (!category)      { setError('Please select a category.');                    submittingRef.current = false; return; }
    if (!vendor.trim()) { setError('Please enter a vendor name.');                  submittingRef.current = false; return; }
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) { setError('Please enter a valid amount greater than 0.'); submittingRef.current = false; return; }

    // Duplicate check
    setSaving(true);
    const isDuplicate = await checkExistingExpense(category, vendor.trim(), amt, accessToken, sheetId);
    setSaving(false);
    if (isDuplicate) { setDupWarning(true); submittingRef.current = false; return; }

    await doSave();
    submittingRef.current = false;
  };

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/40 dark:bg-black/60 z-40 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Dialog */}
      <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4">
        <div className="bg-white dark:bg-slate-800 rounded-t-[2rem] sm:rounded-[2rem] shadow-2xl w-full sm:max-w-md border border-slate-100 dark:border-slate-700 overflow-hidden max-h-[90vh] flex flex-col">
          <div className="w-10 h-1 bg-slate-200 dark:bg-slate-600 rounded-full mx-auto mt-3 mb-1 sm:hidden flex-shrink-0" />

          {/* Header */}
          <div className="px-8 pt-8 pb-6 flex items-center justify-between border-b border-slate-100 dark:border-slate-700">
            <div>
              <p className="text-lg font-black text-slate-800 dark:text-slate-100">Add Expense</p>
              <p className="text-xs text-slate-400 mt-0.5">This will update the Google Sheet automatically</p>
            </div>
            <button onClick={onClose} className="p-2 rounded-xl text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors">
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} className="px-8 py-6 space-y-5 overflow-y-auto flex-1">

            {/* Quick-add natural language input */}
            <div className="space-y-1.5">
              <div className="relative">
                <Sparkles className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-indigo-400 pointer-events-none" />
                <input
                  type="text"
                  value={nlText}
                  onChange={e => { setNlText(e.target.value); setNlError(''); }}
                  onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), parseNlExpense())}
                  placeholder='Quick add — "coffee 4.50 today" then press Enter'
                  disabled={nlLoading}
                  className="w-full bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-200 dark:border-indigo-700 text-slate-900 dark:text-slate-100 rounded-2xl pl-10 pr-12 py-3 text-sm outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-400 transition-all placeholder:text-slate-400 disabled:opacity-60"
                />
                {nlLoading
                  ? <Loader2 className="absolute right-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-indigo-400 animate-spin" />
                  : nlText && (
                    <button type="button" onClick={parseNlExpense}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-bold text-indigo-500 hover:text-indigo-700 dark:hover:text-indigo-300 px-1">
                      Parse
                    </button>
                  )
                }
              </div>
              {nlError && <p className="text-xs text-rose-500 pl-1">{nlError}</p>}
            </div>

            {/* Category */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-[11px] font-black uppercase tracking-widest text-slate-400">
                  What expense is this?
                </label>
                {ruleHint && (
                  <span className="flex items-center gap-1 text-[10px] font-bold text-indigo-500 dark:text-indigo-400">
                    <Zap className="w-2.5 h-2.5" /> Auto-filled by rule
                  </span>
                )}
              </div>
              <select
                value={category}
                onChange={e => { if (!lockCategory) { setCategory(e.target.value); setVendor(''); setRuleHint(''); } }}
                disabled={lockCategory}
                className={`${inputCls} ${lockCategory ? 'opacity-70 cursor-not-allowed' : 'cursor-pointer'}`}
              >
                <option value="">Select a category…</option>
                {categoryList.map(c => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>

            {/* Vendor name with autocomplete */}
            <div className="space-y-1.5">
              <label className="text-[11px] font-black uppercase tracking-widest text-slate-400">
                Vendor / Name
              </label>
              <div className="relative">
                <input
                  ref={vendorInputRef}
                  type="text"
                  placeholder={
                    loadingVendors
                      ? 'Loading vendors…'
                      : VENDOR_EXAMPLES[category] || 'e.g. Walmart, Costco…'
                  }
                  value={vendor}
                  onChange={handleVendorChange}
                  onFocus={() => suggestions.length > 0 && setShowSuggestions(true)}
                  onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
                  className={inputCls}
                  autoComplete="off"
                  disabled={loadingVendors}
                />

                {/* Suggestions dropdown */}
                {showSuggestions && (
                  <div
                    ref={suggestionsRef}
                    className="absolute top-full left-0 right-0 mt-1.5 bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-2xl shadow-lg overflow-hidden z-10"
                  >
                    {suggestions.map((name, i) => (
                      <button
                        key={i}
                        type="button"
                        onMouseDown={() => pickSuggestion(name)}
                        className="w-full text-left px-4 py-2.5 text-sm text-slate-700 dark:text-slate-200 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors font-medium"
                      >
                        {name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Amount */}
            <div className="space-y-1.5">
              <label className="text-[11px] font-black uppercase tracking-widest text-slate-400">
                Amount
              </label>
              <div className="relative">
                <span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 font-bold text-sm">$</span>
                <input
                  id="expense-amount"
                  type="number"
                  step="0.01"
                  min="0.01"
                  placeholder="0.00"
                  value={amount}
                  onChange={e => setAmount(e.target.value)}
                  className={`${inputCls} pl-8`}
                />
              </div>
            </div>

            {/* Date */}
            <div className="space-y-1.5">
              <label className="text-[11px] font-black uppercase tracking-widest text-slate-400">
                Transaction Date
              </label>
              <input
                type="date"
                value={txDate}
                onChange={e => setTxDate(e.target.value || todayIso())}
                className={inputCls}
              />
            </div>

            {/* Toggles row */}
            <div className="space-y-2.5">
              {/* One-time / non-monthly toggle */}
              <label className="flex items-start gap-3 cursor-pointer group">
                <div className="relative flex-shrink-0 mt-0.5">
                  <input
                    type="checkbox"
                    checked={isNonMonthly}
                    onChange={e => { setIsNonMonthly(e.target.checked); if (e.target.checked) setIsRecurring(false); }}
                    className="sr-only"
                  />
                  <div className={`w-5 h-5 rounded-md border-2 flex items-center justify-center transition-colors ${isNonMonthly ? 'bg-indigo-600 border-indigo-600' : 'border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700'}`}>
                    {isNonMonthly && <svg className="w-3 h-3 text-white" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                  </div>
                </div>
                <div>
                  <p className="text-sm font-bold text-slate-700 dark:text-slate-200 group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">
                    One-time / non-monthly expense
                  </p>
                  <p className="text-xs text-slate-400 mt-0.5">Tracks this separately for your balance calculation</p>
                </div>
              </label>

              {/* Repeats monthly toggle */}
              <label className="flex items-start gap-3 cursor-pointer group">
                <div className="relative flex-shrink-0 mt-0.5">
                  <input
                    type="checkbox"
                    checked={isRecurring}
                    onChange={e => setIsRecurring(e.target.checked)}
                    className="sr-only"
                  />
                  <div className={`w-5 h-5 rounded-md border-2 flex items-center justify-center transition-colors ${isRecurring ? 'bg-emerald-500 border-emerald-500' : 'border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700'}`}>
                    {isRecurring && <svg className="w-3 h-3 text-white" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                  </div>
                </div>
                <div>
                  <p className="text-sm font-bold text-slate-700 dark:text-slate-200 group-hover:text-emerald-600 dark:group-hover:text-emerald-400 transition-colors">
                    Repeats monthly
                  </p>
                  <p className="text-xs text-slate-400 mt-0.5">Auto-added when you create a new month</p>
                </div>
              </label>
            </div>

            {/* Geo-tagging (optional, only shown when setting is enabled) */}
            {geoTagEnabled && (
              <div className="space-y-1.5">
                <button
                  type="button"
                  onClick={() => handleGeoToggle(!geoEnabled)}
                  disabled={geoLoading}
                  className={`flex items-center gap-2 text-xs font-bold transition-colors ${
                    geoEnabled
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : 'text-slate-400 hover:text-slate-600 dark:hover:text-slate-300'
                  }`}
                >
                  {geoLoading
                    ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    : <MapPin className="w-3.5 h-3.5" />}
                  {geoLoading ? 'Getting location…' : geoEnabled && geoLocation ? '📍 Location tagged' : '📍 Tag location'}
                </button>
                {geoError && (
                  <p className="text-[11px] text-rose-500 font-medium">{geoError}</p>
                )}
              </div>
            )}

            {/* Note / Tag (optional) */}
            <div>
              <button type="button" onClick={() => setShowNote(v => !v)}
                className="text-xs font-bold text-indigo-500 hover:text-indigo-700 dark:hover:text-indigo-300 transition-colors flex items-center gap-1">
                {showNote ? '− Hide note / tag' : '+ Add note / tag (optional)'}
              </button>
              {showNote && (
                <div className="mt-3 space-y-2">
                  <textarea rows={2} placeholder="Add a note…" value={txNote}
                    onChange={e => setTxNote(e.target.value)}
                    className="w-full bg-slate-50 dark:bg-slate-700/60 border border-slate-200 dark:border-slate-600 text-slate-900 dark:text-slate-100 rounded-2xl px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-indigo-500/40 resize-none placeholder:text-slate-400" />
                  <div className="flex gap-2">
                    <input type="text" placeholder="Add tag (press Enter)"
                      value={txTagInput} onChange={e => setTxTagInput(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTxTag(); } }}
                      className="flex-1 bg-slate-50 dark:bg-slate-700/60 border border-slate-200 dark:border-slate-600 text-slate-900 dark:text-slate-100 rounded-2xl px-4 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500/40 placeholder:text-slate-400" />
                    <button type="button" onClick={addTxTag}
                      className="px-3 py-2 bg-indigo-600 text-white text-xs font-bold rounded-2xl hover:bg-indigo-700 transition-colors">Add</button>
                  </div>
                  {txTags.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {txTags.map(tag => (
                        <span key={tag} onClick={() => setTxTags(prev => prev.filter(t => t !== tag))}
                          className="flex items-center gap-1 text-xs font-bold px-2.5 py-1 bg-violet-50 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300 rounded-full cursor-pointer">
                          #{tag} ×
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Queued offline message */}
            {queued && (
              <div className="flex items-center gap-3 px-4 py-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700/40 rounded-2xl">
                <span className="text-base">📶</span>
                <p className="text-xs font-bold text-amber-800 dark:text-amber-300">
                  Saved offline — will sync when reconnected
                </p>
              </div>
            )}

            {/* Error */}
            {error && (
              <p className="text-xs text-rose-500 font-medium bg-rose-50 dark:bg-rose-900/20 px-4 py-2.5 rounded-xl">
                {error}
              </p>
            )}

            {/* Duplicate warning */}
            {dupWarning && (
              <div className="flex items-start gap-3 px-4 py-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700/40 rounded-2xl">
                <svg className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg>
                <p className="text-xs font-medium text-amber-800 dark:text-amber-300 leading-relaxed">
                  <span className="font-black">{vendor.trim()} ${parseFloat(amount).toFixed(2)}</span> is already logged in <span className="font-black">{category}</span> this month. Add it again?
                </p>
              </div>
            )}

            {/* Added toast */}
            {addedToast && (
              <div className="flex items-center gap-2 px-4 py-2.5 bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-700/40 rounded-2xl">
                <svg className="w-4 h-4 text-emerald-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7"/></svg>
                <p className="text-xs font-bold text-emerald-700 dark:text-emerald-300">Added ✓ — enter another</p>
              </div>
            )}

            {/* Actions */}
            <div className="flex flex-col gap-2 pt-2" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={dupWarning ? () => setDupWarning(false) : onClose}
                  className="flex-1 py-3 rounded-2xl text-sm font-bold text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors"
                >
                  {dupWarning ? 'Go Back' : 'Cancel'}
                </button>
                <button
                  type={dupWarning ? 'button' : 'submit'}
                  onClick={dupWarning ? doSave : undefined}
                  disabled={saving}
                  className={`flex-1 py-3 rounded-2xl text-sm font-bold text-white shadow-lg transition-all active:scale-[0.98] disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2 ${
                    dupWarning
                      ? 'bg-amber-500 hover:bg-amber-600 shadow-amber-200 dark:shadow-amber-900/30'
                      : 'bg-indigo-600 hover:bg-indigo-700 shadow-indigo-200 dark:shadow-indigo-900/30'
                  }`}
                >
                  {saving ? (
                    <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
                    </svg>
                  ) : (
                    <Plus className="w-4 h-4" />
                  )}
                  {saving ? 'Saving…' : dupWarning ? 'Add Anyway' : 'Add Expense'}
                </button>
              </div>
              {!dupWarning && (
                <button
                  type="button"
                  onClick={async () => {
                    setError('');
                    setDupWarning(false);
                    if (!category)      { setError('Please select a category.');                    return; }
                    if (!vendor.trim()) { setError('Please enter a vendor name.');                  return; }
                    const amt = parseFloat(amount);
                    if (!amt || amt <= 0) { setError('Please enter a valid amount greater than 0.'); return; }
                    const isDuplicate = await checkExistingExpense(category, vendor.trim(), amt, accessToken, sheetId);
                    if (isDuplicate) { setDupWarning(true); return; }
                    await doSaveAndAnother();
                  }}
                  disabled={saving}
                  className="w-full py-2.5 rounded-2xl text-sm font-bold text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-900/20 hover:bg-indigo-100 dark:hover:bg-indigo-900/30 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Save & Add Another
                </button>
              )}
            </div>
          </form>
        </div>
      </div>
    </>
  );
}
