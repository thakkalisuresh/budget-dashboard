/**
 * Stack Mark — Fundient brand icon.
 * 4 left-aligned bars, decreasing width, top bar in accent color.
 * Width ratios: 1 / 0.58 / 0.33 / 0.17. Bar height = 8px, gap = 3px.
 * Ships as inline SVG so it inherits CSS custom properties.
 */
export function StackMark({ size = 32, className }) {
  const h = Math.round(size * 41 / 48);
  return (
    <svg
      viewBox="0 0 48 41"
      width={size}
      height={h}
      className={className}
      aria-hidden="true"
      fill="none"
    >
      <rect x="0" y="0"  width="48" height="8" rx="4" fill="var(--color-accent)" />
      <rect x="0" y="11" width="28" height="8" rx="4" fill="var(--color-text-muted, #4a4035)" />
      <rect x="0" y="22" width="16" height="8" rx="4" fill="var(--color-text-muted, #4a4035)" />
      <rect x="0" y="33" width="8"  height="8" rx="4" fill="var(--color-text-muted, #4a4035)" />
    </svg>
  );
}
