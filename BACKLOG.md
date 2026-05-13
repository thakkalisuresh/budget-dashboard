# Budget Tracker — Backlog & Parked Plans

---

## 🔴 High Priority

### 1. Offline Support

**What we're building**
- Auth bypass when offline (cached user profile in localStorage)
- Cached budget data (last known totals shown when offline)
- Offline expense queue with optimistic updates (syncs when back online)
- Session expiry banner (small banner when token expires on reconnect)

**Agreed behaviour**
- Offline expense add → shows immediately in UI (optimistic), queued to localStorage, syncs to Google Sheets when back online
- Cached data → last known budget numbers shown when offline, not blank
- Session expiry → small banner "Session expired, tap to sign back in", not auto-prompt

**Files to create**

`src/offlineQueue.js` — queue management
```js
// Structure per item:
// { id, type: 'add_expense', payload: { categoryName, vendorName, amount, monthName, source, isNonMonthly }, queuedAt, retries }

export function getQueue()           // reads from localStorage 'budget_offline_queue'
export function enqueue(item)        // adds item with generated id
export function dequeue(id)          // removes item by id
export function clearQueue()         // clears all
export function updateRetries(id, count) // increment retry count
```

**Files to modify**

`src/useAuth.js`
- On successful login: save `{ name, email, picture, accessToken, expiresAt }` to `localStorage` key `budget_auth_cache`
- On app load when `navigator.onLine === false`: if `budget_auth_cache` exists, return cached user, skip Google OAuth entirely
- Add `isOfflineSession` flag to returned user object
- On reconnect: if `expiresAt` is past, show session expiry banner

`src/useSheetData.js`
- On successful data fetch: save to `localStorage` key `budget_data_cache_${sheetId}`
- On fetch failure or offline: load from cache, set `isFromCache: true` flag
- Return `isFromCache` alongside existing `data, loading, error, lastUpdated`

`src/sheetsApi.js` — `addOrUpdateExpense`
- Before API call, check `navigator.onLine`
- If offline: call `enqueue({ type: 'add_expense', payload: {...} })` and return `{ queued: true }`

`src/App.jsx`
- Add `useEffect` listening to `window online/offline` events, set `isOnline` state
- Offline: amber banner "You're offline — changes will sync when reconnected"
- Session expired on reconnect: small banner "Session expired — tap to sign back in"
- Queue processor `useEffect` watches `isOnline` — when true, process queue:
  - Check token validity
  - Call `addOrUpdateExpense` for each item
  - On success: `dequeue(item.id)`, call `refresh()`
  - On failure: `updateRetries`, show error if retries > 3
- Optimistic update: when `{ queued: true }` returned, manually update local `data` state

`src/AddExpenseDialog.jsx`
- If queued: show "Saved offline — will sync when reconnected"

**Key implementation details**

Token expiry check:
```js
const expiresAt = parseInt(localStorage.getItem('budget_auth_cache_expiry') || '0');
const isExpired = Date.now() > expiresAt - 60_000; // 1 min buffer
```

Online/offline detection:
```js
const [isOnline, setIsOnline] = useState(navigator.onLine);
useEffect(() => {
  const up   = () => setIsOnline(true);
  const down = () => setIsOnline(false);
  window.addEventListener('online', up);
  window.addEventListener('offline', down);
  return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down); };
}, []);
```

Queue processor:
```js
useEffect(() => {
  if (!isOnline || !user.accessToken) return;
  const queue = getQueue();
  if (queue.length === 0) return;
  (async () => {
    for (const item of queue) {
      try {
        await addOrUpdateExpense(/* item.payload */);
        dequeue(item.id);
      } catch {
        updateRetries(item.id, item.retries + 1);
      }
    }
    refresh();
  })();
}, [isOnline]);
```

**Notes**
- Token stored in `sessionStorage` currently (`budget_auth`). Offline cache goes in `localStorage` to survive browser close
- `expiresAt = Date.now() + 3_600_000` on login (Google tokens expire in ~1 hour)
- `budget_data_cache_${sheetId}` stores the full parsed `data` array
- Queue items with `retries > 3` shown as failed in UI, not silently dropped

**Build order**
1. `offlineQueue.js` — create from scratch
2. `useAuth.js` — add cache read/write
3. `useSheetData.js` — add cache + `isFromCache` flag
4. `sheetsApi.js` — offline check in `addOrUpdateExpense`
5. `App.jsx` — online/offline detection, queue processor, banners, optimistic update
6. `AddExpenseDialog.jsx` — queued state UI
7. Build + deploy in one shot

---

### 2. Version / Build Number

**What we're building**
Version number + build timestamp visible in the app, auto-injected at build time. Useful for confirming which version is running after a deploy.

