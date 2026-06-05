import React from 'react';
import { Plus, Camera, Sparkles, CalendarCheck } from 'lucide-react';

const labelStyle = {
  background: 'var(--color-surface)',
  border: '1px solid oklch(100% 0 0 / 10%)',
  color: 'var(--color-text)',
  boxShadow: '0 4px 12px oklch(0% 0 0 / 30%)',
};

export function SpeedDial({ fabOpen, setFabOpen, detail, scanTriggerRef, onAddExpense, onOpenChat, onBulkRecurring }) {
  return (
    <>
      {fabOpen && (
        <div className="sm:hidden fixed inset-0 z-40" onClick={() => setFabOpen(false)} />
      )}
      <div
        className={`sm:hidden fixed z-50 transition-all duration-200 ${detail ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}
        style={{ bottom: 'calc(env(safe-area-inset-bottom) + 1.5rem)', right: '1.5rem', width: '56px', height: '56px' }}
      >
        {/* Scan / Import */}
        <div
          className="absolute bottom-0 right-0 flex items-center gap-2.5 transition-all duration-200 ease-out"
          style={{
            transform: fabOpen ? 'translate(0, -80px)' : 'translate(0, 8px)',
            opacity: fabOpen ? 1 : 0,
            pointerEvents: fabOpen ? 'auto' : 'none',
            transitionDelay: fabOpen ? '20ms' : '0ms',
          }}
        >
          <span className="text-xs font-bold px-3 py-1.5 rounded-full whitespace-nowrap" style={labelStyle}>
            Scan / Import
          </span>
          <button
            onClick={() => { setFabOpen(false); scanTriggerRef.current?.(); }}
            className="w-12 h-12 rounded-full shadow-xl flex items-center justify-center active:scale-95 transition-transform"
            style={{ background: 'var(--color-success)' }}
          >
            <Camera className="w-5 h-5 text-white" />
          </button>
        </div>

        {/* Add Expense */}
        <div
          className="absolute bottom-0 right-0 flex items-center gap-2.5 transition-all duration-200 ease-out"
          style={{
            transform: fabOpen ? 'translate(-20px, -148px)' : 'translate(0, 8px)',
            opacity: fabOpen ? 1 : 0,
            pointerEvents: fabOpen ? 'auto' : 'none',
            transitionDelay: fabOpen ? '50ms' : '0ms',
          }}
        >
          <span className="text-xs font-bold px-3 py-1.5 rounded-full whitespace-nowrap" style={labelStyle}>
            + Add Expense
          </span>
          <button
            onClick={() => { setFabOpen(false); onAddExpense(); }}
            className="w-12 h-12 rounded-full shadow-xl flex items-center justify-center active:scale-95 transition-transform"
            style={{ background: 'var(--color-accent)' }}
          >
            <Plus className="w-5 h-5 text-white" />
          </button>
        </div>

        {/* Add Recurring */}
        {onBulkRecurring && (
          <div
            className="absolute bottom-0 right-0 flex items-center gap-2.5 transition-all duration-200 ease-out"
            style={{
              transform: fabOpen ? 'translate(-38px, -216px)' : 'translate(0, 8px)',
              opacity: fabOpen ? 1 : 0,
              pointerEvents: fabOpen ? 'auto' : 'none',
              transitionDelay: fabOpen ? '80ms' : '0ms',
            }}
          >
            <span className="text-xs font-bold px-3 py-1.5 rounded-full whitespace-nowrap" style={labelStyle}>
              Add Recurring
            </span>
            <button
              onClick={() => { setFabOpen(false); onBulkRecurring(); }}
              className="w-12 h-12 rounded-full shadow-xl flex items-center justify-center active:scale-95 transition-transform"
              style={{ background: 'oklch(62% 0.16 185)' }}
            >
              <CalendarCheck className="w-5 h-5 text-white" />
            </button>
          </div>
        )}

        {/* AI Agent */}
        <div
          className="absolute bottom-0 right-0 flex items-center gap-2.5 transition-all duration-200 ease-out"
          style={{
            transform: fabOpen ? `translate(-38px, ${onBulkRecurring ? '-284px' : '-216px'})` : 'translate(0, 8px)',
            opacity: fabOpen ? 1 : 0,
            pointerEvents: fabOpen ? 'auto' : 'none',
            transitionDelay: fabOpen ? '110ms' : '0ms',
          }}
        >
          <span className="text-xs font-bold px-3 py-1.5 rounded-full whitespace-nowrap" style={labelStyle}>
            AI Agent
          </span>
          <button
            onClick={() => { setFabOpen(false); onOpenChat(); }}
            className="w-12 h-12 rounded-full shadow-xl flex items-center justify-center active:scale-95 transition-transform"
            style={{ background: 'oklch(62% 0.18 285)' }}
          >
            <Sparkles className="w-5 h-5 text-white" />
          </button>
        </div>

        {/* Main FAB */}
        <button
          onClick={() => setFabOpen(o => !o)}
          className="w-14 h-14 rounded-full shadow-2xl flex items-center justify-center transition-all duration-200"
          style={{
            background: fabOpen ? 'oklch(30% 0.008 265)' : 'var(--color-accent)',
            boxShadow: fabOpen ? 'none' : '0 8px 24px var(--color-accent-subtle)',
          }}
        >
          <Plus className={`w-6 h-6 text-white transition-transform duration-200 ${fabOpen ? 'rotate-45' : ''}`} />
        </button>
      </div>
    </>
  );
}
