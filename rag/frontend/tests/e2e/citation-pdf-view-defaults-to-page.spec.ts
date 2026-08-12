import { test, expect } from '@playwright/test'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const THREAD_ID = '00000000-0000-0000-0000-000000000111'
const DOC_ID = '00000000-0000-0000-0000-000000000212'
const FIXTURE_PATH = path.join(__dirname, '../fixtures/sample.pdf')

// Both citations point at the SAME document and both carry a bounding box, so
// each opens in the PDF page view. The regression guarded here: after the user
// switches the first citation to the Text tab, clicking a *second* citation in
// the same document must snap back to the Page view rather than stay on Text.
function citation(num: number, itemId: string) {
  return {
    citation_id: `cite_default_page_${num}`,
    answer_id: 'msg-1',
    display_ref: `{[S${num}]}`,
    display_number: num,
    source: {
      source_id: 'doc_pdf',
      source_type: 'document',
      title: 'sample.pdf',
      document_id: DOC_ID,
      content_type: 'application/pdf',
    },
    target: {
      kind: 'text_quote',
      exact: 'Page 1 of 2. This is a fixture used by Playwright.',
      page: 1,
      bboxes: [
        { page: 1, l: 72, t: 697.898, r: 306.773, b: 687.723, coord_origin: 'BOTTOMLEFT', item_id: itemId },
      ],
    },
    quote: 'Page 1 of 2. This is a fixture used by Playwright.',
    status: 'verified',
  }
}

test.describe('PDF citation view defaults to page on click', () => {
  test('clicking a citation always opens the page view, even after switching to text', async ({ page }) => {
    const pdfBytes = fs.readFileSync(FIXTURE_PATH)
    const now = new Date().toISOString()

    await page.route('**/threads?*', route => route.fulfill({
      json: {
        threads: [{ id: THREAD_ID, user_id: 'test-user', title: 'PDF view default', created_at: now, updated_at: now }],
        total_count: 1,
        has_more: false,
      },
    }))
    await page.route(`**/threads/${THREAD_ID}`, route => route.fulfill({
      json: { id: THREAD_ID, user_id: 'test-user', title: 'PDF view default', created_at: now, updated_at: now },
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
          content: 'First point {[S1]} and second point {[S2]}.',
          created_at: now,
          verification_mode: 'semantic-text',
          citations: [citation(1, '#/texts/1'), citation(2, '#/texts/2')],
          claim_states: [],
        },
      ],
    }))

    await page.route(`**/documents/${DOC_ID}/download`, route =>
      route.fulfill({ json: { url: 'http://localhost:5173/__citation_fixture__.pdf', file_type: 'application/pdf' } }),
    )
    await page.route('**/__citation_fixture__.pdf', route =>
      route.fulfill({ body: pdfBytes, contentType: 'application/pdf' }),
    )
    // Text tab fetches the rendered extraction lazily.
    await page.route(`**/documents/${DOC_ID}/render`, route => route.fulfill({
      json: {
        document_id: DOC_ID,
        markdown: 'Page 1 of 2. This is a fixture used by Playwright.',
        pages: [{ page_no: 1, markdown: 'Page 1 of 2. This is a fixture used by Playwright.' }],
        structure: null,
      },
    }))

    await page.goto(`/chat/${THREAD_ID}`)

    const panel = page.locator('[data-testid="citation-source-panel"]:visible')
    const pageToggle = panel.getByTestId('citation-view-page')
    const textToggle = panel.getByTestId('citation-view-text')

    // 1) First citation opens in the page (PDF) view with a highlight box.
    await page.getByRole('button', { name: /Citation 1: sample\.pdf/i }).click()
    await expect(panel).toBeVisible()
    await expect(panel.locator('canvas').first()).toBeVisible({ timeout: 15_000 })
    await expect(panel.getByTestId('pdf-highlight-box')).toBeVisible()
    await expect(pageToggle).toHaveAttribute('aria-pressed', 'true')

    // 2) Manually switch to the Text view — it sticks for this citation.
    await textToggle.click()
    await expect(textToggle).toHaveAttribute('aria-pressed', 'true')
    await expect(pageToggle).toHaveAttribute('aria-pressed', 'false')
    await expect(panel.locator('canvas')).toHaveCount(0)

    // 3) Clicking the second citation (same document) snaps back to the page
    //    view — the behavior this spec guards.
    await page.getByRole('button', { name: /Citation 2: sample\.pdf/i }).click()
    await expect(pageToggle).toHaveAttribute('aria-pressed', 'true')
    await expect(textToggle).toHaveAttribute('aria-pressed', 'false')
    await expect(panel.locator('canvas').first()).toBeVisible({ timeout: 15_000 })
    await expect(panel.getByTestId('pdf-highlight-box')).toBeVisible()
  })
})
