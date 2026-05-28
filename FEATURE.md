# Feature: URI / Apple Shortcuts Automation

## What
Deep-link into Fundient from any URL launcher — Apple Shortcuts, Android Tasker, bookmarklets, IFTTT. Parse `?action=` query params on app mount and open the relevant dialog or view pre-filled.

## Target phases for this branch
- **Phase 1** — URL action scheme: `?action=add&vendor=X&amount=Y&category=Z`, `?action=chat&q=...`, `?action=summary`
- **Phase 2** — Automation guide section in SettingsPanel with copy-paste Shortcut/Tasker templates

## Files to create
- `src/AutomationGuide.jsx` — Settings section with templates and interactive URL tester (Phase 2)

## Files to modify
- `src/App.jsx` — mount `useEffect` to parse `window.location.search`; pre-fill state and open dialogs; clean URL with `history.replaceState`

## Dependencies
None — no new npm packages.

## Branch
`feat/uri-automation` → merge to `main` after Phase 2 is verified.
