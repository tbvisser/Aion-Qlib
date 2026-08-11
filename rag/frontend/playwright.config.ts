import { defineConfig, devices } from '@playwright/test'

// Load the shared backend/.env (gitignored) so E2E uses the same TEST_USER*
// credentials as the pytest suite — no secrets hardcoded in test source. Run
// Playwright from the frontend/ directory. Node 20.12+/24 provides loadEnvFile;
// the optional call + try/catch make a missing file a harmless no-op.
try {
  ;(process as unknown as { loadEnvFile?: (path: string) => void }).loadEnvFile?.('../backend/.env')
} catch {
  // backend/.env is optional for E2E
}

export default defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },

  reporter: process.env.CI
    ? [
        ['html', { outputFolder: 'playwright-report', open: 'never' }],
        ['junit', { outputFile: 'test-results/results.xml' }],
        ['list'],
      ]
    : [['list']],

  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:5173',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    // 1. Auth setup — runs first, saves storage state
    {
      name: 'auth-setup',
      testMatch: /auth\.setup\.ts/,
    },

    // 2. Data cleanup — runs after auth, wipes stale test data
    {
      name: 'cleanup',
      testMatch: /cleanup\.setup\.ts/,
      dependencies: ['auth-setup'],
    },

    // 3. Authenticated E2E tests — depend on both auth + cleanup
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        storageState: './tests/support/.auth/user1.json',
      },
      dependencies: ['cleanup'],
      testMatch: /.*\.spec\.ts/,
      testIgnore: /.*unauthenticated.*\.spec\.ts/,
    },

    // Unauthenticated tests (auth page, redirects)
    {
      name: 'unauthenticated',
      use: { ...devices['Desktop Chrome'] },
      testMatch: /.*unauthenticated.*\.spec\.ts/,
    },
  ],
})
