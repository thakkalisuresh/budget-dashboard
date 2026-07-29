import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { readFileSync } from 'fs'
import { execSync } from 'child_process'

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'))

// GitHub Actions sets GITHUB_SHA (full 40-char) on every CI build; slice to 7.
// Fall back to local git for dev builds.
let commitSha = 'dev'
try {
  commitSha = process.env.GITHUB_SHA?.slice(0, 7)
    || execSync('git rev-parse --short HEAD', { stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim()
} catch { /* non-git environment */ }

export default defineConfig({
  // Dev-only: `vite dev` doesn't know about Firebase Hosting's /api/* rewrites,
  // so forward them to the deployed Cloud Functions. The claude proxy already
  // allowlists http://localhost:5173 (see functions/lib/http-common.mjs), and
  // the browser sends its Google access token + sec-fetch-site: same-origin, so
  // real scans work from localhost. No effect on `vite build` / production.
  server: {
    proxy: {
      '/api': {
        target: 'https://fundient-dashboard.web.app',
        changeOrigin: true,
        secure: true,
      },
    },
  },
  test: {
    globals: true,
    environment: 'node',
    // The endpoint-handler tests import the Cloud Functions (functions/*.mjs),
    // whose firebase-functions deps aren't installed in the root test env. Alias
    // the two subpaths they touch to lightweight stubs so the handler logic can
    // be tested without the functions runtime. See test-stubs/.
    alias: {
      'firebase-functions/v2/https': new URL('./test-stubs/firebase-functions-https.mjs', import.meta.url).pathname,
      'firebase-functions/params':   new URL('./test-stubs/firebase-functions-params.mjs', import.meta.url).pathname,
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __COMMIT_SHA__:  JSON.stringify(commitSha),
    __BUILD_TIME__:  JSON.stringify(new Date().toISOString()),
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.js',
      includeAssets: ['favicon.svg', 'icons/*.png'],
      manifest: {
        name: 'Budget Tracker',
        short_name: 'Budget',
        description: 'Personal budget dashboard',
        theme_color: '#e07c00',
        background_color: '#0f172a',
        display: 'standalone',
        orientation: 'portrait',
        scope: '/',
        start_url: '/',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico}'],
        // Exclude heavy, rarely-used lazy chunks from the upfront precache —
        // they're served via a CacheFirst runtime route in sw.js instead
        // (filenames are content-hashed, so a new version gets a new URL).
        globIgnores: [
          '**/react-pdf.browser-*.js',
          '**/pdfParsers-*.js',
          '**/claudePdfParser-*.js',
          '**/SpendingMap-*.js',
          '**/SpendingMap-*.css',
        ],
      },
    }),
  ],
})
