import { test, expect, type Page } from '@playwright/test'

const THREAD_ID = '00000000-0000-0000-0000-000000000144'
const DOC_ID = '00000000-0000-0000-0000-000000000245'
const CITATION_ID = 'cite_popover_dismiss'

const CITED = 'Cast-in-place concrete, including concrete materials and finishes.'
const SOURCE_MARKDOWN = ['# Sample documents', '', `1. ${CITED}`].join('\n')

// Stand up a thread with a single document citation so the inline chip renders.
async function mockCitationThread(page: Page) {
  const now = new Date().toISOString()

  await page.route('**/threads?*', route => route.fulfill({
    json: {
      threads: [{ id: THREAD_ID, user_id: 'test-user', title: 'Popover citation', created_at: now, updated_at: now }],
      total_count: 1,
      has_more: false,
    },
  }))
  await page.route(`**/threads/${THREAD_ID}`, route => route.fulfill({
    json: { id: THREAD_ID, user_id: 'test-user', title: 'Popover citation', created_at: now, updated_at: now },
  }))
  await page.route(`**/threads/${THREAD_ID}/todos`, route => route.fulfill({ json: [] }))
  await page.route(`**/threads/${THREAD_ID}/files`, route => route.fulfill({ json: [] }))
  await page.route(`**/threads/${THREAD_ID}/harness`, route => route.fulfill({ json: null }))
  await page.route(`**/threads/${THREAD_ID}/messages`, route => route.fulfill({
    json: [
      {
        id: 'msg-1',
        thread_id: THREAD_ID,
        user_id: 'test-user',
        role: 'assistant',
        content: 'Concrete is cited {[S1]}.',
        created_at: now,
        verification_mode: 'unverified',
        citations: [
          {
            citation_id: CITATION_ID,
            answer_id: 'msg-1',
            display_ref: '{[S1]}',
            display_number: 1,
            source: {
              source_id: 'doc_md',
              source_type: 'document',
              title: 'sample-documents.md',
              document_id: DOC_ID,
              content_type: 'text/markdown',
            },
            target: { kind: 'text_quote', exact: CITED },
            quote: CITED,
            status: 'not_verified',
          },
        ],
        claim_states: [],
      },
    ],
  }))

  await page.route(`**/documents/${DOC_ID}/download`, route =>
    route.fulfill({ json: { url: 'http://localhost:5173/__unused__.md', file_type: 'text/markdown' } }),
  )
  await page.route(`**/documents/${DOC_ID}/render`, route => route.fulfill({
    json: { document_id: DOC_ID, markdown: SOURCE_MARKDOWN, structure: null, pages: [] },
  }))
}

// The citation chip shows a hover preview. Hovering opens it; moving the pointer
// away dismisses it. A *click* should behave the same way for dismissal — it
// opens the full source in the side panel (via onView) and the floating preview
// must NOT stay "pinned" open afterwards. (Previously a click pinned the
// preview so it survived pointer-leave and only closed on an outside click.)
test.describe('Citation preview popover — click dismisses like hover', () => {
  test('hover opens the preview and pointer-leave dismisses it', async ({ page }) => {
    await mockCitationThread(page)
    await page.goto(`/chat/${THREAD_ID}`)

    const chip = page.getByRole('button', { name: /Citation 1: sample-documents\.md/i })
    const viewSource = page.getByRole('button', { name: 'View source' })
    const panel = page.locator('[data-testid="citation-source-panel"]:visible')

    await expect(chip).toBeVisible()
    await chip.hover()
    await expect(viewSource).toBeVisible()
    // Hover alone never opens the full source panel.
    await expect(panel).toHaveCount(0)

    await page.mouse.move(5, 5)
    await expect(viewSource).toBeHidden()
  })

  test('click opens the source panel and the preview dismisses on pointer-leave (not pinned)', async ({ page }) => {
    await mockCitationThread(page)
    await page.goto(`/chat/${THREAD_ID}`)

    const chip = page.getByRole('button', { name: /Citation 1: sample-documents\.md/i })
    const viewSource = page.getByRole('button', { name: 'View source' })
    const panel = page.locator('[data-testid="citation-source-panel"]:visible')

    await expect(chip).toBeVisible()
    await chip.click()

    // Clicking opens the full source in the side panel/sidecar...
    await expect(panel).toBeVisible()
    // ...and the floating preview is shown while the pointer is still on the chip.
    await expect(viewSource).toBeVisible()

    // Moving the pointer away dismisses the preview, exactly like hover.
    // Under the old "pin on click" behavior this stayed open and failed here.
    await page.mouse.move(5, 5)
    await expect(viewSource).toBeHidden()
  })
})
