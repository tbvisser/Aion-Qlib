import { test, expect } from '@playwright/test'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const AUTH_STATE_PATH = path.join(__dirname, '../support/.auth/user1.json')
const DOC_ID = '00000000-0000-0000-0000-000000000dd1'
const DOC_FILENAME = 'context-delete.md'

function getStoredUserId(): string {
  const storageState = JSON.parse(fs.readFileSync(AUTH_STATE_PATH, 'utf8'))
  const authItem = storageState.origins
    ?.flatMap((origin: { localStorage?: Array<{ name: string; value: string }> }) => origin.localStorage ?? [])
    .find((item: { name: string }) => item.name.includes('auth-token'))

  if (!authItem) {
    throw new Error('No stored auth token found for document owner mock')
  }

  return JSON.parse(authItem.value).user.id
}

function makeDoc(userId: string) {
  return {
    id: DOC_ID,
    user_id: userId,
    folder_id: null,
    filename: DOC_FILENAME,
    file_type: 'text/markdown',
    file_size: 24,
    storage_path: `docs/${DOC_ID}.md`,
    status: 'completed',
    error_message: null,
    chunk_count: 1,
    content_hash: 'context-delete-hash',
    hierarchical_index: null,
    metadata: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
}

test.describe('Document card context menu', () => {
  test('right-click delete confirms and removes the document card', async ({ page }) => {
    let documents = [makeDoc(getStoredUserId())]
    let deleteRequests = 0

    await page.route('**/folders*', route => route.fulfill({ json: [] }))
    await page.route('**/documents?*', route =>
      route.fulfill({ json: { documents, has_more: false, total_count: documents.length } }),
    )
    await page.route(`**/documents/${DOC_ID}`, route => {
      if (route.request().method() !== 'DELETE') {
        return route.fulfill({ status: 404, json: { detail: 'Not found' } })
      }

      deleteRequests += 1
      documents = []
      return route.fulfill({ status: 204, body: '' })
    })

    await page.goto('/documents')

    const card = page.getByTestId(`document-card-${DOC_ID}`)
    await expect(card).toBeVisible()

    await card.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Delete' }).click()

    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('Delete document?')).toBeVisible()
    await expect(dialog.getByText(`This will permanently delete "${DOC_FILENAME}"`)).toBeVisible()

    await dialog.getByRole('button', { name: 'Delete' }).click()

    await expect.poll(() => deleteRequests).toBe(1)
    await expect(card).not.toBeVisible()
    await expect(dialog).not.toBeVisible()
  })
})
