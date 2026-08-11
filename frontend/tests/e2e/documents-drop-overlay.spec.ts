import { test, expect, type Page } from '@playwright/test'

const FOLDER_ID = '00000000-0000-0000-0000-000000000d01'
const DOC_ID = '00000000-0000-0000-0000-000000000d02'

async function dispatchFileDragEvent(page: Page, eventType: 'dragenter' | 'dragover' | 'drop') {
  await page.evaluate((eventType) => {
    const file = new File(['hello'], 'drop-test.txt', { type: 'text/plain' })
    const dataTransfer = new DataTransfer()
    dataTransfer.items.add(file)
    document.body.dispatchEvent(new DragEvent(eventType, {
      bubbles: true,
      cancelable: true,
      dataTransfer,
    }))
  }, eventType)
}

test.describe('Documents page drag upload overlay', () => {
  test('uploads dropped files into the current folder', async ({ page }) => {
    let uploadPostData = ''

    await page.route('**/folders**', async (route) => {
      const url = new URL(route.request().url())
      if (url.port !== '8001') {
        return route.continue()
      }

      if (url.pathname.endsWith('/ancestors')) {
        return route.fulfill({
          json: [{ id: FOLDER_ID, name: 'Quarterly Reports' }],
        })
      }

      return route.fulfill({ json: [] })
    })

    await page.route('**/documents**', async (route) => {
      const url = new URL(route.request().url())
      if (url.port !== '8001') {
        return route.continue()
      }

      if (url.pathname === '/documents/upload') {
        uploadPostData = route.request().postData() ?? ''
        return route.fulfill({
          json: {
            id: DOC_ID,
            user_id: 'test-user',
            folder_id: FOLDER_ID,
            filename: 'drop-test.txt',
            file_type: 'text/plain',
            file_size: 5,
            storage_path: `documents/${DOC_ID}/drop-test.txt`,
            status: 'pending',
            error_message: null,
            chunk_count: 0,
            content_hash: null,
            hierarchical_index: null,
            metadata: null,
            action: 'created',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        })
      }

      if (url.pathname === '/documents') {
        return route.fulfill({
          json: { documents: [], total_count: 0, has_more: false },
        })
      }

      return route.continue()
    })

    await page.goto(`/documents/${FOLDER_ID}`)
    await expect(page.getByText('Quarterly Reports')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Drop files here' })).toBeVisible()
    await page.waitForTimeout(100)

    await dispatchFileDragEvent(page, 'dragenter')
    await dispatchFileDragEvent(page, 'dragover')
    await expect(page.getByTestId('documents-page-drop-overlay')).toBeVisible()

    await dispatchFileDragEvent(page, 'drop')

    await expect.poll(() => uploadPostData).toContain('drop-test.txt')
    expect(uploadPostData).toContain('folder_id')
    expect(uploadPostData).toContain(FOLDER_ID)
    await expect(page.getByTestId('documents-page-drop-overlay')).toBeHidden()
  })
})
