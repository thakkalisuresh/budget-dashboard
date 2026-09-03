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

// Single source of truth for the build stamp — the same value goes into the
// __BUILD_TIME__ define and into version.json, so the running bundle and the
// manifest it polls can never disagree about which build they describe.
const buildTime = new Date().toISOString()

/**
 * Emit /version.json alongside the bundle.
 *
 * This is the service-worker-independent half of update detection: installed iOS
 * PWAs and Safari can't be relied on to notice a new worker, so the app polls
 * this file and compares `commit` against its own __COMMIT_SHA__. Must be served
 * with no-cache (see firebase.json) or the poll reads a stale commit forever.
 */
function versionManifest() {
  return {
    name: 'fundient-version-manifest',
    apply: 'build',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: JSON.stringify({ version: pkg.version, commit: commitSha, buildTime }),
      })
    },
  }
}

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
      // vite-plugin-pwa's virtual module only exists during a real Vite build,
      // so anything importing useAppUpdate would fail to resolve under vitest.
      'virtual:pwa-register/react':  new URL('./test-stubs/pwa-register-react.mjs', import.meta.url).pathname,
      // Pin web-push to the root copy.
      //
      // functions/ has its own node_modules locally (Firebase installs it), so
      // functions/wallet-webhook.mjs resolved web-push to the NESTED copy while
      // the test's vi.mock('web-push') resolved the ROOT one. Different paths
      // mean the mock never intercepts, the real library runs, and it rejects
      // the test's fake VAPID key — two tests failing locally while passing in
      // CI, where `npm ci` installs only at the root so no nested copy exists
      // to diverge from. Pinning both importers to one path makes a local run
      // mean the same thing as a CI run.
      'web-push': new URL('./node_modules/web-push/src/index.js', import.meta.url).pathname,
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __COMMIT_SHA__:  JSON.stringify(commitSha),
    __BUILD_TIME__:  JSON.stringify(buildTime),
  },
  plugins: [
    react(),
    tailwindcss(),
    versionManifest(),
    VitePWA({
      // 'prompt', not 'autoUpdate'. Under strategies:'injectManifest' the plugin
      // injects only the precache manifest into our custom sw.js — it does NOT
      // inject the skipWaiting/clientsClaim lifecycle it generates under
      // generateSW. So 'autoUpdate' was inert: new workers installed, sat in
      // `waiting` forever, and every deploy needed a manual cache clear.
      // 'prompt' + useRegisterSW (see useAppUpdate.js) sends the SKIP_WAITING
      // message sw.js has always been listening for.
      registerType: 'prompt',
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.js',
      includeAssets: ['favicon.svg', 'icons/*.png'],
      manifest: {
        name: 'Budget Tracker',
        short_name: 'Budget',
        description: 'Personal budget dashboard',
        theme_color: '#0d0d0d',
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
