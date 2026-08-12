import { test, expect } from '@playwright/test'

const FOLDER_ID = '00000000-0000-0000-0000-000000000f01'
const DOC_ID = '00000000-0000-0000-0000-000000000ff1'

test.describe('Docs Sidecar folder navigation', () => {
  test('navigating to a different folder closes the sidecar', async ({ page }) => {
    const folder = {
      id: FOLDER_ID,
      user_id: 'test-user',
      parent_id: null,
      name: 'Reports',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    const doc = {
      id: DOC_ID,
      user_id: 'test-user',
      folder_id: null,
      filename: 'top.txt',
      file_type: 'text/plain',
      file_size: 10,
      storage_path: `docs/${DOC_ID}.txt`,
      status: 'completed',
      error_message: null,
      chunk_count: 0,
      content_hash: null,
      hierarchical_index: null,
      metadata: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }

    await page.route('**/folders*', async (route, request) => {
      const url = new URL(request.url())
      const parent = url.searchParams.get('parent_id')
      if (parent) return route.fulfill({ json: [] })
      return route.fulfill({ json: [folder] })
    })
    await page.route('**/documents?*', async (route, request) => {
      const url = new URL(request.url())
      const folderParam = url.searchParams.get('folder_id')
      if (folderParam === FOLDER_ID) {
        return route.fulfill({ json: { documents: [], has_more: false, total: 0 } })
      }
      return route.fulfill({ json: { documents: [doc], has_more: false, total: 1 } })
    })
    await page.route(`**/documents/${DOC_ID}/download`, route =>
      route.fulfill({ json: { url: 'http://localhost:5173/__top.txt', file_type: 'text/plain' } }),
    )
    await page.route('**/__top.txt', route => route.fulfill({ body: 'top', contentType: 'text/plain' }))
    await page.route(`**/documents/${DOC_ID}/chunks`, route => route.fulfill({ json: [] }))

    await page.goto('/documents')

    await page.getByTestId(`document-card-${DOC_ID}`).click()
    const sidecar = page.getByTestId('docs-sidecar')
    await expect(sidecar).toBeVisible()

    // Click the Reports folder card to navigate
    await page.getByTestId(`folder-card-${FOLDER_ID}`).click()
    await page.waitForURL(/\/documents\/.+/)

    await expect(sidecar).toBeHidden()
  })
})
