import React, { useState, useEffect } from 'react';
import { ChevronRight, X, Check, Upload, RefreshCw } from 'lucide-react';

// ── Typed text with blinking cursor ──────────────────────────────────────────
function TypedText({ text, delay = 0, speed = 65 }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    setN(0);
    const t = setTimeout(() => {
      const id = setInterval(() => setN(c => Math.min(c + 1, text.length)), speed);
      return () => clearInterval(id);
    }, delay);
    return () => clearTimeout(t);
  }, [text, delay, speed]);
  const done = n >= text.length;
  return (
    <span>
      {text.slice(0, n)}
      {!done && <span className="inline-block w-px h-3 bg-slate-500 ml-px animate-pulse align-middle" />}
    </span>
  );
}

// ── Phone shell ───────────────────────────────────────────────────────────────
function PhoneFrame({ children, accent = '#4f46e5' }) {
  return (
    <div className="relative mx-auto select-none pointer-events-none" style={{ width: 178, height: 356 }}>
      <div className="absolute inset-0 rounded-[2.2rem] border-[5px] border-slate-700 bg-slate-900 shadow-2xl overflow-hidden flex flex-col">
        {/* Dynamic island */}
        <div className="flex justify-center pt-2 pb-0.5 bg-slate-900 flex-shrink-0">
          <div className="w-14 h-3.5 bg-black rounded-full" />
        </div>
        {/* Status bar */}
        <div className="flex items-center justify-between px-3.5 py-0.5 bg-slate-950 flex-shrink-0">
          <span className="text-[8px] font-black text-white/60">9:41</span>
          <div className="flex items-center gap-0.5">
            <div className="flex items-end gap-px">
              {[2, 3, 4, 5].map((h, i) => (
                <div key={i} className="w-0.5 bg-white/60 rounded-sm" style={{ height: h }} />
              ))}
            </div>
            <div className="ml-1 w-4 h-2 border border-white/50 rounded-[2px] relative">
              <div className="absolute inset-[1.5px] right-[3px] bg-white/70 rounded-[1px]" />
              <div className="absolute -right-[2px] top-[2px] w-[2px] h-1 bg-white/50 rounded-r-sm" />
            </div>
          </div>
        </div>
        {/* Screen */}
        <div className="flex-1 overflow-hidden bg-slate-100 dark:bg-slate-900" style={{ '--accent': accent }}>
          {children}
        </div>
      </div>
    </div>
  );
}

// ── Step 1: Welcome screen ────────────────────────────────────────────────────
function WelcomePreview() {
  return (
    <PhoneFrame>
      <div className="h-full bg-slate-950 flex flex-col items-center justify-center gap-3 px-4">
        <div className="w-12 h-12 bg-indigo-600 rounded-2xl flex items-center justify-center shadow-lg shadow-indigo-900/50">
          <span className="text-xl">💰</span>
        </div>
        <p className="text-white font-black text-xs text-center leading-snug">Budget Dashboard</p>
        <p className="text-slate-400 text-[9px] text-center leading-relaxed">
          Your finances,<br />backed by Google Sheets
        </p>
        <div className="mt-2 w-full space-y-1.5">
          {['Grocery · $312', 'Eating Out · $89', 'Utilities · $145'].map((row, i) => (
            <div key={i} className="flex items-center justify-between bg-slate-800 rounded-xl px-3 py-1.5">
              <span className="text-[9px] text-slate-300 font-medium">{row.split('·')[0]}</span>
              <span className="text-[9px] text-white font-black">{row.split('·')[1]}</span>
            </div>
          ))}
        </div>
      </div>
    </PhoneFrame>
  );
}

