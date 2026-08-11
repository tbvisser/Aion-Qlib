import { test, expect } from '@playwright/test'

const THREAD_ID = '00000000-0000-0000-0000-0000000005b2'

test.describe('Welcome composer mode carry-over', () => {
  test('sends the first new-thread message with Deep Mode enabled', async ({ page }) => {
    const now = new Date().toISOString()
    const thread = {
      id: THREAD_ID,
      user_id: 'test-user',
      title: 'New deep chat',
      created_at: now,
      updated_at: now,
    }
    let postBody: Record<string, unknown> | null = null

    await page.route('**/threads?*', route => route.fulfill({
      json: {
        threads: [],
        total_count: 0,
        has_more: false,
      },
    }))
    await page.route('**/settings/public', route => route.fulfill({ json: { context_window: 200000 } }))
    await page.route('**/threads', route => route.fulfill({ json: thread }))
    await page.route(`**/threads/${THREAD_ID}/todos`, route => route.fulfill({ json: [] }))
    await page.route(`**/threads/${THREAD_ID}/files`, route => route.fulfill({ json: [] }))
    await page.route(`**/threads/${THREAD_ID}/harness`, route => route.fulfill({ json: null }))
    await page.route(`**/threads/${THREAD_ID}/compactions`, route => route.fulfill({ json: [] }))
    await page.route(`**/threads/${THREAD_ID}/messages`, route => {
      if (route.request().method() === 'POST') {
        postBody = JSON.parse(route.request().postData() || '{}')
        return route.fulfill({
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
          body:
            'data: {"type":"text_delta","content":"ok"}\n\n' +
            'event: done\ndata: {}\n\n',
        })
      }
      return route.fulfill({ json: [] })
    })

    await page.goto('/')
    await page.getByRole('button', { name: /new chat/i }).click()
    await page.getByRole('button', { name: 'Add to chat' }).first().click()
    await page.getByRole('menuitem', { name: /deep mode/i }).click()
    await expect(page.getByRole('button', { name: 'Turn off Deep Mode' })).toBeVisible()

    const input = page.getByPlaceholder(/ask anything/i)
    await input.fill('carry this into deep mode')
    await input.press('Enter')

    await expect.poll(() => postBody, { timeout: 15_000 }).not.toBeNull()
    expect(postBody!.deep_mode).toBe(true)
    expect(postBody!.harness_mode).toBeNull()
  })
})
