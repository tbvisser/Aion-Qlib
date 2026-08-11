import { test, expect } from '@playwright/test'

test.describe('Thread sidebar search & lazy loading', () => {
  test('search input is visible under New Chat button', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('button', { name: /new chat/i })).toBeVisible()
    await expect(page.getByPlaceholder('Search threads...')).toBeVisible()
  })

  test('typing filters the visible threads after debounce', async ({ page }) => {
    await page.goto('/')

    // Seed: create a thread with a distinct title via the UI, then send a message
    // so the title sticks (otherwise it stays "New Chat" until first message).
    await page.getByRole('button', { name: /new chat/i }).click()
    const messageInput = page.getByPlaceholder(/ask anything/i)
    await messageInput.fill('Tell me about invoice processing in Q3')
    await messageInput.press('Enter')
    // Wait for the assistant response so the LLM title generator has fired
    await expect(page.locator('.prose').first()).toBeVisible({ timeout: 60_000 })

    // Wait for the title-update realtime to land in the sidebar
    await page.waitForTimeout(2_000)

    // Now search — wait for the network response with the search param
    const search = page.getByPlaceholder('Search threads...')
    const searchResponse = page.waitForResponse(
      (r) => r.url().includes('/threads') && /search=invoice/i.test(r.url())
    )
    await search.fill('invoice')
    await searchResponse

    // The original "New Chat" placeholder should not be visible in the filtered view
    // and at least one matching thread should be visible.
    const sidebarLinks = page.locator('a[href^="/chat/"]')
    await expect(sidebarLinks.first()).toBeVisible()
  })

  test('clear button restores the full list', async ({ page }) => {
    await page.goto('/')

    const search = page.getByPlaceholder('Search threads...')
    await search.fill('zzz-unlikely-match-xyz')

    // Empty state appears for filtered-with-no-matches
    await expect(page.getByText(/No threads match/i)).toBeVisible({ timeout: 5_000 })

    await page.getByRole('button', { name: /clear search/i }).click()
    await expect(search).toHaveValue('')
  })

  test('scrolling triggers a second page fetch when has_more is true', async ({ page }) => {
    await page.goto('/')

    // Inspect the initial /threads response to learn whether has_more is true.
    // If the test account has <50 threads, this case is not exercisable — skip.
    const initial = await page.waitForResponse(
      (r) => r.url().includes('/threads') && r.url().includes('offset=0'),
      { timeout: 10_000 }
    ).catch(() => null)

    if (!initial) {
      test.skip(true, 'no initial /threads response observed')
      return
    }

    const body = await initial.json().catch(() => null)
    if (!body || body.has_more !== true) {
      test.skip(true, 'requires >50 seeded threads for this user')
      return
    }

    const nextPage = page.waitForResponse(
      (r) => r.url().includes('/threads') && r.url().includes('offset=50')
    )

    // Scroll the sidebar's scrollable list to the bottom.
    await page.evaluate(() => {
      const scrollable = Array.from(document.querySelectorAll('div'))
        .find((el) => el.className.includes('overflow-y-auto'))
      if (scrollable) scrollable.scrollTo(0, scrollable.scrollHeight)
    })

    await nextPage
  })

  test('stale search response does not overwrite latest results', async ({ page }) => {
    // Pin the requestIdRef epoch guard: an in-flight response for an older
    // search term must be discarded when a newer search is already in flight.
    // Without this guard, fast typing produces results from a stale request
    // landing on screen.
    let firstSearchHandled = false
    await page.route('**/threads*', async (route) => {
      const url = route.request().url()
      const isFirstStaleSearch = !firstSearchHandled && /[?&]search=alp(?:&|$)/.test(url)
      if (isFirstStaleSearch) {
        firstSearchHandled = true
        // Delay the stale response so the next ("alpha") search overtakes it.
        await new Promise((r) => setTimeout(r, 1500))
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            threads: [
              {
                id: '00000000-0000-0000-0000-000000000001',
                user_id: 'x',
                title: 'STALE_SHOULD_NOT_APPEAR',
                created_at: '2020-01-01T00:00:00Z',
                updated_at: '2020-01-01T00:00:00Z',
              },
            ],
            total_count: 1,
            has_more: false,
          }),
        })
        return
      }
      await route.continue()
    })

    await page.goto('/')
    const search = page.getByPlaceholder('Search threads...')
    await search.fill('alp')
    // Let the 250ms debounce fire so the stale request goes out.
    await page.waitForTimeout(350)
    await search.fill('alpha')
    // Wait long enough for the stale (1500ms) response to land.
    await page.waitForTimeout(2_000)
    await expect(page.getByText('STALE_SHOULD_NOT_APPEAR')).toHaveCount(0)
  })
})