// ── Step 2: Add expense ───────────────────────────────────────────────────────
function AddExpensePreview({ loopKey }) {
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    setPhase(0);
    const ts = [
      setTimeout(() => setPhase(1), 500),
      setTimeout(() => setPhase(2), 1000),
      setTimeout(() => setPhase(3), 1900),
      setTimeout(() => setPhase(4), 2500),
      setTimeout(() => setPhase(5), 2900),
    ];
    return () => ts.forEach(clearTimeout);
  }, [loopKey]);

  const tapping = phase === 4;
  const success = phase === 5;

  return (
    <PhoneFrame>
      <div className="h-full bg-slate-100 flex flex-col">
        {/* App header */}
        <div className="bg-white px-3 py-2 border-b border-slate-100 flex-shrink-0">
          <p className="text-[9px] font-black text-slate-700">Budget Dashboard</p>
          <p className="text-[8px] text-slate-400">May 2026</p>
        </div>

        {/* Backdrop */}
        {phase >= 0 && (
          <div className="absolute inset-0 bg-black/30 z-10" style={{ top: 42 }} />
        )}

        {/* Bottom sheet dialog */}
        <div
          className="absolute left-0 right-0 bottom-0 z-20 bg-white rounded-t-2xl shadow-2xl transition-transform duration-500"
          style={{ transform: phase >= 0 ? 'translateY(0)' : 'translateY(100%)' }}
        >
          {/* Handle */}
          <div className="w-8 h-1 bg-slate-200 rounded-full mx-auto mt-2 mb-3" />
          <div className="px-4 pb-4 space-y-2.5">
            <p className="text-[10px] font-black text-slate-800">Add Expense</p>

            {/* Category */}
            <div className={`rounded-xl border px-2.5 py-1.5 text-[8px] font-bold transition-all duration-300 ${phase >= 1 ? 'border-indigo-400 bg-indigo-50 text-indigo-700' : 'border-slate-200 text-slate-400'}`}>
              {phase >= 1 ? '🛒 Grocery' : 'Select category…'}
            </div>

            {/* Vendor */}
            <div className={`rounded-xl border px-2.5 py-1.5 text-[8px] transition-all duration-300 ${phase >= 2 ? 'border-indigo-300 bg-white' : 'border-slate-200 bg-slate-50'}`}>
              {phase >= 2
                ? <TypedText text="Walmart" delay={0} speed={90} />
                : <span className="text-slate-300">Vendor name…</span>}
            </div>

            {/* Amount */}
            <div className={`rounded-xl border px-2.5 py-1.5 text-[8px] transition-all duration-300 ${phase >= 3 ? 'border-indigo-300 bg-white' : 'border-slate-200 bg-slate-50'}`}>
              {phase >= 3
                ? <><span className="text-slate-400">$</span><TypedText text="45.99" delay={0} speed={80} /></>
                : <span className="text-slate-300">$0.00</span>}
            </div>

            {/* Button */}
            {!success ? (
              <div
                className={`rounded-xl py-2 text-center text-[9px] font-black text-white transition-all duration-150 ${
                  phase >= 1 ? 'bg-indigo-600' : 'bg-slate-200'
                } ${tapping ? 'scale-95 opacity-80' : 'scale-100'}`}
              >
                {tapping ? '…' : 'Add Expense'}
              </div>
            ) : (
              <div className="rounded-xl py-2 text-center text-[9px] font-black text-white bg-emerald-500 flex items-center justify-center gap-1">
                <Check className="w-3 h-3" /> Saved!
              </div>
            )}
          </div>
        </div>
      </div>
    </PhoneFrame>
  );
}

// ── Step 3: Reconcile ─────────────────────────────────────────────────────────
const RECON_ROWS = [
  { vendor: 'Walmart', amt: '$89.12', cat: 'Grocery' },
  { vendor: 'Netflix', amt: '$15.49', cat: 'Entertainment' },
  { vendor: 'Starbucks', amt: '$6.75', cat: 'Eating Out' },
];

