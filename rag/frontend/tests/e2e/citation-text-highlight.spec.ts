import { test, expect } from '@playwright/test'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const THREAD_ID = '00000000-0000-0000-0000-000000000131'
const DOC_ID = '00000000-0000-0000-0000-000000000232'
const CITATION_ID = 'cite_text_highlight'
const FIXTURE_PATH = path.join(__dirname, '../fixtures/sample.pdf')

const CITED = 'Cast-in-place concrete, including concrete materials, mixture design, placement procedures, and finishes.'

// The cited passage has no PDF bounding box (so the page view can't highlight
// it), but it IS present in the document's extracted markdown. Switching to the
// Text view should locate and highlight it via text search — the more reliable
// path the bounding boxes can miss.
test.describe('Citation Text-view highlight', () => {
  test('highlights the cited passage in the extracted markdown view', async ({ page }) => {
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
          content: 'See the summary {[S1]}.',
          created_at: now,
          verification_mode: 'unverified',
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
              // No bounding box -> not locatable on the rendered page, but the
              // exact text exists in the extracted markdown below.
              target: { kind: 'text_quote', exact: CITED, page: 1, bboxes: [] },
              quote: CITED,
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
    await page.route(`**/documents/${DOC_ID}/render`, route => route.fulfill({
      json: {
        document_id: DOC_ID,
        markdown: null,
        structure: null,
        pages: [
          {
            page_no: 1,
            markdown: [
              '# PART 1 - GENERAL',
              '',
              '## 1.1 SUMMARY',
              '',
              '- A. Section Includes:',
              '',
              `1. ${CITED}`,
              '',
              '## 1.2 DEFINITIONS',
            ].join('\n'),
          },
        ],
      },
    }))

    await page.goto(`/chat/${THREAD_ID}`)

    const panel = page.locator('[data-testid="citation-source-panel"]:visible')
    await page.getByRole('button', { name: /Citation 1: sample\.pdf/i }).click()
    await expect(panel).toBeVisible()

    // With no bounding box the viewer auto-switches to the extracted-text view,
    // where the cited passage is located by text search and highlighted.
    await expect(panel.getByTestId('citation-view-text')).toHaveAttribute('aria-pressed', 'true')
    const highlight = panel.locator('mark[data-citation-target="active"]')
    await expect(highlight.first()).toBeVisible({ timeout: 15_000 })
    await expect(highlight.first()).toContainText('Cast-in-place concrete')
  })
})
