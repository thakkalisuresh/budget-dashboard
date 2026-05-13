# Graph Report - C:/Users/anupa/Downloads/cl/dashboard  (2026-05-03)

## Corpus Check
- 62 files · ~112,541 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 339 nodes · 581 edges · 26 communities detected
- Extraction: 91% EXTRACTED · 9% INFERRED · 0% AMBIGUOUS · INFERRED: 52 edges (avg confidence: 0.83)
- Token cost: 8,974 input · 3,882 output

## Community Hubs (Navigation)
- [[_COMMUNITY_App Shell & Navigation|App Shell & Navigation]]
- [[_COMMUNITY_Expense Entry & Sheets Sync|Expense Entry & Sheets Sync]]
- [[_COMMUNITY_Transaction History & Ledger|Transaction History & Ledger]]
- [[_COMMUNITY_Planned Features & Roadmap|Planned Features & Roadmap]]
- [[_COMMUNITY_AI Chat Agent|AI Chat Agent]]
- [[_COMMUNITY_Social & Doc Icons|Social & Doc Icons]]
- [[_COMMUNITY_Reconciliation UI|Reconciliation UI]]
- [[_COMMUNITY_App Icon Design System|App Icon Design System]]
- [[_COMMUNITY_CSV Bank Parsing|CSV Bank Parsing]]
- [[_COMMUNITY_Favicon & Brand Colors|Favicon & Brand Colors]]
- [[_COMMUNITY_Auth & PIN Security|Auth & PIN Security]]
- [[_COMMUNITY_User Settings|User Settings]]
- [[_COMMUNITY_Marketing & Branding|Marketing & Branding]]
- [[_COMMUNITY_Vendor Detail Panel|Vendor Detail Panel]]
- [[_COMMUNITY_Wallet Icon Identity|Wallet Icon Identity]]
- [[_COMMUNITY_Error Handling|Error Handling]]
- [[_COMMUNITY_PWA Icon Design|PWA Icon Design]]
- [[_COMMUNITY_Reconciliation Backend|Reconciliation Backend]]
- [[_COMMUNITY_Icon Generation Script|Icon Generation Script]]
- [[_COMMUNITY_App Entry & PWA|App Entry & PWA]]
- [[_COMMUNITY_Claude API Proxy|Claude API Proxy]]
- [[_COMMUNITY_Tech Stack Logos|Tech Stack Logos]]
- [[_COMMUNITY_PDF Export|PDF Export]]
- [[_COMMUNITY_Onboarding|Onboarding]]
- [[_COMMUNITY_CSV Export|CSV Export]]
- [[_COMMUNITY_Transaction ID|Transaction ID]]

## God Nodes (most connected - your core abstractions)
1. `apiFetch()` - 24 edges
2. `addOrUpdateExpense()` - 17 edges
3. `writeCell()` - 12 edges
4. `appendHistoryEntry()` - 12 edges
5. `undoHistoryEntry()` - 12 edges
6. `getAllCategoryNames()` - 12 edges
7. `App Icon 512px` - 12 edges
8. `fetchDetailRows()` - 11 edges
9. `updateVendorAmounts()` - 11 edges
10. `Dashboard()` - 9 edges

## Surprising Connections (you probably didn't know these)
- `localStorage to Google Sheets Migration` --conceptually_related_to--> `Google Sheets Integration`  [INFERRED]
  TODOS.md → BACKLOG.md
- `NewMonthDialog Component` --conceptually_related_to--> `Google Sheets Integration`  [INFERRED]
  TODOS.md → BACKLOG.md
- `Undo Delete Transaction Bug` --conceptually_related_to--> `Google Sheets Integration`  [INFERRED]
  TODOS.md → BACKLOG.md
- `Smart Rules Feature` --conceptually_related_to--> `AddExpenseDialog Component (Build Snapshot)`  [INFERRED]
  BACKLOG.md → build-snapshots/build_2026-04-25_19-39-30.txt
