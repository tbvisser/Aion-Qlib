import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// Per-worktree dev port: scripts/start-frontend.ps1 sets FRONTEND_PORT from
// .worktree-ports.json so parallel worktrees don't collide on 5173. Falls back
// to the canonical 5173 for the main checkout / when unset.
const frontendPort = Number(process.env.FRONTEND_PORT) || 5173

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: frontendPort,
    strictPort: true,
  },
})
