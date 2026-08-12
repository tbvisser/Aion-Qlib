import { test, expect } from '@playwright/test'

// Fixture: this test assumes at least one completed document exists at the
// Knowledgebase root for the test user. It uploads one if there isn't one
// already, then waits for it to finish processing.
test.describe('Docs sidecar delete', () => {
  test('delete via sidecar confirm dialog removes the doc and closes the sidecar', async ({ page }) => {
    const consoleErrors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return
      const text = msg.text()
      // Opening the sidecar fires a GET /documents/{id}/render request that does
      // not abort on unmount. This test deletes the doc moments later, so that
      // in-flight request can have its DB query resolve against an already-deleted
      // row and return 404. The component swallows the rejection via .catch()
      // (renderData stays null, no broken UX), but Chromium still auto-logs the
      // network failure. Ignore these benign resource-load 404s — a real JS error
      // or a non-404 resource failure would still be caught below.
      if (/Failed to load resource: the server responded with a status of 404/.test(text)) return
      consoleErrors.push(text)
    })
    const deleteRequests: string[] = []
    page.on('request', (req) => {
      if (req.method() === 'DELETE' && req.url().includes('/documents/')) {
        deleteRequests.push(req.url())
      }
    })

    await page.goto('/documents')
    await page.waitForLoadState('networkidle')

    // Find any completed card. If none, upload one and wait.
    const completedCard = () =>
      page.locator('[data-testid^="document-card-"]', { has: page.getByLabel('Completed') }).first()

    if (!(await completedCard().isVisible().catch(() => false))) {
      await page.getByRole('button', { name: /add files/i }).click()
      const filename = `sidecar-delete-${Date.now()}.md`
      await page.locator('input[type="file"]').setInputFiles({
        name: filename,
        mimeType: 'text/markdown',
        buffer: Buffer.from('# delete me\n\nfixture'),
      })

      // Poll: reload until a completed card exists.
      let ok = false
      for (let i = 0; i < 60 && !ok; i++) {
        await page.waitForTimeout(1000)
        await page.goto('/documents')
        await page.waitForLoadState('networkidle')
        if (await completedCard().isVisible().catch(() => false)) {
          ok = true
        }
      }
      expect(ok, 'no completed doc available to delete').toBe(true)
    }

    const target = completedCard()
    const targetId = await target.getAttribute('data-testid')

    // Open the sidecar.
    await target.click()
    await expect(page.getByTestId('docs-sidecar')).toBeVisible()

    // Click trash icon in sidecar header.
    await page.getByTestId('docs-sidecar-delete').click()

    // Confirm dialog appears.
    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('Delete document?')).toBeVisible()

    // Click Delete inside the dialog.
    await dialog.getByRole('button', { name: 'Delete' }).click()

    // DELETE request should fire.
    await expect
      .poll(() => deleteRequests.length, { timeout: 10_000, message: 'no DELETE request was made' })
      .toBeGreaterThan(0)

    // Sidecar disappears, the specific card disappears.
    await expect(page.getByTestId('docs-sidecar')).not.toBeVisible({ timeout: 10_000 })
    if (targetId) {
      await expect(page.locator(`[data-testid="${targetId}"]`)).not.toBeVisible({ timeout: 10_000 })
    }

    expect(consoleErrors, `console errors: ${consoleErrors.join('\n')}`).toEqual([])
  })
})
