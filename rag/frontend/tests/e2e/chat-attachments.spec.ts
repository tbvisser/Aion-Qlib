import { test, expect } from '@playwright/test'

const THREAD_ID = '00000000-0000-0000-0000-0000000006b2'
const FIRST_FILE_PATH = 'uploads/first-screenshot.png'
const SECOND_FILE_PATH = 'uploads/second-screenshot.png'
const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p94AAAAASUVORK5CYII='
const PNG_BYTES = Buffer.from(TINY_PNG_BASE64, 'base64')

test.describe('Chat message attachments', () => {
  test('renders multiple image attachments as fixed thumbnails and opens the workspace preview', async ({ page }) => {
    const now = new Date().toISOString()
    const workspaceFiles = [FIRST_FILE_PATH, SECOND_FILE_PATH].map((filePath, index) => ({
      id: `file-${index + 1}`,
      thread_id: THREAD_ID,
      file_path: filePath,
      content_type: 'image/png',
      size_bytes: PNG_BYTES.length,
      source: 'upload',
      storage_path: `${THREAD_ID}/${filePath}`,
      created_at: now,
      updated_at: now,
    }))

    await page.route('**/settings/public', route => route.fulfill({ json: { context_window: 128000 } }))
    await page.route('**/threads?*', route => route.fulfill({
      json: {
        threads: [{ id: THREAD_ID, user_id: 'test-user', title: 'Attachment layout', created_at: now, updated_at: now }],
        total_count: 1,
        has_more: false,
      },
    }))
    await page.route(`**/threads/${THREAD_ID}`, route => route.fulfill({
      json: { id: THREAD_ID, user_id: 'test-user', title: 'Attachment layout', created_at: now, updated_at: now },
    }))
    await page.route(`**/threads/${THREAD_ID}/todos`, route => route.fulfill({ json: [] }))
    await page.route(`**/threads/${THREAD_ID}/harness`, route => route.fulfill({ json: null }))
    await page.route(`**/threads/${THREAD_ID}/compactions`, route => route.fulfill({ json: [] }))
    await page.route(`**/threads/${THREAD_ID}/files`, route => route.fulfill({ json: workspaceFiles }))
    await page.route(`**/threads/${THREAD_ID}/messages`, route => route.fulfill({
      json: [{
        id: 'user-with-images',
        thread_id: THREAD_ID,
        user_id: 'test-user',
        role: 'user',
        content: 'Here are two screenshots.',
        attachments: workspaceFiles.map(file => ({
          file_path: file.file_path,
          content_type: file.content_type,
          size_bytes: file.size_bytes,
          source: file.source,
        })),
        created_at: now,
      }],
    }))
    await page.route(
      url => url.pathname.includes(`/threads/${THREAD_ID}/files/`)
        && url.searchParams.get('download') === 'true',
      route => route.fulfill({ json: { url: `data:image/png;base64,${TINY_PNG_BASE64}` } }),
    )

    await page.goto(`/chat/${THREAD_ID}`)

    const firstAttachment = page.getByTestId(`message-attachment-${FIRST_FILE_PATH}`)
    const secondAttachment = page.getByTestId(`message-attachment-${SECOND_FILE_PATH}`)
    await expect(firstAttachment).toBeVisible()
    await expect(secondAttachment).toBeVisible()

    const firstBox = await firstAttachment.boundingBox()
    const secondBox = await secondAttachment.boundingBox()
    expect(firstBox).not.toBeNull()
    expect(secondBox).not.toBeNull()
    expect(Math.round(firstBox!.width)).toBe(176)
    expect(Math.round(firstBox!.height)).toBe(128)
    expect(Math.round(secondBox!.width)).toBe(176)
    expect(Math.round(secondBox!.height)).toBe(128)
    expect(Math.abs(firstBox!.y - secondBox!.y)).toBeLessThanOrEqual(2)
    expect(firstBox!.x).toBeLessThan(secondBox!.x)

    await firstAttachment.click()

    await expect(page.getByTestId('sidecar-column')).toHaveAttribute('data-mode', 'preview')
    await expect(page.getByTestId('sidecar-column').getByTestId('image-preview')).toBeVisible()
  })
})
