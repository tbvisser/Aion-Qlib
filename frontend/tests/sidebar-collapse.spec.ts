import { test, expect, type Page } from '@playwright/test'

async function expectRightClickOpens(page: Page, testId: string, urlPattern: RegExp) {
  const popupPromise = page.waitForEvent('popup')
  await page.getByTestId(testId).click({ button: 'right' })
  const popup = await popupPromise
  await expect(popup).toHaveURL(urlPattern)
  await popup.close()
}

test.describe('Sidebar collapse', () => {
  test.beforeEach(async ({ page }) => {
    // Start each test from a clean localStorage so default behavior holds.
    await page.goto('/chat')
    await page.evaluate(() => window.localStorage.removeItem('sidebar-collapsed'))
    await page.reload()
  })

  test('defaults to expanded for a fresh session', async ({ page }) => {
    await expect(page.getByTestId('sidebar-panel')).toBeVisible()
    await expect(page.getByTestId('sidebar-rail')).not.toBeVisible()
  })

  test('collapse persists across reload', async ({ page }) => {
    await page.getByTestId('sidebar-collapse').click()
    await expect(page.getByTestId('sidebar-rail')).toBeVisible()

    await page.reload()
    await expect(page.getByTestId('sidebar-rail')).toBeVisible()
    await expect(page.getByTestId('sidebar-panel')).not.toBeVisible()
  })

  test('collapse persists across page navigation', async ({ page }) => {
    await page.getByTestId('sidebar-collapse').click()
    await expect(page.getByTestId('sidebar-rail')).toBeVisible()

    await page.getByTestId('sidebar-nav-documents').click()
    await expect(page).toHaveURL(/\/documents/)
    await expect(page.getByTestId('sidebar-rail')).toBeVisible()

    await page.getByTestId('sidebar-nav-skills').click()
    await expect(page).toHaveURL(/\/skills/)
    await expect(page.getByTestId('sidebar-rail')).toBeVisible()
  })

  test('expand toggle reveals the panel without navigating', async ({ page }) => {
    await page.getByTestId('sidebar-collapse').click()
    await expect(page.getByTestId('sidebar-rail')).toBeVisible()

    const urlBefore = page.url()
    await page.getByTestId('sidebar-expand').click()
    await expect(page.getByTestId('sidebar-panel')).toBeVisible()
    expect(page.url()).toBe(urlBefore)
  })

  test('collapsed nav items are square and align with expanded rows', async ({ page }) => {
    await page.getByTestId('sidebar-collapse').click()
    await expect(page.getByTestId('sidebar-rail')).toBeVisible()

    const collapsedIconLeft: Record<string, number> = {}
    for (const key of ['chat', 'documents', 'skills']) {
      const itemBox = await page.getByTestId(`sidebar-nav-${key}`).boundingBox()
      const iconBox = await page.getByTestId(`sidebar-nav-${key}`).locator('svg').boundingBox()
      expect(itemBox).not.toBeNull()
      expect(iconBox).not.toBeNull()
      expect(Math.abs(itemBox!.width - 36)).toBeLessThanOrEqual(1)
      expect(Math.abs(itemBox!.height - 36)).toBeLessThanOrEqual(1)
      collapsedIconLeft[key] = iconBox!.x
    }

    await page.getByTestId('sidebar-expand').click()
    await expect(page.getByTestId('sidebar-panel')).toBeVisible()

    for (const key of ['chat', 'documents', 'skills']) {
      const expandedIconBox = await page.getByTestId(`sidebar-nav-${key}`).locator('svg').boundingBox()
      expect(expandedIconBox).not.toBeNull()
      expect(Math.abs(expandedIconBox!.x - collapsedIconLeft[key])).toBeLessThanOrEqual(1)
    }
  })

  test('section icons navigate between pages', async ({ page }) => {
    // Starts on /chat (per beforeEach)
    await page.getByTestId('sidebar-nav-documents').click()
    await expect(page).toHaveURL(/\/documents/)
    await expect(page.getByTestId('sidebar-nav-documents')).toHaveClass(/bg-accent/)

    await page.getByTestId('sidebar-nav-skills').click()
    await expect(page).toHaveURL(/\/skills/)
    await expect(page.getByTestId('sidebar-nav-skills')).toHaveClass(/bg-accent/)

    await page.getByTestId('sidebar-nav-chat').click()
    await expect(page).toHaveURL(/\/chat/)
    await expect(page.getByTestId('sidebar-nav-chat')).toHaveClass(/bg-accent/)
  })

  test('right-clicking the expanded sidebar logo opens chat in a new tab', async ({ page }) => {
    await expectRightClickOpens(page, 'sidebar-collapse', /\/chat$/)
    await expect(page.getByTestId('sidebar-panel')).toBeVisible()
  })

  test('right-clicking expanded sidebar routes opens each section in a new tab', async ({ page }) => {
    await expectRightClickOpens(page, 'sidebar-nav-chat', /\/chat$/)
    await expectRightClickOpens(page, 'sidebar-nav-documents', /\/documents$/)
    await expectRightClickOpens(page, 'sidebar-nav-skills', /\/skills$/)
  })

  test('right-clicking collapsed sidebar routes opens each section in a new tab', async ({ page }) => {
    await page.getByTestId('sidebar-collapse').click()
    await expect(page.getByTestId('sidebar-rail')).toBeVisible()

    await expectRightClickOpens(page, 'sidebar-nav-chat', /\/chat$/)
    await expectRightClickOpens(page, 'sidebar-nav-documents', /\/documents$/)
    await expectRightClickOpens(page, 'sidebar-nav-skills', /\/skills$/)
  })

  test('Chats icon navigates from documents while collapsed, then repeat click expands', async ({ page }) => {
    await page.getByTestId('sidebar-collapse').click()
    await page.getByTestId('sidebar-nav-documents').click()
    await expect(page).toHaveURL(/\/documents/)
    await expect(page.getByTestId('sidebar-rail')).toBeVisible()

    await page.getByTestId('sidebar-nav-chat').click()
    await expect(page).toHaveURL(/\/chat$/)
    // The cross-section click keeps the rail collapsed.
    await expect(page.getByTestId('sidebar-rail')).toBeVisible()
    await expect(page.getByTestId('sidebar-panel')).not.toBeVisible()
    await expect(page.getByRole('heading', { name: 'What can I help with?' })).toBeVisible()

    const chatUrl = page.url()
    await page.getByTestId('sidebar-nav-chat').click()
    await expect(page.getByTestId('sidebar-panel')).toBeVisible()
    await expect(page.getByTestId('sidebar-rail')).not.toBeVisible()
    expect(page.url()).toBe(chatUrl)
  })

  test('Documents icon navigates from chat while collapsed, then repeat click expands', async ({ page }) => {
    await page.getByTestId('sidebar-collapse').click()
    await expect(page.getByTestId('sidebar-rail')).toBeVisible()

    await page.getByTestId('sidebar-nav-documents').click()
    await expect(page).toHaveURL(/\/documents$/)
    await expect(page.getByTestId('sidebar-rail')).toBeVisible()
    await expect(page.getByTestId('sidebar-panel')).not.toBeVisible()

    const documentsUrl = page.url()
    await page.getByTestId('sidebar-nav-documents').click()
    await expect(page.getByTestId('sidebar-panel')).toBeVisible()
    await expect(page.getByTestId('sidebar-rail')).not.toBeVisible()
    expect(page.url()).toBe(documentsUrl)
  })

  test('collapsed Chats icon routes to the new-chat screen from an open thread', async ({ page }) => {
    // Create a thread (expanded panel) so we have a /chat/:id URL to leave.
    const newChatButton = page.getByRole('button', { name: /new chat/i }).first()
    test.skip(!(await newChatButton.isVisible().catch(() => false)), 'No new-chat affordance')
    await newChatButton.click()
    await expect(page).toHaveURL(/\/chat\/[a-f0-9-]+/)

    // Collapse the sidebar, then click the rail's Chats icon.
    await page.getByTestId('sidebar-collapse').click()
    await expect(page.getByTestId('sidebar-rail')).toBeVisible()
    await page.getByTestId('sidebar-nav-chat').click()

    // From the rail, Chats leaves the thread for the new-chat screen and
    // keeps the rail collapsed.
    await expect(page).toHaveURL(/\/chat$/)
    await expect(page.getByTestId('sidebar-rail')).toBeVisible()
    await expect(page.getByTestId('sidebar-panel')).not.toBeVisible()
    await expect(page.getByRole('heading', { name: 'What can I help with?' })).toBeVisible()

    const chatUrl = page.url()
    await page.getByTestId('sidebar-nav-chat').click()
    await expect(page.getByTestId('sidebar-panel')).toBeVisible()
    await expect(page.getByTestId('sidebar-rail')).not.toBeVisible()
    expect(page.url()).toBe(chatUrl)
  })

  test('expanded Chats icon is a no-op when already in the chat section', async ({ page }) => {
    // beforeEach lands us on /chat (welcome). Click Chats; URL must not change.
    await expect(page).toHaveURL(/\/chat$/)
    await page.getByTestId('sidebar-nav-chat').click()
    await expect(page).toHaveURL(/\/chat$/)

    // Open a thread (use the new-chat button so we get a thread URL), then
    // click Chats again; URL must stay on the thread.
    const newChatButton = page.getByRole('button', { name: /new chat/i }).first()
    if (await newChatButton.isVisible()) {
      await newChatButton.click()
      await expect(page).toHaveURL(/\/chat\/[a-f0-9-]+/)
      const threadUrl = page.url()

      await page.getByTestId('sidebar-nav-chat').click()
      expect(page.url()).toBe(threadUrl)
    }
  })

  test('skill tree expands to show files', async ({ page }) => {
    await page.goto('/skills')
    await page.waitForLoadState('networkidle')

    // Find the first skill row in the sidebar (skip if there are none).
    const allChevrons = page.locator('[data-testid^="skill-tree-toggle-"]')
    const hasSkills = await allChevrons.first().isVisible().catch(() => false)
    test.skip(!hasSkills, 'No skills exist — skipping tree test')

    // Click through chevrons until we find one with files (some skills may have none).
    const chevronCount = await allChevrons.count()
    let firstFile = page.locator('[data-testid^="skill-tree-file-"]').first()
    for (let i = 0; i < chevronCount; i++) {
      await allChevrons.nth(i).click()
      // Wait briefly for the async file-load to complete before checking
      await page.waitForTimeout(1500)
      const visible = await firstFile.isVisible().catch(() => false)
      if (visible) break
      // Collapse it back before trying the next one
      await allChevrons.nth(i).click()
    }

    // After expand, at least one file row should be visible.
    await expect(firstFile).toBeVisible({ timeout: 5000 })

    // Click the file — preview pane on the right should render it.
    await firstFile.click()
    await expect(page).toHaveURL(/\/skills\/[a-f0-9-]+/)
    // SkillFilePreview shows a heading with the filename.
    await expect(page.locator('[data-testid="skill-file-preview"]').or(page.getByText(/SKILL\.md|README/i))).toBeVisible()
  })
})
