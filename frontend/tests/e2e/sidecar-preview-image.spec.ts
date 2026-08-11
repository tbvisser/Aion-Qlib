import { test, expect } from '@playwright/test'

const THREAD_ID = '00000000-0000-0000-0000-0000000001a9'
const FILE_PATH = 'uploads/pasted-image-test.png'
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lmU9WQAAAABJRU5ErkJggg==',
  'base64',
)

test.describe('Sidecar image preview', () => {
  test('renders uploaded thread images inline', async ({ page }) => {
    const now = new Date().toISOString()

    await page.route('**/settings/public', route => route.fulfill({ json: { context_window: 128000 } }))
    await page.route('**/threads?*', route => route.fulfill({
      json: {
        threads: [{ id: THREAD_ID, user_id: 'test-user', title: 'Image preview', created_at: now, updated_at: now }],
        total_count: 1,
        has_more: false,
      },
    }))
    await page.route(`**/threads/${THREAD_ID}`, route => route.fulfill({
      json: { id: THREAD_ID, user_id: 'test-user', title: 'Image preview', created_at: now, updated_at: now },
    }))
    await page.route(`**/threads/${THREAD_ID}/messages`, route => route.fulfill({ json: [] }))
    await page.route(`**/threads/${THREAD_ID}/todos`, route => route.fulfill({ json: [] }))
    await page.route(`**/threads/${THREAD_ID}/harness`, route => route.fulfill({ json: null }))
    await page.route(`**/threads/${THREAD_ID}/compactions`, route => route.fulfill({ json: [] }))
    await page.route(`**/threads/${THREAD_ID}/files`, route => route.fulfill({
      json: [{
        id: 'file-1',
        thread_id: THREAD_ID,
        file_path: FILE_PATH,
        content_type: 'image/png',
        size_bytes: PNG_BYTES.length,
        source: 'upload',
        storage_path: `${THREAD_ID}/pasted-image-test.png`,
        created_at: now,
        updated_at: now,
      }],
    }))
    await page.route(`**/threads/${THREAD_ID}/files/${FILE_PATH}?download=true`, route =>
      route.fulfill({ json: { url: 'http://localhost:5173/__test_fixture__.png' } }),
    )
    await page.route('**/__test_fixture__.png', route =>
      route.fulfill({ body: PNG_BYTES, contentType: 'image/png' }),
    )

    await page.goto(`/chat/${THREAD_ID}`)

    await page.getByTestId(`workspace-file-${FILE_PATH}`).click()

    const preview = page.getByTestId('sidecar-column').getByTestId('image-preview')
    await expect(preview).toBeVisible()
    await expect(page.getByText('This file cannot be previewed.')).toHaveCount(0)

    await expect.poll(async () => preview.evaluate((node) => {
      const img = node as HTMLImageElement
      return img.complete && img.naturalWidth > 0 && img.naturalHeight > 0
    })).toBe(true)
  })
})
