import { test, expect, type Page } from '@playwright/test'

// Deep Mode now lives inside the composer "+" menu. Opening the menu and
// selecting "Deep Mode" surfaces an active-mode chip with a "Turn off Deep
// Mode" clear button, which is the canonical ON indicator.
async function openComposerMenu(page: Page) {
  await page.getByRole('button', { name: 'Add to chat' }).first().click()
}

async function enableDeepMode(page: Page) {
  await openComposerMenu(page)
  await page.getByRole('menuitem', { name: /deep mode/i }).click()
  await expect(page.getByRole('button', { name: 'Turn off Deep Mode' })).toBeVisible()
}

test.describe('Deep Mode', () => {
  // --- P1: Deep Mode in the composer "+" menu ---

  test('deep mode is available in the composer menu', async ({ page }) => {
    await page.goto('/')

    // Create a new thread
    await page.getByRole('button', { name: /new chat/i }).click()
    await page.waitForTimeout(1000)

    // The "+" menu should expose a Deep Mode item
    await openComposerMenu(page)
    await expect(page.getByRole('menuitem', { name: /deep mode/i })).toBeVisible()
  })

  test('deep mode defaults to OFF', async ({ page }) => {
    await page.goto('/')

    await page.getByRole('button', { name: /new chat/i }).click()
    await page.waitForTimeout(1000)

    // No active-mode chip should be present when nothing is selected
    await expect(page.getByRole('button', { name: 'Turn off Deep Mode' })).not.toBeVisible()
  })

  test('deep mode can be turned ON and OFF', async ({ page }) => {
    await page.goto('/')

    await page.getByRole('button', { name: /new chat/i }).click()
    await page.waitForTimeout(1000)

    // Turn ON via the menu — the active-mode chip appears
    await enableDeepMode(page)

    // Turn OFF via the chip's clear button — the chip disappears
    await page.getByRole('button', { name: 'Turn off Deep Mode' }).click()
    await expect(page.getByRole('button', { name: 'Turn off Deep Mode' })).not.toBeVisible()
  })

  // --- P1: Deep Mode Message Flow ---

  test('can send a deep mode message', async ({ page }) => {
    await page.goto('/')

    // Create a new thread
    await page.getByRole('button', { name: /new chat/i }).click()
    await page.waitForTimeout(1000)

    // Turn deep mode ON
    await enableDeepMode(page)

    // Type and send a message
    const input = page.getByPlaceholder(/ask anything/i)
    await input.fill('What is the capital of France?')
    await input.press('Enter')

    // Verify user message appears
    await expect(
      page.getByRole('paragraph').filter({ hasText: 'What is the capital of France?' })
    ).toBeVisible({ timeout: 5_000 })

    // Wait for an assistant response (prose block)
    await expect(page.locator('.prose').first()).toBeVisible({ timeout: 60_000 })
  })

  // --- P1: PlanPanel ---

  test('plan panel is hidden on regular thread', async ({ page }) => {
    await page.goto('/')

    // Create a new thread
    await page.getByRole('button', { name: /new chat/i }).click()
    await page.waitForTimeout(1000)

    // Send a regular message (deep mode OFF)
    const input = page.getByPlaceholder(/ask anything/i)
    await input.fill('Hello, how are you?')
    await input.press('Enter')

    // Wait for assistant response
    await expect(page.locator('.prose').first()).toBeVisible({ timeout: 60_000 })

    // The Plan panel header should NOT be visible
    await expect(page.getByText('No plan yet')).not.toBeVisible()
  })

  test('plan panel loads on thread with deep mode history', async ({ page }) => {
    await page.goto('/')

    // Create a new thread
    await page.getByRole('button', { name: /new chat/i }).click()
    await page.waitForTimeout(1000)

    // Turn deep mode ON
    await enableDeepMode(page)

    // Send a message that should trigger write_todos
    const input = page.getByPlaceholder(/ask anything/i)
    await input.fill(
      'Create a step-by-step plan to organize a birthday party. Start with a todo list.'
    )
    await input.press('Enter')

    // Wait for assistant response
    await expect(page.locator('.prose').first()).toBeVisible({ timeout: 60_000 })

    // The Plan panel should appear with "Plan" header text
    await expect(page.getByText('Plan').first()).toBeVisible({ timeout: 60_000 })

    // Verify at least one todo item appears (the panel should no longer show "No plan yet")
    // Wait for todo items to load — they appear as list items inside the plan panel
    await expect(
      page.locator('[class*="space-y-1"] > div').first()
    ).toBeVisible({ timeout: 60_000 })
  })

  // --- P2: Plan Panel Status Icons ---

  test('plan panel shows todo items with status indicators', async ({ page }) => {
    await page.goto('/')

    // Create a new thread
    await page.getByRole('button', { name: /new chat/i }).click()
    await page.waitForTimeout(1000)

    // Turn deep mode ON
    await enableDeepMode(page)

    // Send a message that should trigger write_todos
    const input = page.getByPlaceholder(/ask anything/i)
    await input.fill(
      'Create a step-by-step plan to organize a birthday party. Start with a todo list.'
    )
    await input.press('Enter')

    // Wait for assistant response
    await expect(page.locator('.prose').first()).toBeVisible({ timeout: 60_000 })

    // Wait for todo items to render in the plan panel
    const todoItems = page.locator('[class*="space-y-1"] > div')
    await expect(todoItems.first()).toBeVisible({ timeout: 60_000 })

    // Each todo item should have an SVG status icon (Circle, Loader2, or CheckCircle2)
    const firstTodoIcon = todoItems.first().locator('svg').first()
    await expect(firstTodoIcon).toBeVisible()

    // Verify todo text content is present (not empty)
    const firstTodoText = todoItems.first().locator('span')
    await expect(firstTodoText).not.toBeEmpty()
  })
})
