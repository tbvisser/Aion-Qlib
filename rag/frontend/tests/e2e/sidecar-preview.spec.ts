import { test, expect } from '@playwright/test'

test.describe('Sidecar Preview state machine', () => {
  test('clicking a workspace file opens preview, X returns to list, Esc returns to list', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: /new chat/i }).click()
    await page.waitForURL(/\/chat\/.+/, { timeout: 15_000 })

    const input = page.getByPlaceholder(/ask anything/i)
    await expect(input).toBeVisible({ timeout: 10_000 })

    // Enable deep mode so a file gets created
    await page.getByRole('button', { name: 'Select Mode' }).click()
    await page.getByRole('button', { name: 'Deep Mode' }).click()
    await expect(page.getByRole('button', { name: 'Deep Mode' })).toHaveClass(/bg-amber-500/, { timeout: 5_000 })

    await input.fill('Write a one-line markdown file called notes.md with the text "hello"')
    await input.press('Enter')

    // Wait for file to appear in the sidecar
    const sidebar = page.getByTestId('sidecar-column')
    await expect(sidebar).toBeVisible({ timeout: 90_000 })
    await expect(sidebar).toHaveAttribute('data-mode', 'list')

    const fileRow = page.locator('[data-testid^="workspace-file-"]').first()
    await expect(fileRow).toBeVisible({ timeout: 90_000 })

    // Click file → preview mode
    await fileRow.click()
    await expect(sidebar).toHaveAttribute('data-mode', 'preview')
    await expect(page.getByTestId('sidecar-preview-header')).toBeVisible()

    // Wait for width transition to settle, then verify ~50vw (allow ±5% slop)
    await expect.poll(
      async () => sidebar.evaluate(el => el.getBoundingClientRect().width / window.innerWidth),
      { timeout: 3000 }
    ).toBeGreaterThan(0.45)
    const widthRatio = await sidebar.evaluate(el => el.getBoundingClientRect().width / window.innerWidth)
    expect(widthRatio).toBeLessThan(0.55)

    // Click X → list mode
    await page.getByTestId('sidecar-close').click()
    await expect(sidebar).toHaveAttribute('data-mode', 'list')

    // Re-open + Esc → list mode
    await fileRow.click()
    await expect(sidebar).toHaveAttribute('data-mode', 'preview')
    await page.keyboard.press('Escape')
    await expect(sidebar).toHaveAttribute('data-mode', 'list')
  })

  test('markdown preview keeps Preview/Source tabs and selectable source', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: /new chat/i }).click()
    await page.waitForURL(/\/chat\/.+/, { timeout: 15_000 })

    const input = page.getByPlaceholder(/ask anything/i)
    await expect(input).toBeVisible({ timeout: 10_000 })

    await page.getByRole('button', { name: 'Select Mode' }).click()
    await page.getByRole('button', { name: 'Deep Mode' }).click()
    await input.fill('Write a markdown file called notes.md with a heading "Hi" and a paragraph')
    await input.press('Enter')

    const sidebar = page.getByTestId('sidecar-column')
    await expect(sidebar).toBeVisible({ timeout: 90_000 })

    const fileRow = page.locator('[data-testid^="workspace-file-"]').first()
    await expect(fileRow).toBeVisible({ timeout: 90_000 })
    await fileRow.click()

    // Preview/Source tabs present
    await expect(page.getByRole('button', { name: 'Preview' })).toBeVisible()
    const sourceTab = page.getByRole('button', { name: 'Source' })
    await expect(sourceTab).toBeVisible()

    // Switch to Source, confirm text is selectable (user-select != 'none')
    await sourceTab.click()
    const pre = page.locator('pre').first()
    await expect(pre).toBeVisible()

    // Source tab should show the raw markdown content (heading text appears in source)
    await expect(pre).toContainText('Hi')

    // Verify selectability is not disabled anywhere up the tree by checking
    // that the effective user-select on <pre> isn't 'none'.
    const userSelect = await pre.evaluate(el => getComputedStyle(el).userSelect)
    expect(userSelect).not.toBe('none')
  })
})
