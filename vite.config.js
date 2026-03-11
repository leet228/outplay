import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api/wallets': 'http://localhost:3001',
      '/api/health': 'http://localhost:3001',
    },
  },
})
