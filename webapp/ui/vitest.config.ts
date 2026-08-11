import { defineConfig } from 'vitest/config'
import path from 'path'

// Separate from vite.config.ts on purpose: the dev server's proxy and strict
// port would make a test run fight whatever is already listening.
//
// No jsdom and no testing-library. What is tested here is the parser, the
// serialiser and the layout -- all pure, all headless. Anything that needs a
// browser belongs in the Playwright suite, where an assertion costs seconds
// rather than milliseconds.
export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
