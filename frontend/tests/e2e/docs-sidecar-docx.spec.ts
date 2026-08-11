import { test, expect } from '@playwright/test'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_PATH = path.join(__dirname, '../fixtures/sample.docx')
const DOC_ID = '00000000-0000-0000-0000-000000000dd1'
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

test.describe('Docs Sidecar DOCX preview', () => {
  test('renders DOCX with non-selectable text', async ({ page }) => {
    const docxBytes = fs.readFileSync(FIXTURE_PATH)

    const doc = {
      id: DOC_ID,
      user_id: 'test-user',
      folder_id: null,
      filename: 'sample.docx',
      file_type: DOCX_MIME,
      file_size: docxBytes.length,
      storage_path: `docs/${DOC_ID}.docx`,
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
      route.fulfill({ json: { url: 'http://localhost:5173/__test_fixture__.docx', file_type: DOCX_MIME } }),
    )
    await page.route('**/__test_fixture__.docx', route =>
      route.fulfill({ body: docxBytes, contentType: DOCX_MIME }),
    )
    await page.route(`**/documents/${DOC_ID}/chunks`, route => route.fulfill({ json: [] }))

    await page.goto('/documents')

    await page.getByTestId(`document-card-${DOC_ID}`).click()
    const sidecar = page.getByTestId('docs-sidecar')
    await expect(sidecar).toBeVisible()

    const docxRoot = sidecar.getByTestId('docx-root')
    await expect(docxRoot).toBeVisible({ timeout: 15_000 })

    const userSelect = await docxRoot.evaluate(el => getComputedStyle(el).userSelect)
    expect(userSelect).toBe('none')

    const hasContent = await docxRoot.evaluate(el => (el.textContent || '').trim().length > 0)
    expect(hasContent).toBe(true)
  })
})
