import React from 'react';
import { Plus, Camera, Sparkles } from 'lucide-react';

export function SpeedDial({ fabOpen, setFabOpen, detail, scanTriggerRef, onAddExpense, onOpenChat }) {
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
          <span className="bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 text-xs font-bold px-3 py-1.5 rounded-full shadow-lg border border-slate-100 dark:border-slate-700 whitespace-nowrap">
            Scan / Import
          </span>
          <button
            onClick={() => { setFabOpen(false); scanTriggerRef.current?.(); }}
            className="w-12 h-12 rounded-full bg-emerald-600 shadow-xl flex items-center justify-center active:scale-95 transition-transform"
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
          <span className="bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 text-xs font-bold px-3 py-1.5 rounded-full shadow-lg border border-slate-100 dark:border-slate-700 whitespace-nowrap">
            + Add Expense
          </span>
          <button
            onClick={() => { setFabOpen(false); onAddExpense(); }}
            className="w-12 h-12 rounded-full bg-indigo-600 shadow-xl flex items-center justify-center active:scale-95 transition-transform"
          >
            <Plus className="w-5 h-5 text-white" />
          </button>
        </div>

        {/* AI Agent */}
        <div
          className="absolute bottom-0 right-0 flex items-center gap-2.5 transition-all duration-200 ease-out"
          style={{
            transform: fabOpen ? 'translate(-38px, -216px)' : 'translate(0, 8px)',
            opacity: fabOpen ? 1 : 0,
            pointerEvents: fabOpen ? 'auto' : 'none',
            transitionDelay: fabOpen ? '80ms' : '0ms',
          }}
        >
          <span className="bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 text-xs font-bold px-3 py-1.5 rounded-full shadow-lg border border-slate-100 dark:border-slate-700 whitespace-nowrap">
            AI Agent
          </span>
          <button
            onClick={() => { setFabOpen(false); onOpenChat(); }}
            className="w-12 h-12 rounded-full bg-violet-600 shadow-xl flex items-center justify-center active:scale-95 transition-transform"
          >
            <Sparkles className="w-5 h-5 text-white" />
          </button>
        </div>

        {/* Main FAB */}
        <button
          onClick={() => setFabOpen(o => !o)}
          className={`w-14 h-14 rounded-full shadow-2xl flex items-center justify-center transition-all duration-200 ${
            fabOpen
              ? 'bg-slate-600 dark:bg-slate-700'
              : 'bg-indigo-600 hover:bg-indigo-700 shadow-indigo-300 dark:shadow-indigo-900/50'
          }`}
        >
          <Plus className={`w-6 h-6 text-white transition-transform duration-200 ${fabOpen ? 'rotate-45' : ''}`} />
        </button>
      </div>
    </>
  );
}
