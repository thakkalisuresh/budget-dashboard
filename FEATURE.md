# Feature: Geo-tagging Transactions

## What
Optionally capture GPS location when adding an expense. Store coordinates in transactionNotes. View spending hotspots on a Leaflet map powered by OpenStreetMap (no API key needed).

## Target phases for this branch
- **Phase 1** — "📍 Tag location" toggle in AddExpenseDialog; `navigator.geolocation.getCurrentPosition`; store `{lat, lng}` in `transactionNotes[uuid].location`; privacy blur enabled by default (nearest ~500m)
- **Phase 2** — `SpendingMap.jsx`: Leaflet map with clustered markers; popup shows vendor + amount + date; collapsible section in Dashboard behind `settings.visibility.map`
- **Phase 3** — Heatmap density mode (leaflet.heat); category filter on map; auto "favorite spots" (3+ transactions at same location)

## Files to create
- `src/SpendingMap.jsx` — Leaflet map component (Phase 2)

## Files to modify
- `src/AddExpenseDialog.jsx` — location toggle + geolocation capture
- `src/useSettings.js` — add `geoTagEnabled: false`, `geoPrivacyBlur: true`, `visibility.map: true` to `DEFAULT_SETTINGS`
- `src/SettingsPanel.jsx` — geo opt-in toggle + privacy blur toggle
- `netlify.toml` — add `tile.openstreetmap.org` to `img-src` CSP (Phase 2)

## Dependencies
- `leaflet` + `react-leaflet` (Phase 2)

## Branch
`feat/geo-tagging` → merge to `main` after Phase 2 is verified.
