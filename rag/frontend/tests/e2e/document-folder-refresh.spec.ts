import { test, expect } from '@playwright/test'

const PARENT_ID = '00000000-0000-0000-0000-00000000f101'
const CHILD_ID = '00000000-0000-0000-0000-00000000f102'

test.describe('Document folder refresh', () => {
  test('creating a sidebar subfolder refreshes the open main-panel folder', async ({ page }) => {
    const parentFolder = {
      id: PARENT_ID,
      user_id: 'test-user',
      parent_id: null,
      name: 'Reports',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    const childFolder = {
      id: CHILD_ID,
      user_id: 'test-user',
      parent_id: PARENT_ID,
      name: 'Board Pack',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    const childFolders: typeof childFolder[] = []

    await page.route('**/folders/**/ancestors', route =>
      route.fulfill({ json: [{ id: PARENT_ID, name: parentFolder.name }] }),
    )

    await page.route('**/folders*', async (route, request) => {
      const url = new URL(request.url())

      if (request.method() === 'POST') {
        const body = request.postDataJSON() as { name: string; parent_id: string | null }
        childFolders.splice(0, childFolders.length, {
          ...childFolder,
          name: body.name,
          parent_id: body.parent_id,
        })
        return route.fulfill({ status: 200, json: childFolders[0] })
      }

      const parentId = url.searchParams.get('parent_id')
      if (parentId === PARENT_ID) return route.fulfill({ json: childFolders })
      return route.fulfill({ json: [parentFolder] })
    })

    await page.route('**/documents?*', route =>
      route.fulfill({ json: { documents: [], has_more: false, total_count: 0 } }),
    )

    await page.goto(`/documents/${PARENT_ID}`)

    await expect(page.getByRole('link', { name: parentFolder.name })).toBeVisible()
    await expect(page.getByTestId(`folder-card-${CHILD_ID}`)).toHaveCount(0)

    await page.getByRole('link', { name: parentFolder.name }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'New Subfolder' }).click()

    const input = page.locator('input').last()
    await input.fill(childFolder.name)
    await input.press('Enter')

    await expect(page.getByTestId(`folder-card-${CHILD_ID}`)).toBeVisible()
    await expect(page.getByTestId(`folder-card-${CHILD_ID}`)).toContainText(childFolder.name)
  })
})
