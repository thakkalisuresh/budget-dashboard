# Budget Dashboard — Pending Work

## 🔨 In Progress
- **Statement Reconciliation** (`feature/reconciliation` branch)
  - PDF upload (text + scanned/image fallback via Claude vision)
  - Password-protected PDF support
  - Multi-document session (bank + card in one go)
  - AI-assisted transaction extraction and fuzzy vendor matching
  - Inline resolution UI (Matched / Needs Review / Missing / Dashboard Only)
  - Inline add of missing transactions
  - Debit vs credit handling (ask user when net is zero but movements exist)
  - Surface internal transfers to user for manual exclusion
  - Netlify Function for Anthropic API key (server-side, not exposed in browser)

---

## 📋 Pending / Not Started

### Features
- **Reconciliation log** — track already-reconciled transactions so weekly/real-time
  use doesn't re-surface confirmed items (deferred, build after reconciliation ships)
- ~~**New month carries over custom categories**~~ ✅ Fixed — `NewMonthDialog` now appends
  custom categories to the budget step and `handleCreate` calls `addCategoryToTotals` +
  `createCategoryDetailSheet` + `linkCategoryToDetailSheet` for each custom category after
  the template copy completes

### Infrastructure
- **localStorage → Google Sheets migration** (category icons + custom categories done ✅)
  — verify no other user data is still siloed in localStorage only
- **Hybrid caching layer** — parked as large-scale planning. Aggressive localStorage
  read-cache to reduce Sheets API latency. Upstash Redis if multi-user ever needed.

---

## 🐛 Known Issues / Gaps
- `fetchDetail.js` `getEffectiveSheetMap()` relies on localStorage for custom categories
  (intentional — kept as a fast sync cache hydrated from settings on load, but worth
  eventually making this fully settings-driven)
- **Undo delete transaction writes outside table bounds** — when a transaction is deleted
  and then undone via the history tab, the undo writes the row back outside the expected
  table range in the Google Sheet

---

## ✅ Recently Completed
- Currency switcher in Settings (20 currencies, persisted to UserSettings sheet)
- Category emoji icons — picker with keyword search, persisted to UserSettings sheet
- Custom categories persisted to UserSettings sheet (was localStorage only)
- Mobile bottom sheet pattern for all dialogs
- Mobile ⋯ action sheet for category rename / delete / icon change
- Horizontal scroll on expense table (mobile)
- Add / Rename / Delete category with 50/30/20 sheet sync
- Salary and budget inline editing
- Global Escape key handler for all panels and modals
- Distinct stat card icons (Receipt, Banknote, Wallet)
- History tab shows user name, supports Category Renamed undo
- 50/30/20 sheet wired to Add Category (Need / Want / Saving type)
