import { expect, test } from '@playwright/test'

const THREAD_ID = '00000000-0000-0000-0000-000000000d31'

test.describe('Thread delete confirmation', () => {
  test('asks before deleting and confirms with Enter', async ({ page }) => {
    const now = new Date().toISOString()
    const thread = {
      id: THREAD_ID,
      user_id: 'test-user',
      title: 'Thread to delete',
      created_at: now,
      updated_at: now,
    }
    let deleteRequests = 0

    await page.route('**/threads?*', route => route.fulfill({
      json: {
        threads: [thread],
        total_count: 1,
        has_more: false,
      },
    }))
    await page.route(`**/threads/${THREAD_ID}`, route => {
      if (route.request().method() === 'DELETE') {
        deleteRequests += 1
        return route.fulfill({ status: 204 })
      }
      return route.fulfill({ json: thread })
    })

    await page.goto('/chat')

    const row = page.locator(`a[href="/chat/${THREAD_ID}"]`)
    await expect(row).toBeVisible()
    await row.hover()
    await row.getByRole('button', { name: 'Delete thread' }).click()

    const dialog = page.getByRole('alertdialog')
    await expect(dialog.getByText('Are you sure?')).toBeVisible()
    await expect(dialog.getByText(/This will permanently delete "Thread to delete"/)).toBeVisible()
    expect(deleteRequests).toBe(0)

    await expect(dialog.getByRole('button', { name: 'Delete' })).toBeFocused()
    await page.keyboard.press('Enter')

    await expect.poll(() => deleteRequests).toBe(1)
    await expect(row).toHaveCount(0)
  })
})
