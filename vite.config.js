import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    // @ton/core (used by @tonconnect/ui-react for cell building)
    // references Node's `Buffer` global at module-eval time.
    // Without this polyfill the static import throws
    // `ReferenceError: Buffer is not defined` and blanks the
    // entire app on load. We only polyfill Buffer + global —
    // skip `process` to keep the bundle slim, since nothing
    // else in our code path needs it.
    nodePolyfills({
      include: ['buffer'],
      globals: { Buffer: true, global: true, process: false },
    }),
  ],
  server: {
    proxy: {
      '/api/wallets': 'http://localhost:3001',
      '/api/health': 'http://localhost:3001',
    },
  },
})