- `addOrUpdateExpense() Function` --implements--> `src/sheetsApi.js`  [EXTRACTED]
  build-snapshots/build_2026-04-25_19-39-30.txt → BACKLOG.md

## Hyperedges (group relationships)
- **Offline Expense Sync Flow** — backlog_offline_queue_js, backlog_app_jsx, backlog_sheets_api_js [EXTRACTED 1.00]
- **Add Expense Dialog Interaction** — build_add_expense_dialog, build_fetch_detail_rows, build_add_or_update_expense [EXTRACTED 1.00]
- **Auth Caching for Offline Sessions** — backlog_use_auth_js, backlog_local_storage_cache, backlog_google_oauth [EXTRACTED 1.00]
- **Icon Visual Composition** —  [INFERRED 1.00]

## Communities (38 total, 7 thin omitted)

### Community 0 - "App Shell & Navigation"
Cohesion: 0.06
Nodes (25): AddCategoryDialog(), App(), Dashboard(), BudgetRules(), getCurrencySymbol(), DeleteCategoryDialog(), LoginScreen(), MessagesPanel() (+17 more)

### Community 1 - "Expense Entry & Sheets Sync"
Cohesion: 0.14
Nodes (40): applyToSheet(), AddExpenseDialog(), NewMonthDialog(), addCategoryTo503020(), addCategoryToTotals(), addOrUpdateExpense(), apiFetch(), appendHistoryEntry() (+32 more)

### Community 2 - "Transaction History & Ledger"
Cohesion: 0.09
Nodes (17): HistoryTab(), buildLedger(), LedgerTab(), checkDuplicates(), compressImage(), detectMimeType(), extractFromFile(), ReceiptScanButton() (+9 more)

### Community 3 - "Planned Features & Roadmap"
Cohesion: 0.08
Nodes (31): src/AddExpenseDialog.jsx, src/App.jsx, Biometric Unlock (WebAuthn), Budget Forecasting Feature, Google OAuth Authentication, Google Sheets Integration, localStorage Caching Strategy, Multi-User Foundation (+23 more)

### Community 4 - "AI Chat Agent"
Cohesion: 0.14
Nodes (10): buildQuickPrompts(), ChatAgent(), addCustomCategory(), getCustomCategories(), removeCustomCategory(), upsertCustomCategory(), fetchDetail(), getEffectiveSheetMap() (+2 more)

### Community 5 - "Social & Doc Icons"
Cohesion: 0.26
Nodes (15): Documentation, Social Media, Bluesky Icon, Discord Icon, Documentation Icon, GitHub Icon, Social / User Profile Icon, icons.svg SVG Sprite Sheet (+7 more)

### Community 6 - "Reconciliation UI"
Cohesion: 0.19
Nodes (6): CreditRow(), CrossMonthRow(), formatDate(), NewRow(), ReconcileDialog(), TransferRow()

### Community 7 - "App Icon Design System"
Cohesion: 0.29
Nodes (13): Dark Indigo Dot Color, Indigo Blue Background Color, Light Periwinkle Accent Color, White Card Color, Flat Design Style, App Icon 512px, PWA App Icon Purpose, Square Indigo Background (+5 more)

### Community 8 - "CSV Bank Parsing"
Cohesion: 0.26
Nodes (8): detectBank(), isTransfer(), parseAmex(), parseChase(), parseCSVText(), parseGeneric(), parseStatementFile(), resolveType()

