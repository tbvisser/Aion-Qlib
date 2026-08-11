import { test, expect } from '@playwright/test'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_PATH = path.join(__dirname, '../fixtures/sample.pdf')
const DOC_ID = '00000000-0000-0000-0000-000000000aa1'
const DOC_FILENAME = 'sample.pdf'

function makeDoc() {
  return {
    id: DOC_ID,
    user_id: 'test-user',
    folder_id: null,
    filename: DOC_FILENAME,
    file_type: 'application/pdf',
    file_size: 1024,
    storage_path: `docs/${DOC_ID}.pdf`,
    status: 'completed',
    error_message: null,
    chunk_count: 3,
    content_hash: 'abc',
    hierarchical_index: null,
    metadata: { title: 'Sample PDF' },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
}

test.describe('Docs Sidecar state machine', () => {
  test('clicking a doc card opens sidecar at ~50vw, expands to ~72vw, and closes', async ({ page }) => {
    const pdfBytes = fs.readFileSync(FIXTURE_PATH)
    const doc = makeDoc()

    await page.route('**/folders*', route => route.fulfill({ json: [] }))
    await page.route('**/documents?*', route =>
      route.fulfill({ json: { documents: [doc], has_more: false, total: 1 } }),
    )
    await page.route(`**/documents/${DOC_ID}/download`, route =>
      route.fulfill({ json: { url: 'http://localhost:5173/__test_fixture__.pdf', file_type: 'application/pdf' } }),
    )
    await page.route(`**/documents/${DOC_ID}/render`, route =>
      route.fulfill({
        json: {
          document_id: DOC_ID,
          markdown: '## Sample PDF\n\nPage 1',
          pages: [{ page_no: 1, markdown: '## Sample PDF\n\nPage 1' }],
          structure: {
            version: 1,
            source: 'docling',
            nodes: [
              { id: 'page-1', kind: 'page', title: 'Page 1', level: 1, page_no: 1 },
              { id: 'section-1', kind: 'section', title: 'Sample PDF', level: 2, page_no: 1 },
            ],
          },
        },
      }),
    )
    await page.route('**/__test_fixture__.pdf', route =>
      route.fulfill({ body: pdfBytes, contentType: 'application/pdf' }),
    )
    await page.route(`**/documents/${DOC_ID}/chunks`, route => route.fulfill({ json: [] }))

    await page.goto('/documents')

    const card = page.getByTestId(`document-card-${DOC_ID}`)
    await expect(card).toBeVisible({ timeout: 10_000 })
    await card.click()

    const sidecar = page.getByTestId('docs-sidecar')
    await expect(sidecar).toBeVisible()

    const widthRatio = await sidecar.evaluate(el => el.getBoundingClientRect().width / window.innerWidth)
    expect(widthRatio).toBeGreaterThan(0.45)
    expect(widthRatio).toBeLessThan(0.55)

    await page.getByTestId('docs-sidecar-expand-toggle').click()
    await expect(sidecar).toHaveAttribute('data-expanded', 'true')
    await expect.poll(
      async () => sidecar.evaluate(el => el.getBoundingClientRect().width / window.innerWidth),
    ).toBeGreaterThan(0.68)
    const expandedWidthRatio = await sidecar.evaluate(el => el.getBoundingClientRect().width / window.innerWidth)
    expect(expandedWidthRatio).toBeGreaterThan(0.68)
    expect(expandedWidthRatio).toBeLessThan(0.76)

    await page.getByTestId('docs-sidecar-expand-toggle').click()
    await expect(sidecar).toHaveAttribute('data-expanded', 'false')
    await expect.poll(
      async () => sidecar.evaluate(el => el.getBoundingClientRect().width / window.innerWidth),
    ).toBeLessThan(0.55)
    const collapsedWidthRatio = await sidecar.evaluate(el => el.getBoundingClientRect().width / window.innerWidth)
    expect(collapsedWidthRatio).toBeGreaterThan(0.45)
    expect(collapsedWidthRatio).toBeLessThan(0.55)

    const previewTab = page.getByTestId('docs-sidecar-tab-preview')
    await expect(previewTab).toHaveAttribute('data-active', 'true')

    await page.getByTestId('docs-sidecar-close').click()
    await expect(sidecar).toBeHidden()

    await card.click()
    await expect(sidecar).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(sidecar).toBeHidden()
  })
})
