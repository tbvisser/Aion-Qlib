import { test, expect } from '@playwright/test'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const THREAD_ID = '00000000-0000-0000-0000-000000000111'
const DOC_ID = '00000000-0000-0000-0000-000000000212'
const FIXTURE_PATH = path.join(__dirname, '../fixtures/sample.pdf')

// All three citations point at the SAME document but differ in how they can be
// located:
//  - #1 has a bounding box (locatable on the page) and its text is in the render
//  - #2 has no box but its text IS in the extracted markdown
//  - #3 has no box and its text is NOT anywhere in the document
const IN_PDF_AND_TEXT = 'Cast-in-place concrete, including concrete materials, mixture design, placement procedures, and finishes.'
const TEXT_ONLY = 'Water/Cement Ratio (w/cm): The ratio by weight of water to cementitious materials.'
const NOWHERE = 'This passage is absent from the rendered document entirely.'

const SOURCE = {
  source_id: 'doc_pdf',
  source_type: 'document' as const,
  title: 'sample.pdf',
  document_id: DOC_ID,
  content_type: 'application/pdf',
}

// Exercises the citation view state machine:
//  - default to the Page view and land on the bounding box
//  - no box -> fall to the Text view and highlight the passage there
//  - found in neither the page nor the text -> open the "not found" drawer
//  - clicking a citation that HAS a box returns to the Page view, even after the
//    previous (box-less) citations dropped us into the Text view
test.describe('Citation view state + drawer', () => {
  test('defaults to page, falls back to text only when unlocatable, and returns to page for boxed citations', async ({ page }) => {
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
          content: 'Concrete {[S1]}; water ratio {[S2]}; missing {[S3]}.',
          created_at: now,
          verification_mode: 'unverified',
          citations: [
            {
              citation_id: 'cite_pdf', answer_id: 'msg-1', display_ref: '{[S1]}', display_number: 1, source: SOURCE,
              target: {
                kind: 'text_quote', exact: IN_PDF_AND_TEXT, page: 1,
                bboxes: [{ page: 1, l: 72, t: 697.898, r: 306.773, b: 687.723, coord_origin: 'BOTTOMLEFT', item_id: '#/texts/1' }],
              },
              quote: IN_PDF_AND_TEXT, status: 'verified',
            },
            {
              citation_id: 'cite_text', answer_id: 'msg-1', display_ref: '{[S2]}', display_number: 2, source: SOURCE,
              target: { kind: 'text_quote', exact: TEXT_ONLY, page: 1, bboxes: [] },
              quote: TEXT_ONLY, status: 'verified',
            },
            {
              citation_id: 'cite_nowhere', answer_id: 'msg-1', display_ref: '{[S3]}', display_number: 3, source: SOURCE,
              target: { kind: 'text_quote', exact: NOWHERE, page: 1, bboxes: [] },
              quote: NOWHERE, status: 'verified',
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
        pages: [{ page_no: 1, markdown: [`1. ${IN_PDF_AND_TEXT}`, '', `B. ${TEXT_ONLY}`].join('\n\n') }],
      },
    }))

    await page.goto(`/chat/${THREAD_ID}`)

    const panel = page.locator('[data-testid="citation-source-panel"]:visible')
    const drawerToggle = panel.locator('button[aria-expanded]')
    const pageTab = panel.getByTestId('citation-view-page')
    const textTab = panel.getByTestId('citation-view-text')
    const pdfBox = panel.getByTestId('pdf-highlight-box')
    const mark = panel.locator('mark[data-citation-target="active"]')
    const warning = panel.getByText(/Exact location not found in the source/i)

    // 1) Located on the page -> default Page view, bounding box, drawer closed.
    await page.getByRole('button', { name: /Citation 1: sample\.pdf/i }).click()
    await expect(panel).toBeVisible()
    await expect(pageTab).toHaveAttribute('aria-pressed', 'true')
    await expect(pdfBox).toBeVisible({ timeout: 15_000 })
    await expect(drawerToggle).toHaveAttribute('aria-expanded', 'false')
    await expect(warning).toHaveCount(0)

    // 2) No box and not in the text -> auto-switch to Text view, drawer opens.
    await page.getByRole('button', { name: /Citation 3: sample\.pdf/i }).click()
    await expect(textTab).toHaveAttribute('aria-pressed', 'true')
    await expect(drawerToggle).toHaveAttribute('aria-expanded', 'true')
    await expect(warning).toBeVisible()
    await expect(mark).toHaveCount(0)

    // 3) No box but present in the text -> highlighted in Text view, drawer closes.
    await page.getByRole('button', { name: /Citation 2: sample\.pdf/i }).click()
    await expect(textTab).toHaveAttribute('aria-pressed', 'true')
    await expect(mark.first()).toBeVisible()
    await expect(mark.first()).toContainText('Water/Cement Ratio')
    await expect(drawerToggle).toHaveAttribute('aria-expanded', 'false')
    await expect(warning).toHaveCount(0)

    // 4) Citation #1 has a box -> clicking it returns to the Page view and lands
    //    on the bounding box, even though we were in the Text view for the
    //    previous box-less citations. Every citation click tries the PDF first.
    await page.getByRole('button', { name: /Citation 1: sample\.pdf/i }).click()
    await expect(pageTab).toHaveAttribute('aria-pressed', 'true')
    await expect(textTab).toHaveAttribute('aria-pressed', 'false')
    await expect(pdfBox).toBeVisible({ timeout: 15_000 })
    await expect(mark).toHaveCount(0)
    await expect(drawerToggle).toHaveAttribute('aria-expanded', 'false')
  })
})