### Community 10 - "Favicon & Brand Colors"
Cohesion: 0.5
Nodes (9): Alpha Mask Layer, Cyan Accent Color (#47bfff), Lavender Highlight Color (#ede6ff), Primary Purple Color (#863bff / #7e14ff), Display P3 Wide Color Gamut, Gaussian Blur Glow Effect, Lightning Bolt / Flash Icon Shape, Dashboard Favicon SVG (+1 more)

### Community 11 - "Auth & PIN Security"
Cohesion: 0.36
Nodes (6): b64decode(), b64encode(), biometricAvailable(), PinLockScreen(), registerBiometric(), verifyBiometric()

### Community 12 - "User Settings"
Cohesion: 0.61
Nodes (7): ensureSettingsSheet(), fetchRows(), loadUserSettings(), saveUserSettings(), sheetsGet(), sheetsPost(), sheetsPut()

### Community 13 - "Marketing & Branding"
Cohesion: 0.32
Nodes (8): Branding / Hero Section Graphic, Card-Based UI Concept, Dashboard Application, Hero Marketing Image, Isometric 3D Illustration, Layered Card Motif, Purple/Violet Gradient Color Scheme, Transparent Outline Top Layer

### Community 14 - "Vendor Detail Panel"
Cohesion: 0.48
Nodes (6): DetailPanel(), getCustomVendorDomains(), resolveVendorDomain(), setCustomVendorDomain(), vendorDomain(), VendorLogo()

### Community 15 - "Wallet Icon Identity"
Cohesion: 0.43
Nodes (7): Indigo Brand Color #4f46e5, Finance / Budget Application, App Icon (SVG), Coin Slot Element, Indigo Rounded Background, Money / Card Lines, Wallet Shape

### Community 17 - "PWA Icon Design"
Cohesion: 0.67
Nodes (6): PWA App Design Style, App Icon 192px, Icon Background Color, White Card / Envelope Shape, Purple Flower / Asterisk Accent, Decorative Text Lines

### Community 18 - "Reconciliation Backend"
Cohesion: 0.5
Nodes (5): Bank Reconciliation Feature, PDF Support for Reconciliation, Netlify Function (Anthropic API Proxy), Reconciliation Log, Statement Reconciliation (In Progress)

### Community 19 - "Icon Generation Script"
Cohesion: 0.83
Nodes (3): chunk(), crc32(), createPNG()

### Community 20 - "App Entry & PWA"
Cohesion: 0.5
Nodes (4): Budget Tracker App, src/main.jsx Entry Point, iOS PWA / Progressive Web App, React + Vite Stack

## Ambiguous Edges - Review These
- `Dashboard Favicon SVG` → `Lightning Bolt / Flash Icon Shape`  [AMBIGUOUS]
  public/favicon.svg · relation: symbolizes_performance_or_energy

## Knowledge Gaps
- **29 isolated node(s):** `src/main.jsx Entry Point`, `iOS PWA / Progressive Web App`, `React + Vite Stack`, `src/SettingsPanel.jsx`, `vite.config.js` (+24 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **7 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What is the exact relationship between `Dashboard Favicon SVG` and `Lightning Bolt / Flash Icon Shape`?**
  _Edge tagged AMBIGUOUS (relation: symbolizes_performance_or_energy) - confidence is low._
- **Why does `fetchDetailRows()` connect `Expense Entry & Sheets Sync` to `App Shell & Navigation`, `Transaction History & Ledger`, `Reconciliation UI`?**
  _High betweenness centrality (0.048) - this node is a cross-community bridge._
- **Why does `addOrUpdateExpense()` connect `Expense Entry & Sheets Sync` to `App Shell & Navigation`, `Transaction History & Ledger`, `AI Chat Agent`, `Reconciliation UI`?**
  _High betweenness centrality (0.038) - this node is a cross-community bridge._
- **Why does `parseStatementFile()` connect `CSV Bank Parsing` to `Reconciliation UI`?**
  _High betweenness centrality (0.037) - this node is a cross-community bridge._
- **What connects `src/main.jsx Entry Point`, `iOS PWA / Progressive Web App`, `React + Vite Stack` to the rest of the system?**
  _29 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `App Shell & Navigation` be split into smaller, more focused modules?**
  _Cohesion score 0.06 - nodes in this community are weakly interconnected._
- **Should `Expense Entry & Sheets Sync` be split into smaller, more focused modules?**
  _Cohesion score 0.14 - nodes in this community are weakly interconnected._