import React, { useState, useEffect } from 'react';
import { Palette } from 'lucide-react';

const HUE_KEY = 'budget_theme_hue';

export function ThemePicker() {
  const [hue, setHue] = useState(() =>
    parseInt(localStorage.getItem(HUE_KEY) ?? '30', 10)
  );

  useEffect(() => {
    document.documentElement.style.setProperty('--primary-hue', String(hue));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleChange = (e) => {
    const h = parseInt(e.target.value, 10);
    setHue(h);
    document.documentElement.style.setProperty('--primary-hue', String(h));
    localStorage.setItem(HUE_KEY, String(h));
  };

  return (
    <div
      className="flex items-center gap-2 px-2.5 py-2 rounded-xl"
      style={{ background: 'var(--color-surface)', border: '1px solid oklch(100% 0 0 / 10%)' }}
    >
      <Palette
        className="w-3.5 h-3.5 flex-shrink-0"
        style={{ color: `oklch(65% 0.18 ${hue})` }}
      />
      <input
        type="range"
        min="0"
        max="359"
        value={hue}
        onChange={handleChange}
        aria-label="Theme color hue"
        className="w-20 h-1.5 rounded-full cursor-pointer appearance-none bg-transparent"
        style={{
          background: `linear-gradient(to right,
            oklch(65% 0.18 0),   oklch(65% 0.18 45),  oklch(65% 0.18 90),
            oklch(65% 0.18 135), oklch(65% 0.18 180), oklch(65% 0.18 225),
            oklch(65% 0.18 270), oklch(65% 0.18 315), oklch(65% 0.18 359))`,
        }}
      />
    </div>
  );
}
