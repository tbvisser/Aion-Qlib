import { test as setup, expect } from '@playwright/test'

const USER1_EMAIL = process.env.TEST_USER1_EMAIL ?? 'test@test.com'
const USER1_PASSWORD = process.env.TEST_USER1_PASSWORD ?? ''

setup('authenticate as user 1', async ({ page }) => {
  await page.goto('/auth')
  await page.getByLabel('Email').fill(USER1_EMAIL)
  await page.getByLabel('Password').fill(USER1_PASSWORD)
  await page.getByRole('button', { name: /sign in/i }).click()

  // Wait for redirect to chat page after successful login
  await expect(page).not.toHaveURL(/\/auth/)

  // Save signed-in state for reuse across tests
  await page.context().storageState({ path: './tests/support/.auth/user1.json' })
})
