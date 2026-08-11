import { test, expect } from '@playwright/test'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const FAKE_THREAD_ID = '00000000-0000-0000-0000-000000000001'
const FAKE_FILE_PATH = 'sample.pdf'
const FIXTURE_PATH = path.join(__dirname, '../fixtures/sample.pdf')

test.describe('Sidecar PDF preview', () => {
  test('renders PDF pages to canvas with no text layer (non-selectable)', async ({ page }) => {
    const pdfBytes = fs.readFileSync(FIXTURE_PATH)

    // Mock thread + workspace files endpoints
    await page.route('**/threads', route => route.fulfill({ json: [{ id: FAKE_THREAD_ID, title: 'Test', created_at: new Date().toISOString(), updated_at: new Date().toISOString() }] }))
    await page.route(`**/threads/${FAKE_THREAD_ID}`, route => route.fulfill({ json: { id: FAKE_THREAD_ID, title: 'Test', created_at: new Date().toISOString(), updated_at: new Date().toISOString() } }))
    await page.route(`**/threads/${FAKE_THREAD_ID}/messages`, route => route.fulfill({ json: [] }))
    await page.route(`**/threads/${FAKE_THREAD_ID}/todos`, route => route.fulfill({ json: [] }))
    await page.route(`**/threads/${FAKE_THREAD_ID}/harness`, route => route.fulfill({ json: null }))
    await page.route(`**/threads/${FAKE_THREAD_ID}/files`, route => route.fulfill({
      json: [{
        id: 'file-1',
        thread_id: FAKE_THREAD_ID,
        file_path: FAKE_FILE_PATH,
        content_type: 'application/pdf',
        size_bytes: pdfBytes.length,
        source: 'test',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }],
    }))

    // Mock the presigned-URL response
    await page.route(`**/threads/${FAKE_THREAD_ID}/files/${FAKE_FILE_PATH}?download=true`, route =>
      route.fulfill({ json: { url: 'http://localhost:5173/__test_fixture__.pdf' } }),
    )

    // Mock the actual fetch of the fixture URL
    await page.route('**/__test_fixture__.pdf', route =>
      route.fulfill({ body: pdfBytes, contentType: 'application/pdf' }),
    )

    await page.goto(`/chat/${FAKE_THREAD_ID}`)

    const fileRow = page.locator(`[data-testid="workspace-file-${FAKE_FILE_PATH}"]`)
    await expect(fileRow).toBeVisible({ timeout: 10_000 })
    await fileRow.click()

    const preview = page.getByTestId('sidecar-column').getByTestId('sidecar-preview')
    await expect(preview).toBeVisible()
    const content = preview.getByTestId('sidecar-preview-content')
    await expect.poll(
      async () => content.evaluate(el => getComputedStyle(el).overflowY),
    ).toBe('scroll')
    await expect.poll(
      async () => content.evaluate(el => getComputedStyle(el).scrollbarGutter),
    ).toContain('stable')

    // At least one canvas rendered
    const canvases = preview.locator('canvas')
    await expect(canvases.first()).toBeVisible({ timeout: 15_000 })
    expect(await canvases.count()).toBeGreaterThan(0)
    const initialCanvasWidth = await canvases.first().evaluate(canvas => canvas.getBoundingClientRect().width)
    const viewerBox = await preview.getByTestId('pdf-canvas-viewer').boundingBox()
    expect(viewerBox).not.toBeNull()
    expect(initialCanvasWidth).toBeLessThanOrEqual(viewerBox!.width)

    // No pdf.js text layer
    expect(await preview.locator('.textLayer').count()).toBe(0)
  })
})
