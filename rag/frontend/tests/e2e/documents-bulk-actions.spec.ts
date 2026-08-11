import { test, expect } from '@playwright/test'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const AUTH_STATE_PATH = path.join(__dirname, '../support/.auth/user1.json')

const DOC_A = '00000000-0000-0000-0000-0000000b0001'
const DOC_B = '00000000-0000-0000-0000-0000000b0002'
const FOLDER_ID = '00000000-0000-0000-0000-0000000f0001'

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

function makeDoc(userId: string, id: string, filename: string) {
  return {
    id,
    user_id: userId,
    folder_id: null,
    filename,
    file_type: 'text/markdown',
    file_size: 24,
    storage_path: `docs/${id}.md`,
    status: 'completed',
    error_message: null,
    chunk_count: 1,
    content_hash: `${id}-hash`,
    hierarchical_index: null,
    metadata: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
}

function makeFolder(userId: string) {
  return {
    id: FOLDER_ID,
    user_id: userId,
    parent_id: null,
    name: 'Archive',
    shared_by: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
}

test.describe('Document bulk actions', () => {
  test('select multiple documents and bulk delete them', async ({ page }) => {
    const userId = getStoredUserId()
    let documents = [makeDoc(userId, DOC_A, 'bulk-a.md'), makeDoc(userId, DOC_B, 'bulk-b.md')]
    const bulkDeletePayloads: string[][] = []

    await page.route('**/folders*', route => route.fulfill({ json: [] }))
    await page.route('**/documents?*', route =>
      route.fulfill({ json: { documents, has_more: false, total_count: documents.length } }),
    )
    await page.route('**/documents/bulk-delete', route => {
      const body = route.request().postDataJSON() as { document_ids: string[] }
      bulkDeletePayloads.push(body.document_ids)
      documents = documents.filter(doc => !body.document_ids.includes(doc.id))
      return route.fulfill({ json: { succeeded: body.document_ids, failed: [] } })
    })

    await page.goto('/documents')

    const cardA = page.getByTestId(`document-card-${DOC_A}`)
    const cardB = page.getByTestId(`document-card-${DOC_B}`)
    await expect(cardA).toBeVisible()
    await expect(cardB).toBeVisible()

    // Select both via the per-card checkboxes.
    await page.getByTestId(`document-select-${DOC_A}`).click()
    await page.getByTestId(`document-select-${DOC_B}`).click()

    // The bulk actions bar reflects the selection.
    await expect(page.getByText('2 selected')).toBeVisible()

    // Open the confirm dialog from the bar, then confirm.
    await page.getByRole('button', { name: 'Delete' }).first().click()
    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('Delete 2 documents?')).toBeVisible()
    await dialog.getByRole('button', { name: 'Delete' }).click()

    // One bulk-delete request carrying both ids; both cards disappear.
    await expect.poll(() => bulkDeletePayloads.length).toBe(1)
    expect([...bulkDeletePayloads[0]].sort()).toEqual([DOC_A, DOC_B].sort())
    await expect(cardA).not.toBeVisible()
    await expect(cardB).not.toBeVisible()
  })

  test('select documents and bulk move them to a folder', async ({ page }) => {
    const userId = getStoredUserId()
    let documents = [makeDoc(userId, DOC_A, 'bulk-a.md'), makeDoc(userId, DOC_B, 'bulk-b.md')]
    const bulkMovePayloads: Array<{ document_ids: string[]; folder_id: string | null }> = []

    // Sidebar folder list is empty; the move dialog requests all=true.
    await page.route('**/folders*', route => {
      const json = route.request().url().includes('all=true') ? [makeFolder(userId)] : []
      return route.fulfill({ json })
    })
    await page.route('**/documents?*', route =>
      route.fulfill({ json: { documents, has_more: false, total_count: documents.length } }),
    )
    await page.route('**/documents/bulk-move', route => {
      const body = route.request().postDataJSON() as { document_ids: string[]; folder_id: string | null }
      bulkMovePayloads.push(body)
      documents = documents.filter(doc => !body.document_ids.includes(doc.id))
      return route.fulfill({ json: { succeeded: body.document_ids, failed: [] } })
    })

    await page.goto('/documents')

    const cardA = page.getByTestId(`document-card-${DOC_A}`)
    await expect(cardA).toBeVisible()

    await page.getByTestId(`document-select-${DOC_A}`).click()
    await page.getByTestId(`document-select-${DOC_B}`).click()
    await expect(page.getByText('2 selected')).toBeVisible()

    // Open the move dialog and pick the destination folder.
    await page.getByRole('button', { name: /Move to/ }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Archive' }).click()
    await dialog.getByRole('button', { name: 'Move here' }).click()

    await expect.poll(() => bulkMovePayloads.length).toBe(1)
    expect([...bulkMovePayloads[0].document_ids].sort()).toEqual([DOC_A, DOC_B].sort())
    expect(bulkMovePayloads[0].folder_id).toBe(FOLDER_ID)

    // Moved docs leave the current (root) view.
    await expect(cardA).not.toBeVisible()
    await expect(page.getByTestId(`document-card-${DOC_B}`)).not.toBeVisible()
  })
})
