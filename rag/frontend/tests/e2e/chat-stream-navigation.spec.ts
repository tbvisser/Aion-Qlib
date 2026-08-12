import { test, expect } from '@playwright/test'

/**
 * Regression: a streaming response must survive in-app navigation.
 *
 * Before the per-thread stream store, the streamed answer lived only in
 * ChatView's React state. Switching threads re-ran the load-from-DB effect and
 * replaced it; the partial (not-yet-persisted) answer vanished on return.
 *
 * This test mocks an in-flight stream by returning a finite SSE body with text
 * deltas but NO `event: done`, so the UI stays in the "streaming" state (Stop
 * button shown). It then navigates away and back *within the SPA* (clicking the
 * sidebar, not a full reload — a reload is the documented out-of-scope case) and
 * asserts the partial answer is still there.
 */

const THREAD_A = '00000000-0000-0000-0000-0000000000a1'
const THREAD_B = '00000000-0000-0000-0000-0000000000b2'
const TITLE_A = 'Streaming story'
const TITLE_B = 'Other thread'
const PARTIAL = 'The story begins with a brave knight.'
const B_CONTENT = 'This is thread B content.'

test.describe('Streaming survives navigation', () => {
  test('partial answer is restored when returning to the thread mid-stream', async ({ page }) => {
    const now = new Date().toISOString()
    const thread = (id: string, title: string) => ({
      id, user_id: 'test-user', title, created_at: now, updated_at: now,
    })

    // --- Generic / shared endpoints (registered first; specifics win later) ---
    await page.route('**/threads?*', route => route.fulfill({
      json: {
        threads: [thread(THREAD_A, TITLE_A), thread(THREAD_B, TITLE_B)],
        total_count: 2,
        has_more: false,
      },
    }))
    await page.route('**/settings/public', route => route.fulfill({ json: { context_window: 200000 } }))

    // --- Per-thread auxiliary endpoints ---
    for (const id of [THREAD_A, THREAD_B]) {
      await page.route(`**/threads/${id}`, route => route.fulfill({ json: thread(id, id === THREAD_A ? TITLE_A : TITLE_B) }))
      await page.route(`**/threads/${id}/todos`, route => route.fulfill({ json: [] }))
      await page.route(`**/threads/${id}/files`, route => route.fulfill({ json: [] }))
      await page.route(`**/threads/${id}/harness`, route => route.fulfill({ json: null }))
      await page.route(`**/threads/${id}/compactions`, route => route.fulfill({ json: [] }))
    }

    // Thread B has a persisted assistant message of its own.
    await page.route(`**/threads/${THREAD_B}/messages`, route => route.fulfill({
      json: [{
        id: 'b-msg-1', thread_id: THREAD_B, user_id: 'test-user',
        role: 'assistant', content: B_CONTENT, created_at: now,
      }],
    }))

    // Thread A: GET returns nothing persisted yet; POST streams a partial answer
    // with no terminating `done` event, so the UI stays "streaming".
    let postCount = 0
    await page.route(`**/threads/${THREAD_A}/messages`, route => {
      if (route.request().method() === 'POST') {
        postCount += 1
        const body =
          'event: text_delta\ndata: {"content":"The story begins"}\n\n' +
          'event: text_delta\ndata: {"content":" with a brave knight."}\n\n'
        return route.fulfill({ status: 200, contentType: 'text/event-stream', body })
      }
      return route.fulfill({ json: [] })
    })

    // --- Start a stream on thread A ---
    await page.goto(`/chat/${THREAD_A}`)
    const input = page.getByPlaceholder(/ask anything/i)
    await input.fill('write a 1000 word story')
    await input.press('Enter')

    // User message + partial answer render, and we're in the streaming state.
    await expect(page.getByRole('paragraph').filter({ hasText: 'write a 1000 word story' })).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('.prose').filter({ hasText: 'brave knight' })).toBeVisible({ timeout: 10_000 })
    await expect(page.getByRole('button', { name: /stop generating/i })).toBeVisible()
    expect(postCount).toBe(1)

    // --- Navigate to thread B (client-side), confirm no cross-thread leak ---
    // Click sidebar links by href: sending in A rewrote A's sidebar title to the
    // message text, so a name-based locator would be brittle.
    await page.locator(`a[href="/chat/${THREAD_B}"]`).click()
    await expect(page.getByText(B_CONTENT)).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('.prose').filter({ hasText: 'brave knight' })).toHaveCount(0)

    // --- Navigate back to thread A: the partial answer must still be there ---
    await page.locator(`a[href="/chat/${THREAD_A}"]`).click()
    await expect(page.getByText(PARTIAL)).toBeVisible({ timeout: 10_000 })
    await expect(page.getByRole('paragraph').filter({ hasText: 'write a 1000 word story' })).toBeVisible()
    // Still streaming (adopted the live slice; did not re-fetch from the DB).
    await expect(page.getByRole('button', { name: /stop generating/i })).toBeVisible()
    expect(postCount).toBe(1) // the stream was not restarted
  })
})
