import { useState, useEffect, useRef } from 'react';
import { LayoutDashboard, BookOpen, Plus, Users, CreditCard } from 'lucide-react';

const NAV_ITEMS = [
  { id: 'budget',  Icon: LayoutDashboard, label: 'Home'   },
  { id: 'ledger',  Icon: BookOpen,        label: 'Ledger' },
  { id: '_add',    Icon: null,            label: 'Add'    },
  { id: 'split',   Icon: Users,           label: 'Split'  },
  { id: 'cards',   Icon: CreditCard,      label: 'Cards'  },
];

// Notch: concave arc at top-center, radius 34px (button radius 28px + 6px clearance)
const NOTCH_MASK = 'radial-gradient(circle 34px at 50% 0, transparent 33px, black 34px)';

// Facebook-style auto-hide: collapse the bar when scrolling down, reveal it
// when scrolling up or on any touch. Reveal always wins near the top.
function useAutoHideOnScroll() {
  const [hidden, setHidden] = useState(false);
  const lastY = useRef(0);
  const ticking = useRef(false);

  useEffect(() => {
    lastY.current = window.scrollY;

    const evaluate = () => {
      ticking.current = false;
      const y = window.scrollY;
      const delta = y - lastY.current;
      // Ignore rubber-band/tiny jitter; always show near the top.
      if (y < 80) {
        setHidden(false);
      } else if (delta > 8) {
        setHidden(true);   // scrolling down → hide
      } else if (delta < -8) {
        setHidden(false);  // scrolling up → show
      }
      lastY.current = y;
    };

    const onScroll = () => {
      if (!ticking.current) {
        ticking.current = true;
        requestAnimationFrame(evaluate);
      }
    };
    const onTouch = () => setHidden(false);

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('touchstart', onTouch, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('touchstart', onTouch);
    };
  }, []);

  return hidden;
}

export function BottomNav({ activeTab, setActiveTab, onAdd, isReadOnly }) {
  const hidden = useAutoHideOnScroll();

  return (
    <nav
      className="fixed bottom-0 inset-x-0 z-40 lg:hidden"
      style={{
        transform: hidden ? 'translateY(calc(100% + 2.5rem))' : 'translateY(0)',
        transition: 'transform 0.25s ease',
        willChange: 'transform',
      }}
      aria-label="Main navigation"
    >
      <div className="relative">
        {/* Glass bar — safe-area inset lives inside so the frosted fill reaches the true bottom */}
        <div
          className="glass-nav"
          style={{
            borderTop: '1px solid var(--sur-10)',
            mask: NOTCH_MASK,
            WebkitMask: NOTCH_MASK,
            paddingBottom: 'env(safe-area-inset-bottom)',
          }}
        >
          <div className="flex h-16">
            {NAV_ITEMS.map(({ id, Icon, label }) => {
              if (id === '_add') {
                return <div key="_add" className="flex-1" aria-hidden="true" />;
              }
              const isActive = activeTab === id;
              return (
                <button
                  key={id}
                  onClick={() => setActiveTab(id)}
                  className="flex-1 flex flex-col items-center justify-center gap-1 focus:outline-none focus-visible:outline-none"
                  aria-label={label}
                  aria-current={isActive ? 'page' : undefined}
                >
                  <Icon
                    className="w-5 h-5 transition-colors duration-150"
                    style={{ color: isActive ? 'var(--color-accent)' : 'var(--color-text-muted)' }}
                    strokeWidth={isActive ? 2.5 : 2}
                  />
                  <span
                    className="text-[10px] font-semibold leading-none transition-colors duration-150"
                    style={{ color: isActive ? 'var(--color-accent)' : 'var(--color-text-muted)' }}
                  >
                    {label}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Raised + FAB — center straddles bar top edge */}
        {!isReadOnly && (
          <button
            onClick={onAdd}
            className="absolute -top-7 left-1/2 -translate-x-1/2 w-14 h-14 rounded-full flex items-center justify-center transition-transform duration-100 active:scale-90"
            style={{
              background: 'var(--color-accent)',
              boxShadow: '0 4px 24px oklch(65% 0.18 var(--accent-hue) / 40%)',
            }}
            aria-label="Add expense"
          >
            <Plus className="w-7 h-7 text-white" strokeWidth={2.5} />
          </button>
        )}
      </div>
    </nav>
  );
}
