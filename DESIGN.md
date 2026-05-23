# Design

## Overview

Fundient uses a white/slate palette with indigo as the primary interactive color, very rounded corners throughout, system UI fonts, and dark mode support via Tailwind's dark: variant. The design skews toward product-safe defaults (restrained color, generous whitespace) but several anti-patterns have crept in.

## Color

### Current palette (light mode)
- **Background**: `#fcfdfe` (page), `#ffffff` (cards)
- **Surface elevated**: `bg-white` / `bg-slate-50`
- **Border**: `border-slate-100`, `border-slate-200`
- **Text primary**: `text-slate-900` / `text-slate-700`
- **Text secondary**: `text-slate-400`, `text-slate-500`
- **Primary action**: `indigo-600` (Tailwind) — used for buttons, focus rings, active states
- **CSS accent variable**: `--accent: #aa3bff` — purple, defined but rarely applied (inconsistency)
- **Status colors**:
  - Success/live: `emerald-400` / `emerald-600`
  - Error/over-budget: `rose-500` / `rose-600`
  - Warning/amber: `amber-500`
  - Info/blue: `blue-600`

### Dark mode
- **Background**: `bg-slate-950` (page), `bg-slate-800` (cards)
- **Border**: `border-slate-700`
- **Text primary**: `text-slate-100` / `text-slate-200`
- **Text secondary**: `text-slate-400`

### Color strategy
Currently **Restrained** — tinted neutrals plus one accent under 10%. Indigo carries action; everything else is neutral.

### Known issue
`--accent` (purple) and Tailwind's `indigo-600` are both in use but never reconciled. Interactive elements use indigo; the CSS variable is orphaned. When rethinking color, this conflict must be resolved in one direction.

## Typography

- **Font stack**: System UI (`system-ui, 'Segoe UI', Roboto, sans-serif`) — no custom typeface loaded
- **Base**: `18px / 145%` line-height, `0.18px` letter-spacing
- **Mobile base**: `16px`
- **Weights in use**: `font-bold` (700), `font-black` (800/900)
- **Label style**: `text-[10px] font-black uppercase tracking-[0.2em]` — all-caps micro labels on stat cards
- **Value style**: `text-2xl sm:text-4xl font-black tabular-nums` — finance figures
- **Heading style**: `text-2xl font-black tracking-tight`
- **No intermediate weight steps** (400/500/600 not meaningfully used)

## Elevation

- **Card resting**: `shadow-[0_8px_30px_rgb(0,0,0,0.02)]`
- **Card hover**: `shadow-[0_8px_30px_rgb(0,0,0,0.06)] -translate-y-1`
- **Login card**: `shadow-[0_8px_40px_rgb(0,0,0,0.06)]`
- **Dropdowns**: `shadow-xl`
- Dark mode multiplies shadow opacity ~4x

## Border Radius

All radius values are uniform — no variation in the system:
- **Cards, dialogs, modals, sheets**: `rounded-[2rem]` (32px)
- **Buttons, icons, dropdowns**: `rounded-2xl` (16px)
- **Badges, dots, pills**: `rounded-full`

**Issue**: Identical 32px radius on every surface creates visual monotony. No hierarchy signal from shape alone.

## Spacing

- **Card padding**: `p-5 sm:p-8`
- **Card content gap**: `space-y-4 sm:space-y-6`
- **Grid gaps**: `gap-3` to `gap-6`
- **Header**: `gap-3` between control groups

Consistent but flat — same padding rules applied to all card types regardless of information density.

## Components

### StatCard
White card, `rounded-[2rem]`, colored icon square (4 colors: blue, rose, emerald, indigo, amber), value in `font-black`, all-caps tracking label. Matches the hero-metric anti-pattern.

### InsightCards
Dark cards — `bg-slate-900` and `bg-indigo-600`. The only surfaces that break away from the white/neutral baseline. Decorative blur blobs (`blur-2xl`, `bg-indigo-500/10`) in corners.

### ExpenseTable / DetailPanel
Standard table layout within white card containers.

### HeaderBar
Flat control row — pill-shaped icon buttons in white with border, user avatar + name dropdown, theme toggle.

### Dialogs / BottomSheets
`rounded-[2rem]` containers, consistent with all other cards. Mobile: slides up from bottom.

### SpeedDial
Floating action button (bottom-right), radial menu.

## Motion

- Hover: `transition-all`, `hover:-translate-y-1` on cards
- Collapse/expand: CSS transitions
- Spinner: `animate-spin`
- No animation easing specified explicitly — browser defaults

## Anti-patterns present (from code scan)

1. **Identical card grid** — StatCards share the same size, shape, and structure with only color varying
2. **Hero-metric template** — big number, tiny all-caps label, colored icon square — exactly the SaaS cliché
3. **Decorative blurs** — `blur-2xl` blobs in InsightCards corners approach glassmorphism territory
4. **Uniform radius** — `rounded-[2rem]` on everything from dialogs to stat cards to dropdowns
5. **Color split** — CSS `--accent` (purple) vs Tailwind `indigo-*` — never unified
