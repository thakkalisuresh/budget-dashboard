# Feature: OFX / QIF / MT940 Import

## What
Extend the existing ReconcileDialog to accept QIF, OFX, and MT940 bank export files in addition to CSV and PDF. All formats feed the same reconciliation pipeline. Also serves as the US bank-sync fallback since Plaid/free auto-sync is not available for US banks.

## Target phases for this branch
- **Phase 1** — QIF parser (`D`=date, `T`=amount, `P`=payee, `^`=end-of-record)
- **Phase 2** — OFX parser (SGML 1.x + XML 2.x via browser `DOMParser`; extracts `<STMTTRN>` blocks)
- **Phase 3** — MT940 parser (SWIFT fixed format; `:61:` = transaction, `:86:` = description); auto-detect format from file extension

## Files to create
- `src/qifParser.js` — `parseQIF(text): Transaction[]`
- `src/ofxParser.js` — `parseOFX(text): Transaction[]` (Phase 2)
- `src/mt940Parser.js` — `parseMT940(text): Transaction[]` (Phase 3)

## Files to modify
- `src/ReconcileDialog.jsx` — extend `accept` attribute; dispatch to correct parser by file extension

## Dependencies
None — all parsing is client-side using browser built-ins.

## Branch
`feat/qif-import` → merge to `main` after Phase 3 is verified.
