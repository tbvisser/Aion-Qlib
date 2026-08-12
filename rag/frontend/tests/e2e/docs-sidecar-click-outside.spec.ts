import { test, expect } from '@playwright/test'

const DOC_ID = '00000000-0000-0000-0000-000000000aa9'

test.describe('Docs Sidecar click-outside', () => {
  test('clicking on the empty grid backdrop closes the sidecar', async ({ page }) => {
    const doc = {
      id: DOC_ID,
      user_id: 'test-user',
      folder_id: null,
      filename: 'click-outside-test.txt',
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

    await page.route('**/folders*', route => route.fulfill({ json: [] }))
    await page.route('**/documents?*', route =>
      route.fulfill({ json: { documents: [doc], has_more: false, total: 1 } }),
    )
    await page.route(`**/documents/${DOC_ID}/download`, route =>
      route.fulfill({ json: { url: 'http://localhost:5173/__co.txt', file_type: 'text/plain' } }),
    )
    await page.route('**/__co.txt', route => route.fulfill({ body: 'hi', contentType: 'text/plain' }))
    await page.route(`**/documents/${DOC_ID}/chunks`, route => route.fulfill({ json: [] }))

    await page.goto('/documents')

    await page.getByTestId(`document-card-${DOC_ID}`).click()
    const sidecar = page.getByTestId('docs-sidecar')
    await expect(sidecar).toBeVisible()

    // Click on the page background (top-left of viewport, away from sidecar and card)
    // The grid's "Add Files" button area or the page header is a safe outside-of-sidecar target.
    // Using a coordinate click on the breadcrumb region:
    await page.mouse.click(50, 50)

    await expect(sidecar).toBeHidden()
  })

  test('clicking inside the sidecar does NOT close it', async ({ page }) => {
    const doc = {
      id: DOC_ID,
      user_id: 'test-user',
      folder_id: null,
      filename: 'click-outside-test.txt',
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

    await page.route('**/folders*', route => route.fulfill({ json: [] }))
    await page.route('**/documents?*', route =>
      route.fulfill({ json: { documents: [doc], has_more: false, total: 1 } }),
    )
    await page.route(`**/documents/${DOC_ID}/download`, route =>
      route.fulfill({ json: { url: 'http://localhost:5173/__co.txt', file_type: 'text/plain' } }),
    )
    await page.route('**/__co.txt', route => route.fulfill({ body: 'hi', contentType: 'text/plain' }))
    await page.route(`**/documents/${DOC_ID}/chunks`, route => route.fulfill({ json: [] }))

    await page.goto('/documents')

    await page.getByTestId(`document-card-${DOC_ID}`).click()
    const sidecar = page.getByTestId('docs-sidecar')
    await expect(sidecar).toBeVisible()

    // Click the Metadata tab — inside the sidecar
    await page.getByTestId('docs-sidecar-tab-metadata').click()
    await expect(page.getByTestId('docs-sidecar-tab-metadata')).toHaveAttribute('data-active', 'true')

    // Sidecar should still be visible
    await expect(sidecar).toBeVisible()
  })
})
