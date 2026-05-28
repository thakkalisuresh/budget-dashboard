# Feature: Natural Language Expense Logging

## What
Add a "Quick add" text field at the top of AddExpenseDialog. User types "coffee 4.50 today" and Claude Haiku parses it into vendor, amount, date, and category — pre-filling the form fields.

## Target phases for this branch
- **Phase 1** — Quick-add text input; POST to existing `/api/claude` edge function with `mode: 'parse-text'`; pre-fill form on response
- **Phase 2** — Graceful fallback for unparsed fields; natural date shortcuts ("yesterday", "last monday"); yellow highlight on unparsed amount
- **Phase 3** — Inline confirmation chip instead of full pre-fill ("Starbucks · $5.50 · Eating Out · today — confirm?")

## Files to modify
- `src/AddExpenseDialog.jsx` — add `nlText` + `nlLoading` state; Quick add input UI; call Claude on Enter
- `netlify/edge-functions/claude.js` — add `mode === 'parse-text'` branch using `claude-haiku-4-5`; text-only system prompt returning `{vendor, amount, date, category}`

## Dependencies
None — reuses existing `/api/claude` edge function and `claude-haiku-4-5`.

## Branch
`feat/nl-logging` → merge to `main` after Phase 2 is verified (Phase 3 optional).
