import { test, expect } from '@playwright/test'

test.describe('Unauthenticated access', () => {
  test('redirects to /auth when not logged in', async ({ page }) => {
    await page.goto('/')
    await expect(page).toHaveURL(/\/auth/)
  })

  test('shows sign-in form', async ({ page }) => {
    await page.goto('/auth')
    await expect(page.getByLabel('Email')).toBeVisible()
    await expect(page.getByLabel('Password')).toBeVisible()
    await expect(page.getByRole('button', { name: /sign in/i })).toBeVisible()
  })

  test('shows error for invalid credentials', async ({ page }) => {
    await page.goto('/auth')
    await page.getByLabel('Email').fill('wrong@test.com')
    await page.getByLabel('Password').fill('wrongpassword')
    await page.getByRole('button', { name: /sign in/i }).click()

    await expect(page.getByText(/invalid/i)).toBeVisible()
  })

  test('protected route /documents redirects when not authenticated', async ({ page }) => {
    await page.goto('/documents')
    await expect(page).toHaveURL(/\/auth/)
  })
})
