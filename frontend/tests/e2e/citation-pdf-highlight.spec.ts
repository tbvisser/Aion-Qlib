import { test, expect } from '@playwright/test'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const THREAD_ID = '00000000-0000-0000-0000-000000000101'
const DOC_ID = '00000000-0000-0000-0000-000000000202'
const CITATION_ID = 'cite_pdf_highlight'
const FIXTURE_PATH = path.join(__dirname, '../fixtures/sample.pdf')

test.describe('PDF citation highlights', () => {
  test('opens rich PDF preview with citation highlight boxes', async ({ page }) => {
    const pdfBytes = fs.readFileSync(FIXTURE_PATH)
    const now = new Date().toISOString()

    await page.route('**/threads?*', route => route.fulfill({
      json: {
        threads: [{ id: THREAD_ID, user_id: 'test-user', title: 'PDF citation', created_at: now, updated_at: now }],
        total_count: 1,
        has_more: false,
      },
    }))
    await page.route(`**/threads/${THREAD_ID}`, route => route.fulfill({
      json: { id: THREAD_ID, user_id: 'test-user', title: 'PDF citation', created_at: now, updated_at: now },
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
          content: 'The fixture identifies the first page {[S1]}.',
          created_at: now,
          verification_mode: 'semantic-text',
          citations: [
            {
              citation_id: CITATION_ID,
              answer_id: 'msg-1',
              display_ref: '{[S1]}',
              display_number: 1,
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
                  {
                    page: 1,
                    l: 72,
                    t: 697.898,
                    r: 306.773,
                    b: 687.723,
                    coord_origin: 'BOTTOMLEFT',
                    item_id: '#/texts/1',
                  },
                ],
              },
              quote: 'Page 1 of 2. This is a fixture used by Playwright.',
              status: 'verified',
            },
          ],
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

    await page.goto(`/chat/${THREAD_ID}`)

    await page.getByRole('button', { name: /Citation 1: sample\.pdf/i }).click()
    // A citation selection mounts both the wide-screen panel and the
    // narrow-screen sheet; scope to whichever is visible at this viewport.
    const panel = page.locator('[data-testid="citation-source-panel"]:visible')
    await expect(panel).toBeVisible()

    const canvases = panel.locator('canvas')
    await expect(canvases.first()).toBeVisible({ timeout: 15_000 })
    await expect(panel.getByTestId('pdf-highlight-box')).toBeVisible()
    await expect(panel.getByText(/Inline PDF highlighting is not available/i)).toHaveCount(0)
    expect(await panel.locator('.textLayer').count()).toBe(0)

    const beforeWidth = await panel.getByTestId('pdf-highlight-box').evaluate(el => el.getBoundingClientRect().width)
    await panel.getByTestId('pdf-zoom-in').click()
    await expect.poll(
      async () => panel.getByTestId('pdf-highlight-box').evaluate(el => el.getBoundingClientRect().width),
    ).toBeGreaterThan(beforeWidth)
  })
})
