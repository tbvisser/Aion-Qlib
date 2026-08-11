import { test, expect } from '@playwright/test'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_PATH = path.join(__dirname, '../fixtures/sample.pdf')
const DOC_ID = '00000000-0000-0000-0000-000000000cc1'

test.describe('Docs Sidecar PDF preview', () => {
  test('renders PDF pages to canvas with no text layer', async ({ page }) => {
    const pdfBytes = fs.readFileSync(FIXTURE_PATH)

    const doc = {
      id: DOC_ID,
      user_id: 'test-user',
      folder_id: null,
      filename: 'sample.pdf',
      file_type: 'application/pdf',
      file_size: pdfBytes.length,
      storage_path: `docs/${DOC_ID}.pdf`,
      status: 'completed',
      error_message: null,
      chunk_count: 0,
      content_hash: null,
      hierarchical_index: null,
      metadata: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }

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
          markdown: '## Sample PDF for preview tests\n\nPage 1 of 2.\n\nPage 2',
          pages: [
            { page_no: 1, markdown: '## Sample PDF for preview tests\n\nPage 1 of 2.' },
            { page_no: 2, markdown: 'Page 2' },
          ],
          structure: {
            version: 1,
            source: 'docling',
            nodes: [
              { id: 'page-1', kind: 'page', title: 'Page 1', level: 1, page_no: 1 },
              { id: 'section-1', kind: 'section', title: 'Sample PDF for preview tests', level: 2, page_no: 1 },
              { id: 'page-2', kind: 'page', title: 'Page 2', level: 1, page_no: 2 },
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

    await page.getByTestId(`document-card-${DOC_ID}`).click()
    const sidecar = page.getByTestId('docs-sidecar')
    await expect(sidecar).toBeVisible()

    const canvases = sidecar.locator('canvas')
    await expect(canvases.first()).toBeVisible({ timeout: 15_000 })
    expect(await canvases.count()).toBeGreaterThan(0)
    expect(await sidecar.locator('.textLayer').count()).toBe(0)
    await expect(page.getByTestId('pdf-page-2')).toBeVisible()

    await expect(page.getByTestId('pdf-zoom-controls')).toBeVisible()
    const content = page.getByTestId('docs-sidecar-content')
    await expect.poll(
      async () => content.evaluate(el => getComputedStyle(el).overflowY),
    ).toBe('scroll')
    await expect.poll(
      async () => content.evaluate(el => getComputedStyle(el).scrollbarGutter),
    ).toContain('stable')
    const initialCanvasWidth = await canvases.first().evaluate(canvas => canvas.getBoundingClientRect().width)
    const viewerBox = await page.getByTestId('pdf-canvas-viewer').boundingBox()
    expect(viewerBox).not.toBeNull()
    expect(initialCanvasWidth).toBeLessThanOrEqual(viewerBox!.width)
    await page.getByTestId('pdf-zoom-in').click()
    await expect.poll(
      async () => canvases.first().evaluate(canvas => canvas.getBoundingClientRect().width),
    ).toBeGreaterThan(initialCanvasWidth)

    const beforeScroll = await content.evaluate(el => el.scrollTop)
    await page.getByTestId('document-structure-node-page-2').click()
    await expect(page.getByTestId('document-structure-node-page-2')).toHaveClass(/text-primary/)
    await expect.poll(async () => content.evaluate(el => el.scrollTop)).toBeGreaterThan(beforeScroll)
    const contentBox = await content.boundingBox()
    const zoomControlsBox = await page.getByTestId('pdf-zoom-controls').boundingBox()
    expect(contentBox).not.toBeNull()
    expect(zoomControlsBox).not.toBeNull()
    expect(zoomControlsBox!.y).toBeGreaterThanOrEqual(contentBox!.y - 1)
    expect(zoomControlsBox!.y + zoomControlsBox!.height).toBeLessThanOrEqual(
      contentBox!.y + contentBox!.height + 1,
    )
  })
})
