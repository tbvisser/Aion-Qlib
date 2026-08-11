import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// 5274 rather than Vite's default: 5173 and 5273 were already taken by other
// node processes on this machine.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  server: {
    host: '127.0.0.1',
    port: 5274,
    strictPort: true,
    // Same-origin /api in dev, so the app never needs to know the API's port
    // and CORS stays irrelevant. In the compose stack the API is reachable by
    // service name instead of on localhost, hence the override.
    proxy: {
      '/api': {
        target: process.env.VITE_API_PROXY || 'http://127.0.0.1:8770',
        changeOrigin: true,
      },
    },
  },
})
