import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', 'functions/node_modules']),

  // ── Warehouse chokepoint ─────────────────────────────────────────────────
  // Every expense reaches a spreadsheet through exactly two functions —
  // `addOrUpdateExpense` in src/sheetExpenses.js (browser) and `appendExpense`
  // in functions/lib/_sheets.mjs (backend) — and both are hooked, so a new
  // feature inherits warehouse recording for free.
  //
  // A feature that talks to sheets.googleapis.com directly bypasses both. The
  // reconciler catches it on the next pass, so nothing is lost permanently, but
  // it arrives late and mislabelled as `missed_notify`. This rule is the cheap
  // first line: mechanical, and it fires while the code is being written rather
  // than fifteen minutes later in a log.
  //
  // Four files may name the host, and each earns it:
  //   src/sheetApi.js                      the browser chokepoint
  //   functions/lib/_sheets.mjs            the backend chokepoint
  //   functions/lib/_warehouse-reader.mjs  READ-only, and it is the reconciler
  //                                        itself — it cannot archive its own
  //                                        reads and has nothing to bypass
  //   src/sw.js                            a service-worker cache route, not a
  //                                        request
  {
    files: ['src/**/*.{js,jsx}', 'functions/**/*.{js,mjs}'],
    ignores: [
      'src/sheetApi.js',
      'functions/lib/_sheets.mjs',
      'functions/lib/_warehouse-reader.mjs',
      'src/sw.js',
      'src/__tests__/**',
    ],
    rules: {
      'no-restricted-syntax': ['error', {
        selector: "Literal[value=/sheets\\.googleapis\\.com/]",
        message:
          'Talk to Sheets through src/sheetApi.js or functions/lib/_sheets.mjs. ' +
          'Those are the two chokepoints where warehouse recording is wired in; ' +
          'a direct call is archived late and mislabelled as missed_notify.',
      }],
    },
  },

  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: {
        ...globals.browser,
        // Build-time constants substituted by Vite's `define` (see vite.config.js).
        // Readonly here so eslint stops reporting them as undefined in the files
        // that display the version and in the update check that compares it.
        __APP_VERSION__: 'readonly',
        __COMMIT_SHA__:  'readonly',
        __BUILD_TIME__:  'readonly',
      },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },
])