function ReconcilePreview({ loopKey }) {
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    setPhase(0);
    const ts = [
      setTimeout(() => setPhase(1), 700),
      setTimeout(() => setPhase(2), 1400),
      setTimeout(() => setPhase(3), 2000),
      setTimeout(() => setPhase(4), 2400),
      setTimeout(() => setPhase(5), 2800),
      setTimeout(() => setPhase(6), 3400),
      setTimeout(() => setPhase(7), 3900),
    ];
    return () => ts.forEach(clearTimeout);
  }, [loopKey]);

  return (
    <PhoneFrame>
      <div className="h-full bg-white flex flex-col">
        {/* Header */}
        <div className="px-3 py-2 border-b border-slate-100 flex-shrink-0">
          <p className="text-[9px] font-black text-slate-800">Reconcile May 2026</p>
          <p className="text-[8px] text-slate-400">Match bank statement to your logs</p>
        </div>

        <div className="flex-1 px-3 py-3 space-y-2.5 overflow-hidden">
          {/* Upload zone */}
          {phase < 2 && (
            <div className={`border-2 border-dashed rounded-xl py-5 flex flex-col items-center gap-1.5 transition-all duration-300 ${phase >= 1 ? 'border-indigo-400 bg-indigo-50' : 'border-slate-200'}`}>
              {phase >= 1
                ? <div className="text-[9px] font-black text-indigo-600 animate-bounce">📄 Chase_Apr.csv</div>
                : <Upload className="w-4 h-4 text-slate-300" />}
              <p className="text-[8px] text-slate-400">{phase >= 1 ? 'Parsing…' : 'Drop CSV or PDF'}</p>
            </div>
          )}

          {/* Processing */}
          {phase === 2 && (
            <div className="flex flex-col items-center gap-2 py-4">
              <RefreshCw className="w-5 h-5 text-indigo-400 animate-spin" />
              <p className="text-[8px] text-slate-400">Checking your sheets…</p>
            </div>
          )}

          {/* Results */}
          {phase >= 3 && (
            <>
              <div className="flex items-center justify-between">
                <p className="text-[8px] font-black text-slate-500 uppercase tracking-wider">New transactions</p>
                <span className="text-[8px] font-black text-emerald-600 bg-emerald-50 px-1.5 py-0.5 rounded-full">
                  {phase >= 5 ? 3 : phase >= 4 ? 2 : 1} new
                </span>
              </div>
              <div className="space-y-1.5">
                {RECON_ROWS.slice(0, phase >= 5 ? 3 : phase >= 4 ? 2 : 1).map((row, i) => (
                  <div key={i} className="flex items-center justify-between bg-slate-50 rounded-lg px-2.5 py-1.5 animate-[fadeIn_0.3s_ease]">
                    <div>
                      <p className="text-[8px] font-black text-slate-700">{row.vendor}</p>
                      <p className="text-[7px] text-slate-400">{row.cat}</p>
                    </div>
                    <span className="text-[8px] font-black text-slate-800">{row.amt}</span>
                  </div>
                ))}
              </div>

              {phase >= 6 && (
                <div className={`rounded-xl py-1.5 text-center text-[9px] font-black text-white transition-all duration-200 ${phase === 7 ? 'bg-emerald-500' : 'bg-indigo-600'} ${phase === 6 ? 'scale-95' : 'scale-100'}`}>
                  {phase === 7 ? '✓ Imported!' : 'Import 3 →'}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </PhoneFrame>
  );
}

// ── Step 4: Settings ──────────────────────────────────────────────────────────
const COLORS = [
  { name: 'Indigo',  bg: '#4f46e5' },
  { name: 'Rose',    bg: '#e11d48' },
  { name: 'Emerald', bg: '#059669' },
  { name: 'Violet',  bg: '#7c3aed' },
];

function SettingsPreview({ loopKey }) {
  const [activeIdx, setActiveIdx] = useState(0);
  const [highlightIdx, setHighlightIdx] = useState(null);

  useEffect(() => {
    setActiveIdx(0);
    setHighlightIdx(null);
    const ts = [
      setTimeout(() => setHighlightIdx(1),  700),
      setTimeout(() => { setActiveIdx(1); setHighlightIdx(null); }, 1100),
      setTimeout(() => setHighlightIdx(2),  2000),
      setTimeout(() => { setActiveIdx(2); setHighlightIdx(null); }, 2400),
      setTimeout(() => setHighlightIdx(3),  3300),
      setTimeout(() => { setActiveIdx(3); setHighlightIdx(null); }, 3700),
      setTimeout(() => setHighlightIdx(0),  4600),
      setTimeout(() => { setActiveIdx(0); setHighlightIdx(null); }, 5000),
    ];
    return () => ts.forEach(clearTimeout);
  }, [loopKey]);

  const accent = COLORS[activeIdx].bg;

  return (
    <PhoneFrame accent={accent}>
      <div className="h-full flex flex-col">
        {/* Panel header */}
        <div className="px-3 py-2 border-b border-slate-100 bg-white flex-shrink-0">
          <p className="text-[9px] font-black text-slate-800">Customize Dashboard</p>
          <p className="text-[8px] text-slate-400">Saved automatically</p>
        </div>

        <div className="flex-1 px-3 py-3 bg-white space-y-3">
          {/* Accent color */}
          <div>
            <p className="text-[8px] font-black uppercase tracking-widest text-slate-400 mb-2">Accent color</p>
            <div className="flex gap-2">
              {COLORS.map((c, i) => (
                <div
                  key={i}
                  className="w-6 h-6 rounded-full transition-all duration-200 flex items-center justify-center"
                  style={{
                    backgroundColor: c.bg,
                    transform: highlightIdx === i ? 'scale(1.2)' : activeIdx === i ? 'scale(1.15)' : 'scale(1)',
                    outline: activeIdx === i ? `2px solid ${c.bg}` : 'none',
                    outlineOffset: 2,
                    opacity: highlightIdx !== null && highlightIdx !== i && activeIdx !== i ? 0.5 : 1,
                  }}
                >
                  {activeIdx === i && <Check className="w-3 h-3 text-white" strokeWidth={3} />}
                </div>
              ))}
            </div>
          </div>

          {/* Theme */}
          <div>
            <p className="text-[8px] font-black uppercase tracking-widest text-slate-400 mb-2">Theme</p>
            <div className="flex gap-1.5">
              {['🌙 Dark', '☀️ Light'].map((t, i) => (
                <div key={i} className={`flex-1 py-1 rounded-lg text-center text-[8px] font-bold ${i === 0 ? 'text-white' : 'bg-slate-100 text-slate-400'}`}
                  style={i === 0 ? { backgroundColor: accent } : {}}>
                  {t}
                </div>
              ))}
            </div>
          </div>

          {/* Sample stat card reacting to accent */}
          <div className="rounded-xl p-2.5 border border-slate-100 bg-slate-50">
            <p className="text-[7px] text-slate-400 font-bold uppercase tracking-wider">Remaining Income</p>
            <p className="text-sm font-black mt-0.5" style={{ color: accent }}>$1,243</p>
            <p className="text-[7px] text-slate-400 mt-0.5">Surplus Position</p>
          </div>
        </div>
      </div>
    </PhoneFrame>
  );
}

// ── Wizard shell ──────────────────────────────────────────────────────────────
const STEPS = [
  {
    preview: ({ loopKey }) => <WelcomePreview loopKey={loopKey} />,
    title: 'Welcome to Budget Dashboard',
    body: "Your personal finance command center — backed by Google Sheets so your data is always yours.",
    cta: 'Get started',
    loopMs: null,
  },
  {
    preview: ({ loopKey }) => <AddExpensePreview loopKey={loopKey} />,
    title: 'Log expenses as you go',
    body: 'Tap + or press Alt+N to add an expense. Scan a receipt with the camera. Mark it recurring and it auto-fills next month.',
    cta: 'Next',
    loopMs: 4500,
  },
  {
    preview: ({ loopKey }) => <ReconcilePreview loopKey={loopKey} />,
    title: 'Reconcile at month end',
    body: "Drop your bank CSV or PDF. The app matches it against what you've already logged and shows exactly what's new.",
    cta: 'Next',
    loopMs: 5500,
  },
  {
    preview: ({ loopKey }) => <SettingsPreview loopKey={loopKey} />,
    title: 'Make it yours',
    body: 'Change the accent colour, set a PIN lock, adjust budgets, and configure daily push notifications.',
    cta: "Let's go",
    loopMs: 6000,
  },
];

export function OnboardingWizard({ onDone }) {
  const [step, setStep]       = useState(0);
  const [loopKey, setLoopKey] = useState(0);
  const current = STEPS[step];
  const isLast  = step === STEPS.length - 1;

  // Auto-loop the animation for the current step
  useEffect(() => {
    setLoopKey(0);
    if (!current.loopMs) return;
    const id = setInterval(() => setLoopKey(k => k + 1), current.loopMs);
    return () => clearInterval(id);
  }, [step]);

  return (
    <>
      <div className="fixed inset-0 bg-black/60 dark:bg-black/75 z-[70] backdrop-blur-sm" />
      <div className="fixed inset-0 z-[71] flex items-end sm:items-center justify-center sm:p-4">
        <div className="bg-white dark:bg-slate-800 rounded-t-[2rem] sm:rounded-[2rem] shadow-2xl w-full sm:max-w-md border border-slate-100 dark:border-slate-700 overflow-hidden">
          <div className="w-10 h-1 bg-slate-200 dark:bg-slate-600 rounded-full mx-auto mt-3 sm:hidden" />

          {/* Skip */}
          <div className="flex justify-end px-6 pt-4">
            <button onClick={onDone} className="text-xs font-bold text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors flex items-center gap-1">
              Skip <X className="w-3 h-3" />
            </button>
          </div>

          {/* Phone preview */}
          <div className="px-8 pt-2 pb-4">
            {current.preview({ loopKey })}
          </div>

          {/* Text */}
          <div className="px-8 pb-4 text-center space-y-2">
            <p className="text-lg font-black text-slate-800 dark:text-slate-100 leading-snug">{current.title}</p>
            <p className="text-sm text-slate-500 dark:text-slate-400 leading-relaxed">{current.body}</p>

            {/* Step dots */}
            <div className="flex justify-center gap-1.5 pt-2">
              {STEPS.map((_, i) => (
                <button
                  key={i}
                  onClick={() => setStep(i)}
                  className={`h-1.5 rounded-full transition-all duration-300 ${i === step ? 'w-6 bg-indigo-500' : 'w-1.5 bg-slate-200 dark:bg-slate-600 hover:bg-slate-300'}`}
                />
              ))}
            </div>
          </div>

          {/* CTA */}
          <div className="px-8 pb-8" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 2rem)' }}>
            <button
              onClick={() => isLast ? onDone() : setStep(s => s + 1)}
              className="w-full py-3.5 rounded-2xl text-sm font-bold text-white bg-indigo-600 hover:bg-indigo-700 transition-all shadow-lg shadow-indigo-200 dark:shadow-indigo-900/30 flex items-center justify-center gap-2"
            >
              {current.cta}
              {!isLast && <ChevronRight className="w-4 h-4" />}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
