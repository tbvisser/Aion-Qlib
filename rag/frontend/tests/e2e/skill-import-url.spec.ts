import { test, expect } from '@playwright/test'

// Drives the "Import from URL" dialog with the backend mocked, so the test does
// not depend on GitHub. Auth comes from the shared storageState (auth.setup.ts).

const IMPORTED_SKILL = {
  name: 'docx',
  success: true,
  skill_id: '11111111-1111-1111-1111-111111111111',
  error: null,
}

async function openImportDialog(page: import('@playwright/test').Page) {
  await page.goto('/skills')
  await page.getByRole('button', { name: /new skill/i }).click()
  await page.getByRole('menuitem', { name: /import from url/i }).click()
  // Dialog is open once its distinctive placeholder is present.
  await expect(
    page.getByPlaceholder('https://www.skills.sh/anthropics/skills/docx')
  ).toBeVisible()
}

test.describe('Import skill from URL', () => {
  test('successful import shows the confirmation banner', async ({ page }) => {
    await page.route('**/skills**', async (route) => {
      const req = route.request()
      const url = req.url()
      if (url.includes('/skills/import-from-url') && req.method() === 'POST') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ imported: 1, failed: 0, results: [IMPORTED_SKILL] }),
        })
        return
      }
      // Skill list — keep it empty so rendering is deterministic.
      if (req.method() === 'GET' && /\/skills(\?.*)?$/.test(url)) {
        await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
        return
      }
      await route.continue()
    })

    await openImportDialog(page)

    const post = page.waitForRequest(
      (r) => r.url().includes('/skills/import-from-url') && r.method() === 'POST'
    )
    await page.getByPlaceholder('https://www.skills.sh/anthropics/skills/docx')
      .fill('https://www.skills.sh/anthropics/skills/docx')
    await page.getByRole('button', { name: /^import$/i }).click()

    const req = await post
    expect(JSON.parse(req.postData() || '{}')).toMatchObject({
      source: 'https://www.skills.sh/anthropics/skills/docx',
    })

    await expect(page.getByText(/imported 1 skill/i)).toBeVisible()
  })

  test('a failed import surfaces the error inline and keeps the dialog open', async ({ page }) => {
    await page.route('**/skills**', async (route) => {
      const req = route.request()
      const url = req.url()
      if (url.includes('/skills/import-from-url') && req.method() === 'POST') {
        await route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({ detail: 'Repository or ref not found: foo/bar' }),
        })
        return
      }
      if (req.method() === 'GET' && /\/skills(\?.*)?$/.test(url)) {
        await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
        return
      }
      await route.continue()
    })

    await openImportDialog(page)

    const input = page.getByPlaceholder('https://www.skills.sh/anthropics/skills/docx')
    await input.fill('foo/bar')
    await page.getByRole('button', { name: /^import$/i }).click()

    // Error shown inside the dialog, and the dialog stays open (input still visible).
    await expect(page.getByText(/repository or ref not found/i)).toBeVisible()
    await expect(input).toBeVisible()
  })
})
