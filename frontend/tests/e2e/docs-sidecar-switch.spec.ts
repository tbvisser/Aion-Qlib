import { test, expect } from '@playwright/test'

const DOC_A = '00000000-0000-0000-0000-000000000bb1'
const DOC_B = '00000000-0000-0000-0000-000000000bb2'

function makeDoc(id: string, filename: string) {
  return {
    id,
    user_id: 'test-user',
    folder_id: null,
    filename,
    file_type: 'text/plain',
    file_size: 50,
    storage_path: `docs/${id}.txt`,
    status: 'completed',
    error_message: null,
    chunk_count: 1,
    content_hash: 'abc',
    hierarchical_index: null,
    metadata: { title: filename.replace('.txt', '') },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
}

test.describe('Docs Sidecar file swap', () => {
  test('clicking another card swaps the previewed file and resets to Preview tab', async ({ page }) => {
    const docA = makeDoc(DOC_A, 'alpha.txt')
    const docB = makeDoc(DOC_B, 'beta.txt')

    await page.route('**/folders*', route => route.fulfill({ json: [] }))
    await page.route('**/documents?*', route =>
      route.fulfill({ json: { documents: [docA, docB], has_more: false, total: 2 } }),
    )
    for (const [id, body] of [[DOC_A, 'alpha content'], [DOC_B, 'beta content']] as const) {
      await page.route(`**/documents/${id}/download`, route =>
        route.fulfill({ json: { url: `http://localhost:5173/__fixture_${id}.txt`, file_type: 'text/plain' } }),
      )
      await page.route(`**/__fixture_${id}.txt`, route =>
        route.fulfill({ body, contentType: 'text/plain' }),
      )
      await page.route(`**/documents/${id}/chunks`, route => route.fulfill({ json: [] }))
    }

    await page.goto('/documents')

    const cardA = page.getByTestId(`document-card-${DOC_A}`)
    const cardB = page.getByTestId(`document-card-${DOC_B}`)
    await expect(cardA).toBeVisible({ timeout: 10_000 })

    await cardA.click()
    const sidecar = page.getByTestId('docs-sidecar')
    await expect(sidecar).toBeVisible()
    await expect(sidecar).toContainText('alpha.txt')

    // Switch tabs first, then click another file → should reset to Preview
    await page.getByTestId('docs-sidecar-tab-metadata').click()
    await expect(page.getByTestId('docs-sidecar-tab-metadata')).toHaveAttribute('data-active', 'true')

    await cardB.click()
    await expect(sidecar).toContainText('beta.txt')
    await expect(page.getByTestId('docs-sidecar-tab-preview')).toHaveAttribute('data-active', 'true')
  })
})
