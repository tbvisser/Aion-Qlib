import { test, expect } from '@playwright/test'

/**
 * Compaction marker E2E.
 *
 * The trigger test requires backend env overrides
 * (COMPACTION_TRIGGER_RATIO low or LLM_CONTEXT_WINDOW small) so a handful of
 * short messages can cross the threshold. Without those overrides this test
 * would have to send dozens of long messages, so it's skipped by default.
 *
 * Enable by setting `RUN_COMPACTION_E2E=1` after configuring the backend env
 * per the manual-smoke recipe in `.agent/plans` -> compaction plan -> Level 4.
 */
const compactionEnabled = !!process.env.RUN_COMPACTION_E2E

test.describe('Compaction marker', () => {
  test.skip(!compactionEnabled, 'RUN_COMPACTION_E2E not set — requires low-threshold backend env')

  test('marker appears after enough short messages to cross threshold', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: /new chat/i }).click()
    await page.waitForTimeout(1000)

    const input = page.getByPlaceholder(/ask anything/i)
    for (let i = 0; i < 6; i++) {
      await input.fill(`Test compaction message number ${i}`)
      await input.press('Enter')
      // Wait until *some* prose response is rendered for this turn before sending the next.
      await expect(page.locator('.prose').nth(i)).toBeVisible({ timeout: 60_000 })
    }

    // The CompactionMarker renders the literal phrase "Conversation compacted".
    await expect(
      page.getByText(/conversation compacted/i)
    ).toBeVisible({ timeout: 15_000 })
  })

  test('marker is expandable and reveals the summary', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: /new chat/i }).click()
    await page.waitForTimeout(1000)

    const input = page.getByPlaceholder(/ask anything/i)
    for (let i = 0; i < 6; i++) {
      await input.fill(`Test summary expansion ${i}`)
      await input.press('Enter')
      await expect(page.locator('.prose').nth(i)).toBeVisible({ timeout: 60_000 })
    }

    const marker = page.getByText(/conversation compacted/i)
    await expect(marker).toBeVisible({ timeout: 15_000 })
    await marker.click()
    // After expanding the collapsed card the inner <pre> body becomes visible.
    await expect(page.locator('pre').first()).toBeVisible({ timeout: 3_000 })
  })
})
