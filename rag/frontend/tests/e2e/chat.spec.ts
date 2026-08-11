import { test, expect } from '@playwright/test'

test.describe('Chat flow', () => {
  test('can create a new thread', async ({ page }) => {
    await page.goto('/')

    // Find and click new chat / new thread button
    const newChatBtn = page.getByRole('button', { name: /new chat/i })
    await newChatBtn.click()
    await page.waitForTimeout(1000)

    // Message input should be visible and empty
    await expect(page.getByPlaceholder(/ask anything/i)).toBeVisible()
  })

  test('can send a message and see it appear', async ({ page }) => {
    await page.goto('/')

    // Create new thread
    await page.getByRole('button', { name: /new chat/i }).click()
    await page.waitForTimeout(1000)

    // Send a message
    const input = page.getByPlaceholder(/ask anything/i)
    await input.fill('What is 2+2?')
    await input.press('Enter')

    // Verify the user message appears in the chat (use paragraph to avoid matching sidebar thread title)
    await expect(page.getByRole('paragraph').filter({ hasText: 'What is 2+2?' })).toBeVisible({ timeout: 5_000 })

    // Wait for an assistant response (prose block appears)
    await expect(
      page.locator('.prose').first()
    ).toBeVisible({ timeout: 60_000 })
  })

  test('can navigate to documents page', async ({ page }) => {
    await page.goto('/')

    // Click Docs nav link
    await page.getByTestId('sidebar-nav-documents').click()
    await expect(page).toHaveURL(/\/documents/)
  })
})
