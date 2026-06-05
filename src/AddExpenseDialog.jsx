import React, { useState, useEffect, useRef } from 'react';
import { X, Plus, Zap, Sparkles, MapPin, Loader2 } from 'lucide-react';
import { CATEGORIES, fetchDetailRows, checkExistingExpense, markNonMonthly, todayIso } from './sheetsApi.js';
import { addOrUpdateExpense } from './useExpense.js';
import { applySmartRules, applyCardRules } from './smartRules.js';
import { DEFAULT_SETTINGS } from './useSettings.js';
import { resolveMCC } from './vendorMCC.js';

const CSR = 'Chase Sapphire Reserve';
const TRAVEL_MCCS = new Set(['4511', '7011', 'CHASE_PORTAL']);

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

export function AddExpenseDialog({ accessToken, sheetId, monthName, onClose, onSuccess, categories: categoriesProp, onSaveRecurring, onSaveTransactionNote, smartRules = [], cardRules = [], cards = DEFAULT_SETTINGS.cards, prefillCategory = null, lockCategory = false, prefillVendor = '', prefillAmount = '', geoTagEnabled = false, geoPrivacyBlur = true }) {
  const categoryList = categoriesProp?.length ? categoriesProp : CATEGORIES;
  const [category, setCategory]         = useState(prefillCategory || '');
  const [vendor, setVendor]             = useState(prefillVendor);
  const [ruleHint, setRuleHint]         = useState(''); // category auto-filled by a rule
  const [paymentMethod, setPaymentMethod] = useState('');
  const [cardHint, setCardHint]           = useState(false); // card auto-filled by a rule
  const [bookingMethod, setBookingMethod] = useState('');    // '' = portal (default), 'direct'
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

  const inputCls = "w-full rounded-2xl px-4 py-3 text-sm outline-none transition-all";
  const inputStyle = {
    background: 'var(--sur-5)',
    border: '1px solid var(--sur-12)',
    color: 'var(--color-text)',
  };

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
      setCardHint(false);
      return;
    }
    // Auto-fill category from smart rules
    const matched = applySmartRules(val, smartRules);
    const resolvedCategory = (matched && categoryList.includes(matched)) ? matched : category;
    if (matched && categoryList.includes(matched)) {
      setCategory(matched);
      setRuleHint(matched);
    } else {
      setRuleHint('');
    }
    // Auto-fill card from card rules
    const matchedCard = applyCardRules(val, resolvedCategory, cardRules);
    if (matchedCard) {
      setPaymentMethod(matchedCard);
      setCardHint(true);
    } else {
      setCardHint(false);
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
      const effectiveBM = (paymentMethod === CSR && TRAVEL_MCCS.has(resolveMCC(vendor.trim(), category))) ? bookingMethod : '';
      const result = await addOrUpdateExpense(category, vendor.trim(), amt, accessToken, sheetId, monthName, 'manual', txDate, paymentMethod, effectiveBM);
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
      const effectiveBM = (paymentMethod === CSR && TRAVEL_MCCS.has(resolveMCC(vendor.trim(), category))) ? bookingMethod : '';
      const result = await addOrUpdateExpense(category, vendor.trim(), amt, accessToken, sheetId, monthName, 'manual', txDate, paymentMethod, effectiveBM);
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
      // Reset for next entry — keep category, date, and paymentMethod
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
      setCardHint(false);
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
        className="fixed inset-0 z-40 animate-overlay-in"
        style={{ background: 'oklch(0% 0 0 / 50%)', backdropFilter: 'blur(4px)' }}
        onClick={onClose}
      />

      {/* Dialog */}
      <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4">
        <div
          className="glass-heavy animate-sheet-up rounded-t-3xl sm:rounded-3xl w-full sm:max-w-md overflow-hidden max-h-[90vh] flex flex-col"
          style={{ border: '1px solid var(--sur-10)', borderBottom: 'none' }}
        >
          <div className="w-10 h-1 rounded-full mx-auto mt-3 mb-1 sm:hidden flex-shrink-0" style={{ background: 'var(--sur-20)' }} />

          {/* Header */}
          <div className="px-8 pt-8 pb-6 flex items-center justify-between flex-shrink-0" style={{ borderBottom: '1px solid var(--sur-8)' }}>
            <div>
              <p className="text-lg font-black" style={{ color: 'var(--color-text)' }}>Add Expense</p>
              <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>This will update the Google Sheet automatically</p>
            </div>
            <button onClick={onClose} className="p-2 rounded-xl transition-colors hover:bg-[var(--sur-5)]" style={{ color: 'var(--color-text-muted)' }}>
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
                  className="w-full rounded-2xl pl-10 pr-12 py-3 text-sm outline-none transition-all disabled:opacity-60"
                  style={{
                    background: 'var(--color-accent-subtle)',
                    border: '1px solid var(--color-accent-border)',
                    color: 'var(--color-text)',
                  }}
                />
                {nlLoading
                  ? <Loader2 className="absolute right-3.5 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin" style={{ color: 'var(--color-accent-text)' }} />
                  : nlText && (
                    <button type="button" onClick={parseNlExpense}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-bold px-1 transition-colors"
                      style={{ color: 'var(--color-accent-text)' }}>
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
                <label className="text-[11px] font-black uppercase tracking-widest" style={{ color: 'var(--color-text-muted)' }}>
                  What expense is this?
                </label>
                {ruleHint && (
                  <span className="flex items-center gap-1 text-[10px] font-bold text-[var(--color-accent-text)]">
                    <Zap className="w-2.5 h-2.5" /> Auto-filled by rule
                  </span>
                )}
              </div>
              <select
                value={category}
                onChange={e => {
                  if (!lockCategory) {
                    const newCat = e.target.value;
                    setCategory(newCat);
                    setVendor('');
                    setRuleHint('');
                    // Re-resolve card for new category with existing vendor (if any)
                    const matchedCard = applyCardRules(vendor, newCat, cardRules);
                    if (matchedCard) { setPaymentMethod(matchedCard); setCardHint(true); }
                    else { setCardHint(false); }
                  }
                }}
                disabled={lockCategory}
                className={`${inputCls} ${lockCategory ? 'opacity-70 cursor-not-allowed' : 'cursor-pointer'}`}
                style={inputStyle}
              >
                <option value="">Select a category…</option>
                {categoryList.map(c => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>

            {/* Vendor name with autocomplete */}
            <div className="space-y-1.5">
              <label className="text-[11px] font-black uppercase tracking-widest" style={{ color: 'var(--color-text-muted)' }}>
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
                  style={inputStyle}
                  autoComplete="off"
                  disabled={loadingVendors}
                />

                {/* Suggestions dropdown */}
                {showSuggestions && (
                  <div
                    ref={suggestionsRef}
                    className="absolute top-full left-0 right-0 mt-1.5 glass-medium rounded-2xl overflow-hidden z-10"
                    style={{ border: '1px solid var(--sur-10)' }}
                  >
                    {suggestions.map((name, i) => (
                      <button
                        key={i}
                        type="button"
                        onMouseDown={() => pickSuggestion(name)}
                        className="w-full text-left px-4 py-2.5 text-sm font-medium transition-colors hover:bg-[var(--sur-5)]"
                        style={{ color: 'var(--color-text)' }}
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
              <label className="text-[11px] font-black uppercase tracking-widest" style={{ color: 'var(--color-text-muted)' }}>
                Amount
              </label>
              <div className="relative">
                <span className="absolute left-4 top-1/2 -translate-y-1/2 font-bold text-sm" style={{ color: 'var(--color-text-muted)' }}>$</span>
                <input
                  id="expense-amount"
                  type="number"
                  step="0.01"
                  min="0.01"
                  placeholder="0.00"
                  value={amount}
                  onChange={e => setAmount(e.target.value)}
                  className={`${inputCls} pl-8`}
                  style={inputStyle}
                />
              </div>
            </div>

            {/* Date */}
            <div className="space-y-1.5">
              <label className="text-[11px] font-black uppercase tracking-widest" style={{ color: 'var(--color-text-muted)' }}>
                Transaction Date
              </label>
              <input
                type="date"
                value={txDate}
                onChange={e => setTxDate(e.target.value || todayIso())}
                className={inputCls}
                style={inputStyle}
              />
            </div>

            {/* Payment method */}
            {cards.length > 0 && (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-[11px] font-black uppercase tracking-widest" style={{ color: 'var(--color-text-muted)' }}>
                    Payment Method
                  </label>
                  {cardHint && (
                    <span className="flex items-center gap-1 text-[10px] font-bold" style={{ color: 'var(--color-accent-text)' }}>
                      <Zap className="w-2.5 h-2.5" /> Auto-filled by rule
                    </span>
                  )}
                </div>
                <select
                  value={paymentMethod}
                  onChange={e => { setPaymentMethod(e.target.value); setCardHint(false); setBookingMethod(''); }}
                  className={`${inputCls} cursor-pointer`}
                  style={inputStyle}
                >
                  <option value="">— Select card (optional) —</option>
                  {cards.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            )}

            {/* Booking method override — CSR + travel vendors only */}
            {paymentMethod === CSR && TRAVEL_MCCS.has(resolveMCC(vendor, category)) && (
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-bold" style={{ color: 'var(--color-accent-text)' }}>
                  📊 {bookingMethod === 'direct' ? '4x UR — Booked direct' : '8x UR — Chase Travel portal'}
                </span>
                <button
                  type="button"
                  onClick={() => setBookingMethod(bm => bm === 'direct' ? '' : 'direct')}
                  className="text-xs underline transition-colors"
                  style={{ color: 'var(--color-text-muted)' }}
                >
                  {bookingMethod === 'direct' ? '← Switch to portal (8x)' : 'Booked direct instead? → 4x'}
                </button>
              </div>
            )}

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
                  <div
                    className="w-5 h-5 rounded-md border-2 flex items-center justify-center transition-colors"
                    style={isNonMonthly
                      ? { background: 'var(--color-accent)', borderColor: 'var(--color-accent)' }
                      : { background: 'var(--sur-5)', borderColor: 'var(--sur-20)' }
                    }
                  >
                    {isNonMonthly && <svg className="w-3 h-3 text-white" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                  </div>
                </div>
                <div>
                  <p className="text-sm font-bold transition-colors" style={{ color: 'var(--color-text)' }}>
                    One-time / non-monthly expense
                  </p>
                  <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>Tracks this separately for your balance calculation</p>
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
                  <div
                    className="w-5 h-5 rounded-md border-2 flex items-center justify-center transition-colors"
                    style={isRecurring
                      ? { background: 'var(--color-success)', borderColor: 'var(--color-success)' }
                      : { background: 'var(--sur-5)', borderColor: 'var(--sur-20)' }
                    }
                  >
                    {isRecurring && <svg className="w-3 h-3 text-white" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                  </div>
                </div>
                <div>
                  <p className="text-sm font-bold transition-colors" style={{ color: 'var(--color-text)' }}>
                    Repeats monthly
                  </p>
                  <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>Auto-added when you create a new month</p>
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
                  className="flex items-center gap-2 text-xs font-bold transition-colors"
                  style={{ color: geoEnabled ? 'var(--color-success)' : 'var(--color-text-muted)' }}
                >
                  {geoLoading
                    ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    : <MapPin className="w-3.5 h-3.5" />}
                  {geoLoading ? 'Getting location…' : geoEnabled && geoLocation ? '📍 Location tagged' : '📍 Tag location'}
                </button>
                {geoError && (
                  <p className="text-[11px] font-medium" style={{ color: 'var(--color-danger)' }}>{geoError}</p>
                )}
              </div>
            )}

            {/* Note / Tag (optional) */}
            <div>
              <button type="button" onClick={() => setShowNote(v => !v)}
                className="text-xs font-bold transition-colors flex items-center gap-1"
                style={{ color: 'var(--color-accent-text)' }}>
                {showNote ? '− Hide note / tag' : '+ Add note / tag (optional)'}
              </button>
              {showNote && (
                <div className="mt-3 space-y-2">
                  <textarea rows={2} placeholder="Add a note…" value={txNote}
                    onChange={e => setTxNote(e.target.value)}
                    className="w-full rounded-2xl px-4 py-2.5 text-sm outline-none resize-none"
                    style={inputStyle} />
                  <div className="flex gap-2">
                    <input type="text" placeholder="Add tag (press Enter)"
                      value={txTagInput} onChange={e => setTxTagInput(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTxTag(); } }}
                      className="flex-1 rounded-2xl px-4 py-2 text-sm outline-none"
                      style={inputStyle} />
                    <button type="button" onClick={addTxTag}
                      className="px-3 py-2 text-white text-xs font-bold rounded-2xl transition-colors"
                      style={{ background: 'var(--color-accent)' }}>Add</button>
                  </div>
                  {txTags.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {txTags.map(tag => (
                        <span key={tag} onClick={() => setTxTags(prev => prev.filter(t => t !== tag))}
                          className="flex items-center gap-1 text-xs font-bold px-2.5 py-1 rounded-full cursor-pointer"
                          style={{ background: 'var(--color-accent-subtle)', color: 'var(--color-accent-text)', border: '1px solid var(--color-accent-border)' }}>
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
              <div className="flex items-center gap-3 px-4 py-3 rounded-2xl"
                style={{ background: 'oklch(78% 0.16 75 / 12%)', border: '1px solid oklch(78% 0.16 75 / 25%)' }}>
                <span className="text-base">📶</span>
                <p className="text-xs font-bold" style={{ color: 'oklch(78% 0.16 75)' }}>
                  Saved offline — will sync when reconnected
                </p>
              </div>
            )}

            {/* Error */}
            {error && (
              <p className="text-xs font-medium px-4 py-2.5 rounded-xl"
                style={{ color: 'var(--color-danger)', background: 'oklch(62% 0.22 25 / 10%)' }}>
                {error}
              </p>
            )}

            {/* Duplicate warning */}
            {dupWarning && (
              <div className="flex items-start gap-3 px-4 py-3 rounded-2xl"
                style={{ background: 'oklch(78% 0.16 75 / 12%)', border: '1px solid oklch(78% 0.16 75 / 25%)' }}>
                <svg className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: 'oklch(78% 0.16 75)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg>
                <p className="text-xs font-medium leading-relaxed" style={{ color: 'oklch(78% 0.16 75)' }}>
                  <span className="font-black">{vendor.trim()} ${parseFloat(amount).toFixed(2)}</span> is already logged in <span className="font-black">{category}</span> this month. Add it again?
                </p>
              </div>
            )}

            {/* Added toast */}
            {addedToast && (
              <div className="flex items-center gap-2 px-4 py-2.5 rounded-2xl"
                style={{ background: 'oklch(70% 0.15 145 / 12%)', border: '1px solid oklch(70% 0.15 145 / 25%)' }}>
                <svg className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--color-success)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7"/></svg>
                <p className="text-xs font-bold" style={{ color: 'var(--color-success)' }}>Added ✓ — enter another</p>
              </div>
            )}

            {/* Actions */}
            <div className="flex flex-col gap-2 pt-2" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={dupWarning ? () => setDupWarning(false) : onClose}
                  className="flex-1 py-3 rounded-2xl text-sm font-bold transition-colors"
                  style={{ background: 'var(--sur-8)', color: 'var(--color-text)' }}
                >
                  {dupWarning ? 'Go Back' : 'Cancel'}
                </button>
                <button
                  type={dupWarning ? 'button' : 'submit'}
                  onClick={dupWarning ? doSave : undefined}
                  disabled={saving}
                  className="flex-1 py-3 rounded-2xl text-sm font-bold text-white transition-all active:scale-[0.98] disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                  style={{ background: dupWarning ? 'oklch(78% 0.16 75)' : 'var(--color-accent)' }}
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
                  className="w-full py-2.5 rounded-2xl text-sm font-bold transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                  style={{ background: 'var(--color-accent-subtle)', color: 'var(--color-accent-text)', border: '1px solid var(--color-accent-border)' }}
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
