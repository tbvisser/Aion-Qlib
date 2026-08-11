import { test, expect, type Page } from '@playwright/test'

const MOBILE = { width: 375, height: 812 }
const DESKTOP = { width: 1280, height: 900 }

// Read the live x-offset of the nav drawer panel. The drawer is always in the
// DOM on mobile and slides in/out via translateX, so position — not Playwright's
// visibility heuristic — is the reliable open/closed signal.
async function panelX(page: Page): Promise<number> {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="sidebar-panel"]')
    return el ? Math.round(el.getBoundingClientRect().left) : NaN
  })
}

test.describe('Mobile layout (375px)', () => {
  test.use({ viewport: MOBILE })

  test.beforeEach(async ({ page }) => {
    await page.goto('/chat')
    await page.evaluate(() => window.localStorage.removeItem('sidebar-collapsed'))
    await page.reload()
  })

  test('main content uses full width — no docked desktop sidebar', async ({ page }) => {
    // The inline desktop sidebar must not render below lg.
    await expect(page.getByTestId('sidebar')).toHaveCount(0)
    // The hamburger is the way in to navigation.
    await expect(page.getByTestId('mobile-nav-toggle')).toBeVisible()
    // The composer is full-width (was crushed to ~115px before the drawer).
    const box = await page.getByPlaceholder('Ask anything...').boundingBox()
    expect(box?.width ?? 0).toBeGreaterThan(300)
    // No horizontal page overflow.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
    expect(overflow).toBe(false)
  })

  test('hamburger opens the drawer; backdrop closes it', async ({ page }) => {
    // Wait for the mobile shell to mount, then confirm the drawer starts closed.
    await expect(page.getByTestId('mobile-nav-toggle')).toBeVisible()
    await expect.poll(() => panelX(page)).toBeLessThan(0) // closed initially
    await page.getByTestId('mobile-nav-toggle').click()
    await expect.poll(() => panelX(page)).toBe(0) // slid in
    await expect(page.getByTestId('sidebar-panel')).toBeVisible()

    await page.getByTestId('mobile-nav-backdrop').click({ position: { x: 350, y: 400 } })
    await expect.poll(() => panelX(page)).toBeLessThan(0) // slid back out
  })

  test('nav item navigates and closes the drawer', async ({ page }) => {
    await page.getByTestId('mobile-nav-toggle').click()
    await expect.poll(() => panelX(page)).toBe(0)

    await page.getByTestId('sidebar-nav-documents').click()
    await expect(page).toHaveURL(/\/documents/)
    await expect.poll(() => panelX(page)).toBeLessThan(0) // drawer auto-closed
  })

  test('documents page has no horizontal overflow', async ({ page }) => {
    await page.goto('/documents')
    await page.waitForLoadState('networkidle')
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
    expect(overflow).toBe(false)
    // Create action lives in the drawer (sidebar) on mobile.
    await page.getByTestId('mobile-nav-toggle').click()
    await expect(page.getByRole('button', { name: /add files/i })).toBeVisible()
  })

  test('folder row exposes a touch ⋯ menu (create → menu → delete)', async ({ page }) => {
    await page.goto('/documents')
    await page.waitForLoadState('networkidle')
    await page.getByTestId('mobile-nav-toggle').click()
    await expect.poll(() => panelX(page)).toBe(0)

    const name = `mtest-${Date.now()}`
    await page.getByRole('button', { name: /new folder/i }).click()
    const input = page.getByTestId('mobile-nav-drawer').locator('input[type="text"], input:not([type])').last()
    await input.fill(name)
    await input.press('Enter')

    const actions = page.getByRole('button', { name: `Actions for ${name}` })
    await expect(actions).toBeVisible()
    await actions.click() // real click dispatches pointerdown → Radix opens
    await expect(page.getByRole('menuitem', { name: 'Rename' })).toBeVisible()

    // Use the menu's Delete to verify the action wiring and clean up the folder.
    await page.getByRole('menuitem', { name: 'Delete' }).click()
    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Delete' }).click()
    await expect(page.getByRole('button', { name: `Actions for ${name}` })).toHaveCount(0)
  })
})

test.describe('Desktop layout unchanged (1280px)', () => {
  test.use({ viewport: DESKTOP })

  test('inline sidebar is docked and the mobile chrome is absent', async ({ page }) => {
    await page.goto('/chat')
    await page.evaluate(() => window.localStorage.removeItem('sidebar-collapsed'))
    await page.reload()

    await expect(page.getByTestId('sidebar')).toBeVisible()
    await expect(page.getByTestId('sidebar-panel')).toBeVisible()
    // The mobile top bar / drawer are gated behind lg — never visible on desktop.
    await expect(page.getByTestId('mobile-nav-toggle')).toBeHidden()
    await expect(page.getByTestId('mobile-nav-drawer')).toHaveCount(0)

    const sidebarBox = await page.getByTestId('sidebar-panel').boundingBox()
    expect(sidebarBox?.width).toBe(260)
    expect(Math.round(sidebarBox?.x ?? -1)).toBe(0)
  })
})
