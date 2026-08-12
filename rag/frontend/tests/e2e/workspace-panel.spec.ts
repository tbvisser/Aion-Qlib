import { test, expect } from '@playwright/test'

test.describe('Workspace Panel', () => {
  test('workspace panel is hidden on thread with no files', async ({ page }) => {
    await page.goto('/')

    // Open the welcome screen (New Chat defers thread creation until the first send)
    await page.getByRole('button', { name: /new chat/i }).click()

    const input = page.getByPlaceholder(/ask anything/i)
    await expect(input).toBeVisible({ timeout: 10_000 })

    // Send a regular message (no deep mode, no file creation) — this creates the thread
    await input.fill('Hello, how are you?')
    await input.press('Enter')

    // Wait for navigation into the newly created thread
    await page.waitForURL(/\/chat\/.+/, { timeout: 15_000 })

    // Wait for assistant response
    await expect(page.locator('.prose').first()).toBeVisible({ timeout: 60_000 })

    // The WorkspacePanel header should NOT be visible (look for "Files" inside the sidebar area)
    const sidebar = page.getByTestId('sidecar-column')
    await expect(sidebar.getByText('Files')).not.toBeVisible()
  })

  test('workspace panel appears when deep mode creates files', async ({ page }) => {
    await page.goto('/')

    // Open the welcome screen
    await page.getByRole('button', { name: /new chat/i }).click()

    const input = page.getByPlaceholder(/ask anything/i)
    await expect(input).toBeVisible({ timeout: 10_000 })

    // Turn deep mode ON via the composer "+" menu, then confirm the active-mode chip.
    // The chosen mode carries into the new thread when the first message is sent.
    await page.getByRole('button', { name: 'Add to chat' }).first().click()
    await page.getByRole('menuitem', { name: /deep mode/i }).click()
    await expect(page.getByRole('button', { name: 'Turn off Deep Mode' })).toBeVisible({ timeout: 5_000 })

    // Send a message that should trigger file creation in workspace
    await input.fill(
      'Write a short Python hello world script and save it as a workspace file called hello.py'
    )
    await input.press('Enter')

    // Wait for navigation into the newly created thread
    await page.waitForURL(/\/chat\/.+/, { timeout: 15_000 })

    // Wait for assistant response
    await expect(page.locator('.prose').first()).toBeVisible({ timeout: 90_000 })

    // The WorkspacePanel "Files" label should appear in the right sidebar
    // This may take time as the agent needs to create a file
    const sidebar = page.getByTestId('sidecar-column')
    await expect(sidebar.getByText('Files')).toBeVisible({ timeout: 90_000 })
  })
})
