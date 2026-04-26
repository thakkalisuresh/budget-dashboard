import React, { useState, useEffect, useRef } from 'react';
import { X, Plus } from 'lucide-react';
import { CATEGORIES, addOrUpdateExpense, fetchDetailRows, appendRandomExpenseNote } from './sheetsApi.js';

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

export function AddExpenseDialog({ accessToken, sheetId, monthName, onClose, onSuccess }) {
  const [category, setCategory]         = useState('');
  const [vendor, setVendor]             = useState('');
  const [amount, setAmount]             = useState('');
  const [isRandom, setIsRandom]         = useState(false);
  const [saving, setSaving]             = useState(false);
  const [error, setError]               = useState('');

  // Autocomplete state
  const [allVendors, setAllVendors]     = useState([]);
  const [suggestions, setSuggestions]   = useState([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [loadingVendors, setLoadingVendors]   = useState(false);
  const vendorInputRef = useRef(null);
  const suggestionsRef = useRef(null);

  const inputCls = "w-full bg-slate-50 dark:bg-slate-700/60 border border-slate-200 dark:border-slate-600 text-slate-900 dark:text-slate-100 rounded-2xl px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-400 transition-all placeholder:text-slate-400";

  // Fetch existing vendors when category changes
  useEffect(() => {
    if (!category) { setAllVendors([]); setSuggestions([]); return; }
    setLoadingVendors(true);
    setVendor('');
    setSuggestions([]);
    fetchDetailRows(category, accessToken)
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
      return;
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

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (!category) { setError('Please select a category.'); return; }
    if (!vendor.trim()) { setError('Please enter a vendor name.'); return; }
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) { setError('Please enter a valid amount greater than 0.'); return; }

    setSaving(true);
    try {
      await addOrUpdateExpense(category, vendor.trim(), amt, accessToken, sheetId, monthName, 'manual', isRandom);
      if (isRandom) {
        await appendRandomExpenseNote(sheetId, vendor.trim(), amt, accessToken);
      }
      onSuccess?.();
      onClose();
    } catch (err) {
      setError(err.message || 'Something went wrong. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/40 dark:bg-black/60 z-40 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Dialog */}
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="bg-white dark:bg-slate-800 rounded-[2rem] shadow-2xl w-full max-w-md border border-slate-100 dark:border-slate-700 overflow-hidden">

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
          <form onSubmit={handleSubmit} className="px-8 py-6 space-y-5">

            {/* Category */}
            <div className="space-y-1.5">
              <label className="text-[11px] font-black uppercase tracking-widest text-slate-400">
                What expense is this?
              </label>
              <select
                value={category}
                onChange={e => setCategory(e.target.value)}
                className={`${inputCls} cursor-pointer`}
              >
                <option value="">Select a category…</option>
                {CATEGORIES.map(c => (
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

            {/* Random expense toggle */}
            <label className="flex items-start gap-3 cursor-pointer group">
              <div className="relative flex-shrink-0 mt-0.5">
                <input
                  type="checkbox"
                  checked={isRandom}
                  onChange={e => setIsRandom(e.target.checked)}
                  className="sr-only"
                />
                <div className={`w-5 h-5 rounded-md border-2 flex items-center justify-center transition-colors ${isRandom ? 'bg-indigo-600 border-indigo-600' : 'border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700'}`}>
                  {isRandom && <svg className="w-3 h-3 text-white" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                </div>
              </div>
              <div>
                <p className="text-sm font-bold text-slate-700 dark:text-slate-200 group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">
                  One-time / random expense
                </p>
                <p className="text-xs text-slate-400 mt-0.5">
                  Marks this as a non-monthly expense in the dashboard
                </p>
              </div>
            </label>

            {/* Error */}
            {error && (
              <p className="text-xs text-rose-500 font-medium bg-rose-50 dark:bg-rose-900/20 px-4 py-2.5 rounded-xl">
                {error}
              </p>
            )}

            {/* Actions */}
            <div className="flex gap-3 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="flex-1 py-3 rounded-2xl text-sm font-bold text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving}
                className="flex-1 py-3 rounded-2xl text-sm font-bold text-white bg-indigo-600 hover:bg-indigo-700 shadow-lg shadow-indigo-200 dark:shadow-indigo-900/30 transition-all active:scale-[0.98] disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {saving ? (
                  <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
                  </svg>
                ) : (
                  <Plus className="w-4 h-4" />
                )}
                {saving ? 'Saving…' : 'Add Expense'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </>
  );
}
