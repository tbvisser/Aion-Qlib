/**
 * Playwright setup step: wipe all test data before E2E tests run.
 * Depends on auth.setup.ts having run first (needs stored JWT).
 */

import { test as setup } from '@playwright/test'
import { cleanupTestData } from './cleanup'

setup('clean up test data', async () => {
  await cleanupTestData()
})
