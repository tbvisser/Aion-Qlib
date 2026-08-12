import { test, expect } from '@playwright/test'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const FAKE_THREAD_ID = '00000000-0000-0000-0000-000000000002'
const FAKE_FILE_PATH = 'sample.docx'
const FIXTURE_PATH = path.join(__dirname, '../fixtures/sample.docx')
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

test.describe('Sidecar DOCX preview', () => {
  test('renders DOCX with non-selectable text', async ({ page }) => {
    const docxBytes = fs.readFileSync(FIXTURE_PATH)

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
        content_type: DOCX_MIME,
        size_bytes: docxBytes.length,
        source: 'test',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }],
    }))
    await page.route(`**/threads/${FAKE_THREAD_ID}/files/${FAKE_FILE_PATH}?download=true`, route =>
      route.fulfill({ json: { url: 'http://localhost:5173/__test_fixture__.docx' } }),
    )
    await page.route('**/__test_fixture__.docx', route =>
      route.fulfill({ body: docxBytes, contentType: DOCX_MIME }),
    )

    await page.goto(`/chat/${FAKE_THREAD_ID}`)

    const fileRow = page.locator(`[data-testid="workspace-file-${FAKE_FILE_PATH}"]`)
    await expect(fileRow).toBeVisible({ timeout: 10_000 })
    await fileRow.click()

    const preview = page.getByTestId('sidecar-preview')
    await expect(preview).toBeVisible()

    const docxRoot = preview.getByTestId('docx-root')
    await expect(docxRoot).toBeVisible({ timeout: 15_000 })

    // user-select should be 'none' on the container so text appears but isn't selectable
    const userSelect = await docxRoot.evaluate(el => getComputedStyle(el).userSelect)
    expect(userSelect).toBe('none')

    // Confirm docx-preview rendered something with content
    const hasContent = await docxRoot.evaluate(el => (el.textContent || '').trim().length > 0)
    expect(hasContent).toBe(true)
  })
})