**Display locations**
- **Profile dropdown** — subtle version line below "Sign out"
- **Settings panel** — bottom, below "Clear Cache & Refresh"
- Both styled as small muted monospace text: `text-[10px] text-slate-400 font-mono`

**Files to modify**

`vite.config.js`
```js
import { readFileSync } from 'fs';
const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));

// Inside defineConfig:
define: {
  __APP_VERSION__: JSON.stringify(pkg.version),
  __BUILD_TIME__:  JSON.stringify(new Date().toISOString()),
},
```

`src/App.jsx` — profile dropdown, below Sign out:
```jsx
<div className="px-4 py-2 text-[10px] text-slate-400 font-mono border-t border-slate-100 dark:border-slate-700">
  v{__APP_VERSION__} · {new Date(__BUILD_TIME__).toLocaleDateString()}
</div>
```

`src/SettingsPanel.jsx` — bottom of panel:
```jsx
<p className="text-center text-[10px] text-slate-300 dark:text-slate-600 font-mono mt-2">
  Budget Tracker v{__APP_VERSION__} · Built {new Date(__BUILD_TIME__).toLocaleString()}
</p>
```

`package.json` — set initial version:
```json
"version": "1.0.0"
```

**Notes**
- `__APP_VERSION__` and `__BUILD_TIME__` are baked into the JS bundle at build time — always accurate for the deployed build
- Build timestamp updates automatically on every deploy
- No runtime overhead, no extra API calls

**Build order**
1. `vite.config.js` — inject defines
2. `package.json` — set version
3. `App.jsx` — profile dropdown version line
4. `SettingsPanel.jsx` — bottom version line
5. Build + deploy

---

## 🟡 Medium Priority

### 3. Spending Trends
Month-over-month comparison chart. "You spent $200 more on Eating Out than last month." Pulls data from multiple month sheets.

### 4. Budget Forecasting
Based on current spend rate and days left in month, project end-of-month totals per category. "At this rate you'll be $150 over on Grocery."

### 5. Recurring Expense Auto-Fill
When creating a new month, automatically pre-populate recurring vendor rows (Netflix, rent, etc.) already marked as recurring. Currently only copies template structure, not actual vendor rows.

### 6. Year-to-Date Summary
Total spend across all months this year, broken down by category. Requires reading multiple month sheets in parallel.

### 7. Savings Rate Tracking
What % of income was saved each month, trending over time. Simple calculation but needs multi-month data.

### 8. Net Worth Tracking
New sheet tab for assets vs liabilities. Running net worth over time.

### 9. PDF Export
Monthly report as PDF. CSV already done — PDF adds formatted layout with charts.

---

## 🟢 Lower Priority / Quality of Life

### 10. Onboarding Wizard
**Parked** — needs decision on scope before building:
- Option A: First-time setup wizard (for someone deploying their own copy)
- Option B: New user welcome tour (UI walkthrough for family members like wife)
- Recommended: Option B, shown once per user account (tracked in UserSettings)

### 11. Multi-User Foundation
Shared budget roles, who added what. Largest architectural change in the backlog. Requires deciding on role model (owner vs viewer vs editor).

### 12. Admin Read-Only Mode
View-only access level. Simpler than full multi-user — just a flag that disables all write operations for designated accounts.

### 13. Keyboard Shortcuts
`N` to add expense, `R` for receipt scan, `Esc` to close panels. Desktop-focused quality of life.

### 14. Bulk Import from Recurring
One tap to add all recurring expenses for the current month at once, instead of adding them one by one.

### 15. Detail Panel Non-Monthly Quick-Tap
Currently the "one-time expense" toggle in the Detail Panel is only accessible via the pencil edit mode. Should also be accessible via a direct tap/icon on the vendor row.

### 16. PDF Support for Reconciliation
Upload bank statement PDFs instead of CSV only. Two options discussed:
- **Claude API** — send PDF to `/api/claude`, costs ~$0.04/statement, data leaves device
- **PDF.js** — client-side text extraction, free, stays on device, but messy for some bank formats
- Decision: parked pending user preference on privacy vs convenience trade-off

---

## ✅ Recently Completed
- UUID per transaction (lazy, forward-only, amount encoded in ID)
- Smart Rules (Settings UI + auto-fill in Add Expense, Reconcile, Receipt Scan)
- Bank Reconciliation (all 4 phases: upload, dedup, review, import)
- Web Push notifications + Messages tab
- Non-Monthly Expenses v2 (sheet-backed, auto-migration from I4)
- Biometric unlock (WebAuthn — Face ID / Touch ID)
- History tab + Ledger fixes
- Permissions auto-share on new month creation
- Error boundary + SW auto-reload on deploy
- CSV export (transaction ledger + monthly summary)
