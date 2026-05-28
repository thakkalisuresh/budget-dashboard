# Feature: Heatmap Spending Calendar

## What
A GitHub-style calendar grid showing daily spend intensity for the current month. Higher spend = darker color using the app's OKLCH accent. Lazy-loaded and togglable via settings.

## Target phases for this branch
- **Phase 1** — Single-month SVG heatmap (7-column Mon–Sun grid); D3 sequential color scale; tooltip with daily total + transaction count; behind `settings.visibility.heatmap` toggle
- **Phase 2** — Month navigation arrows (← →); cache previously-fetched months so switching is instant
- **Phase 3** — "vs last year" comparison overlay; streak badge ("7-day streak under budget")

## Files to create
- `src/SpendingHeatmap.jsx` — D3 SVG calendar grid component

## Files to modify
- `src/App.jsx` — lazy-import and render `<SpendingHeatmap>` in Dashboard tab
- `src/useSettings.js` — add `visibility.heatmap: true` to `DEFAULT_SETTINGS`
- `src/SettingsPanel.jsx` — add heatmap visibility toggle

## Dependencies
D3 is already installed (`d3 ^7`). No new packages needed.

## Data source
`fetchDetail` (already fetches all transactions with dates for the active month). Aggregate by date → daily totals.

## Branch
`feat/heatmap` → merge to `main` after Phase 2 is verified.
