import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { readFileSync } from 'fs'
import { execSync } from 'child_process'

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'))

// Netlify sets COMMIT_REF on every deploy; fall back to local git for dev builds
let commitSha = 'dev'
try {
  commitSha = process.env.COMMIT_REF?.slice(0, 7)
    || execSync('git rev-parse --short HEAD', { stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim()
} catch { /* non-git environment */ }

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
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
