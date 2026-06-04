import { Camera } from 'lucide-react';

// Contextual: visible on Dashboard and Ledger only, hidden on History/Cards.
// Triggers the existing ReceiptScanButton ref (wired in ExpenseTable).
// Phase 9 will add Ledger-native scanner; until then the FAB is a no-op on Ledger.
export function CameraFab({ activeTab, scanTriggerRef }) {
  if (activeTab !== 'budget' && activeTab !== 'ledger') return null;

  return (
    <button
      onClick={() => scanTriggerRef.current?.()}
      className="fixed z-30 lg:hidden w-12 h-12 rounded-full glass-medium flex items-center justify-center transition-transform duration-100 active:scale-90 animate-fade-in"
      style={{
        bottom: 'calc(64px + env(safe-area-inset-bottom) + 1rem)',
        right: '1rem',
        border: '1px solid oklch(100% 0 0 / 12%)',
        boxShadow: '0 2px 16px oklch(0% 0 0 / 30%)',
      }}
      aria-label="Scan receipt"
    >
      <Camera
        className="w-5 h-5"
        style={{ color: 'var(--color-text-secondary)' }}
        strokeWidth={2}
      />
    </button>
  );
}
