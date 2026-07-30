import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
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
