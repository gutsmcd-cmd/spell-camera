import { readFileSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

const MANIFEST_ID = '/spell-camera/'

function assertManifestId(): Plugin {
  return {
    name: 'assert-manifest-id',
    apply: 'build',
    enforce: 'post',
    closeBundle() {
      const file = resolve('dist/manifest.webmanifest')
      const manifest = JSON.parse(readFileSync(file, 'utf8')) as { id?: string }
      if (manifest.id !== MANIFEST_ID) {
        throw new Error(`manifest id must be ${MANIFEST_ID} (never './'), got ${String(manifest.id)}`)
      }
    },
  }
}

// Copy the Tesseract worker + LSTM wasm cores from node_modules into public/tesseract at build time
// (not committed). Same-origin worker => it is controlled by the service worker and cached for offline.
function copyTesseract(): Plugin {
  return {
    name: 'copy-tesseract',
    buildStart() {
      const out = resolve('public/tesseract')
      mkdirSync(out, { recursive: true })
      copyFileSync(resolve('node_modules/tesseract.js/dist/worker.min.js'), resolve(out, 'worker.min.js'))
      const coreDirs = ['node_modules/tesseract.js/node_modules/tesseract.js-core', 'node_modules/tesseract.js-core']
      let core = ''
      for (const d of coreDirs) {
        try { readdirSync(resolve(d)); core = resolve(d); break } catch { /* next */ }
      }
      if (!core) throw new Error('tesseract.js-core not found')
      for (const f of readdirSync(core)) if (/-lstm\.wasm\.js$/.test(f)) copyFileSync(resolve(core, f), resolve(out, f))
    },
  }
}

export default defineConfig({
  base: './',
  build: { chunkSizeWarningLimit: 2000 },
  plugins: [
    copyTesseract(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/icon-32.png', 'icons/icon-180.png'],
      manifest: {
        id: MANIFEST_ID,
        name: 'スペルチェックカメラ',
        short_name: 'スペルチェック',
        description: '看板やメニューの英語のミスを見つける。Spot English spelling mistakes on signs and menus.',
        lang: 'ja',
        dir: 'ltr',
        start_url: './',
        scope: './',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#13202b',
        theme_color: '#13202b',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
        globIgnores: ['tesseract/**'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            // OCR worker/core (same origin), English OCR data + spelling dictionaries (jsDelivr).
            // Fetched once on first scan, then served from cache so it works offline.
            urlPattern: ({ url }) => url.hostname === 'cdn.jsdelivr.net' || url.pathname.includes('/tesseract/'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'spell-camera-data',
              expiration: { maxEntries: 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
    assertManifestId(),
  ],
})
