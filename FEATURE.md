# Feature: CSV / JSON Export (Enhanced)

## What
Extend the existing CSV export to support JSON downloads, a full-year multi-month export, and an optional scheduled auto-export by email.

## Target phases for this branch
- **Phase 1** — JSON export button in DetailPanel; extract shared export logic
- **Phase 2** — "Export all months" dropdown in LedgerTab with progress indicator

## Files to create
- `src/exportHelpers.js` — `transactionsToJson(rows)`, `transactionsToCsv(rows)`, `downloadBlob(content, filename, type)`

## Files to modify
- `src/DetailPanel.jsx` — add JSON button next to existing CSV button; use `exportHelpers`
- `src/LedgerTab.jsx` — add "Export all months ▾" dropdown (Phase 2)

## Dependencies
None — pure client-side, no new npm packages.

## Branch
`feat/json-export` → merge to `main` after Phase 2 is verified.
