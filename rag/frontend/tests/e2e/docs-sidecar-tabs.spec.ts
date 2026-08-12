import { test, expect } from '@playwright/test'

const DOC_ID = '00000000-0000-0000-0000-000000000ee1'

test.describe('Docs Sidecar tabs', () => {
  test('Text / Metadata / Chunks tabs render their content and structure rail is clickable', async ({ page }) => {
    const doc = {
      id: DOC_ID,
      user_id: 'test-user',
      folder_id: null,
      filename: 'notes.md',
      file_type: 'text/markdown',
      file_size: 100,
      storage_path: `docs/${DOC_ID}.md`,
      status: 'completed',
      error_message: null,
      chunk_count: 2,
      content_hash: null,
      hierarchical_index: '# Root\n  - Section 1\n  - Section 2',
      metadata: { title: 'My Notes', summary: 'Short summary', document_type: 'memo' },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    const chunks = [
      { id: 'c1', content: 'Alpha content', chunk_index: 0, metadata: null },
      { id: 'c2', content: 'Beta content', chunk_index: 1, metadata: null },
    ]
    const longIntro = Array.from(
      { length: 36 },
      (_, index) => `Intro paragraph ${index + 1}: background notes before the target section.`,
    ).join('\n\n')
    const markdown = `# Hello\n\n${longIntro}\n\n## Section 1\n\nAlpha content`

    await page.route('**/folders*', route => route.fulfill({ json: [] }))
    await page.route('**/documents?*', route =>
      route.fulfill({ json: { documents: [doc], has_more: false, total: 1 } }),
    )
    await page.route(`**/documents/${DOC_ID}/download`, route =>
      route.fulfill({ json: { url: 'http://localhost:5173/__notes.md', file_type: 'text/markdown' } }),
    )
    await page.route('**/__notes.md', route =>
      route.fulfill({ body: markdown, contentType: 'text/markdown' }),
    )
    await page.route(`**/documents/${DOC_ID}/render`, route =>
      route.fulfill({
        json: {
          document_id: DOC_ID,
          markdown,
          pages: [
            { page_no: 1, markdown },
          ],
          structure: {
            version: 1,
            source: 'markdown',
            nodes: [
              { id: 'page-1', kind: 'page', title: 'Page 1', level: 1, page_no: 1 },
              { id: 'section-1', kind: 'section', title: 'Section 1', level: 2, page_no: 1 },
            ],
          },
        },
      }),
    )
    await page.route(`**/documents/${DOC_ID}/chunks`, route => route.fulfill({ json: chunks }))

    await page.goto('/documents')

    await page.getByTestId(`document-card-${DOC_ID}`).click()
    const sidecar = page.getByTestId('docs-sidecar')
    await expect(sidecar).toBeVisible()

    const sidecarContent = page.getByTestId('docs-sidecar-content')
    await expect(page.getByTestId('document-structure-nav')).toContainText('Section 1')
    await expect(sidecarContent).toContainText('Section 1')
    await sidecarContent.evaluate(node => { node.scrollTop = 0 })
    await page.getByTestId('document-structure-node-section-1').click()
    await expect(page.getByTestId('document-structure-node-section-1')).toHaveClass(/text-primary/)
    await expect.poll(async () => sidecarContent.evaluate(node => node.scrollTop)).toBeGreaterThan(0)

    await page.getByTestId('docs-sidecar-tab-text').click()
    await expect(page.getByTestId('document-text-page-1')).toContainText('Section 1')
    await sidecarContent.evaluate(node => { node.scrollTop = 0 })
    await page.getByTestId('document-structure-node-section-1').click()
    await expect.poll(async () => sidecarContent.evaluate(node => node.scrollTop)).toBeGreaterThan(0)
    await page.getByTestId('docs-sidecar-text-search').fill('Alpha')
    await expect(page.getByTestId('docs-sidecar-text-match-count')).toContainText('1/1')

    await page.getByTestId('docs-sidecar-tab-metadata').click()
    await expect(sidecar).toContainText('My Notes')
    await expect(sidecar).toContainText('Short summary')
    await expect(sidecar).toContainText('memo')

    await page.getByTestId('docs-sidecar-tab-chunks').click()
    await expect(sidecar.locator('text=Chunk 0')).toBeVisible({ timeout: 5_000 })
    await sidecar.locator('button:has-text("Chunk 0")').click()
    await expect(sidecar).toContainText('Alpha content')
  })
})
