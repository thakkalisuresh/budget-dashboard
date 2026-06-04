import React, { useState, useEffect, useRef } from 'react';
import { Plus, Trash2, ChevronDown, Check } from 'lucide-react';

function abbreviateMonth(name) {
  return name.replace(/^([A-Za-z]{3})[a-z]+(\s)/, '$1$2');
}

export function MonthPickerBar({
  selectedSheetId, setSelectedSheetId,
  monthsLoading, months, selectedMonth,
  onNewMonth, onDeleteMonth,
}) {
  const [open, setOpen] = useState(false);
  const sheetRef = useRef(null);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open]);

  // Prevent body scroll while sheet is open
  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [open]);

  const handleSelect = (sheetId) => {
    setSelectedSheetId(sheetId);
    setOpen(false);
  };

  const handleDelete = (month) => {
    // Select the month first if not already selected, then trigger delete
    if (month.sheetId !== selectedSheetId) setSelectedSheetId(month.sheetId);
    setOpen(false);
    // Small delay so selection propagates before the delete confirm fires
    setTimeout(onDeleteMonth, 50);
  };

  const label = monthsLoading
    ? 'Loading…'
    : (selectedMonth ? abbreviateMonth(selectedMonth.name) : '—');

  return (
    <>
      {/* ── Trigger ──────────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2.5">
        <button
          onClick={() => !monthsLoading && setOpen(true)}
          disabled={monthsLoading}
          className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all duration-150 active:scale-[0.97] disabled:opacity-50"
          style={{
            background: 'var(--color-surface)',
            border: '1px solid oklch(100% 0 0 / 10%)',
            color: 'var(--color-text)',
          }}
        >
          <span>{label}</span>
          <ChevronDown
            className="w-3.5 h-3.5 transition-transform duration-200"
            style={{
              color: 'var(--color-text-muted)',
              transform: open ? 'rotate(180deg)' : undefined,
            }}
          />
        </button>

        <button
          onClick={onNewMonth}
          className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold transition-all duration-150 active:scale-[0.97]"
          style={{
            background: 'var(--color-accent)',
            color: 'white',
          }}
        >
          <Plus className="w-3.5 h-3.5" />
          New month
        </button>
      </div>

      {/* ── Bottom sheet ─────────────────────────────────────────────────────── */}
      {open && (
        <div className="fixed inset-0 z-50 flex flex-col justify-end">
          {/* Overlay */}
          <div
            className="absolute inset-0 animate-overlay-in"
            style={{ background: 'oklch(0% 0 0 / 50%)', backdropFilter: 'blur(4px)' }}
            onClick={() => setOpen(false)}
          />

          {/* Sheet panel */}
          <div
            ref={sheetRef}
            className="relative glass-heavy animate-sheet-up rounded-t-3xl flex flex-col max-h-[70vh] lg:max-w-sm lg:mx-auto lg:mb-0 lg:rounded-3xl lg:mb-8"
            style={{
              border: '1px solid oklch(100% 0 0 / 10%)',
              borderBottom: 'none',
              paddingBottom: 'env(safe-area-inset-bottom)',
            }}
          >
            {/* Handle */}
            <div className="flex justify-center pt-3 pb-1 flex-shrink-0">
              <div className="w-9 h-1 rounded-full" style={{ background: 'oklch(100% 0 0 / 20%)' }} />
            </div>

            {/* Title */}
            <div className="px-5 py-3 flex-shrink-0">
              <h2 className="text-base font-black" style={{ color: 'var(--color-text)' }}>
                Select Month
              </h2>
            </div>

            {/* Month list */}
            <div className="overflow-y-auto flex-1 px-3 pb-2">
              {months.map((month) => {
                const isActive = month.sheetId === selectedSheetId;
                return (
                  <div key={month.sheetId} className="flex items-center rounded-xl overflow-hidden mb-0.5">
                    <button
                      onClick={() => handleSelect(month.sheetId)}
                      className="flex-1 flex items-center gap-3 px-3 py-3.5 text-sm font-semibold text-left transition-colors duration-150 rounded-xl hover:bg-white/5"
                      style={{ color: isActive ? 'var(--color-accent-text)' : 'var(--color-text)' }}
                    >
                      <span
                        className="w-4 h-4 flex-shrink-0 flex items-center justify-center"
                      >
                        {isActive && <Check className="w-4 h-4" style={{ color: 'var(--color-accent)' }} strokeWidth={2.5} />}
                      </span>
                      {month.name}
                    </button>
                    {months.length > 1 && (
                      <button
                        onClick={() => handleDelete(month)}
                        className="p-2 mr-1 rounded-lg transition-colors duration-150 hover:bg-white/8"
                        aria-label={`Delete ${month.name}`}
                        style={{ color: 'var(--color-text-muted)' }}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>

            {/* New month action */}
            <div className="px-5 py-4 flex-shrink-0" style={{ borderTop: '1px solid oklch(100% 0 0 / 8%)' }}>
              <button
                onClick={() => { setOpen(false); onNewMonth(); }}
                className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm font-bold transition-all duration-150 active:scale-[0.98]"
                style={{
                  background: 'var(--color-accent-subtle)',
                  color: 'var(--color-accent-text)',
                  border: '1px solid var(--color-accent-border)',
                }}
              >
                <Plus className="w-4 h-4" />
                Create new month
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
