/**
 * fund-ient logo options — three distinct SVG designs.
 *
 * Usage:  <FundientLogo variant="spark" size={32} />
 *         variant: "spark" | "wave" | "coin"
 */

/* ─────────────────────────────────────────────────────────────────────────────
   Option A — "Spark"
   Rounded square, indigo→violet gradient, white "f" letterform, gold star accent.
   Feels like a polished app icon.
───────────────────────────────────────────────────────────────────────────── */
export function LogoSpark({ size = 40 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="lsSpark" x1="0" y1="0" x2="40" y2="40" gradientUnits="userSpaceOnUse">
          <stop stopColor="#4f46e5" />
          <stop offset="1" stopColor="#7c3aed" />
        </linearGradient>
      </defs>
      {/* Background tile */}
      <rect width="40" height="40" rx="11" fill="url(#lsSpark)" />

      {/* "f" letterform */}
      <path
        d="M13.5 13C13.5 9.8 15.8 8 19 8C21 8 22.5 8.5 23.5 9.2L22.4 12C21.7 11.4 20.6 11 19.6 11C18 11 16.8 11.9 16.8 13.7V17H22.5V20H16.8V31H13.5V13Z"
        fill="white"
      />

      {/* 4-pointed gold star top-right */}
      <path
        d="M28 7 L28.7 9.3 L31 10 L28.7 10.7 L28 13 L27.3 10.7 L25 10 L27.3 9.3 Z"
        fill="#fbbf24"
      />
    </svg>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   Option B — "Wave"
   Dark circle, white "f" stroke, teal trend-line erupting from the stem.
   Feels analytical and data-forward.
───────────────────────────────────────────────────────────────────────────── */
export function LogoWave({ size = 40 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
      {/* Background disc */}
      <circle cx="20" cy="20" r="20" fill="#0f172a" />

      {/* "f" as stroked path */}
      <path
        d="M14 13.5C14 10.2 16.5 8.5 19.5 8.5C21.3 8.5 22.7 9 23.8 9.8L22.6 12.5C21.9 12 20.9 11.5 19.9 11.5C18.4 11.5 17.2 12.3 17.2 14V17.5H22.5V20.5H17.2V25"
        stroke="white"
        strokeWidth="2.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      {/* Trend wave flowing from stem bottom */}
      <path
        d="M9 29 C11.5 29 13 26.5 15 27.5 C17 28.5 18.5 31 21 30 C23.5 29 24.5 26 27 26.5 L31 25"
        stroke="#34d399"
        strokeWidth="2.2"
        strokeLinecap="round"
        fill="none"
      />
      {/* Arrow tip */}
      <path
        d="M28.5 22.5 L31.5 25 L28.5 27"
        stroke="#34d399"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   Option C — "Coin"
   Circle with a sky-to-indigo gradient, bold outlined "f" + subtle inner ring.
   Looks like a premium fintech token/coin.
───────────────────────────────────────────────────────────────────────────── */
export function LogoCoin({ size = 40 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="lsCoin" x1="0" y1="0" x2="40" y2="40" gradientUnits="userSpaceOnUse">
          <stop stopColor="#0ea5e9" />
          <stop offset="1" stopColor="#4f46e5" />
        </linearGradient>
      </defs>

      {/* Outer disc */}
      <circle cx="20" cy="20" r="20" fill="url(#lsCoin)" />

      {/* Inner ring — coin edge detail */}
      <circle cx="20" cy="20" r="17" stroke="white" strokeOpacity="0.15" strokeWidth="1.2" fill="none" />

      {/* "f" letterform — thicker, centered */}
      <path
        d="M15 14C15 10.7 17.3 9 20.5 9C22.4 9 23.8 9.5 24.8 10.2L23.7 13.2C23 12.6 22 12.2 21 12.2C19.4 12.2 18.3 13.1 18.3 14.8V18.5H24V21.5H18.3V31H15V14Z"
        fill="white"
      />
    </svg>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   Convenience wrapper — pass variant prop
───────────────────────────────────────────────────────────────────────────── */
export function FundientLogo({ variant = 'spark', size = 40 }) {
  if (variant === 'wave') return <LogoWave size={size} />;
  if (variant === 'coin') return <LogoCoin size={size} />;
  return <LogoSpark size={size} />;
}
