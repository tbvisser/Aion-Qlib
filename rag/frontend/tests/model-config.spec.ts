import { test, expect, type Page } from '@playwright/test'

// Composer "Model" config (Plan 13): a model-name + thinking/effort selector in
// the "+" menu, persisted globally in localStorage and sent with each message.
// Runs authenticated (chromium project reuses stored auth state) — no manual login.
test.describe('Composer model config', () => {
  test.beforeEach(async ({ page }) => {
    // Start from a clean config so the "server default" baseline holds.
    await page.goto('/chat')
    await page.evaluate(() => window.localStorage.removeItem('modelConfig'))
    await page.reload()
  })

  async function openModelDialog(page: Page) {
    await page.getByRole('button', { name: 'Add to chat' }).click()
    await page.getByTestId('composer-model-item').click()
    await expect(page.locator('#model-name')).toBeVisible()
  }

  test('model + thinking selection persists across reload', async ({ page }) => {
    await openModelDialog(page)

    await page.locator('#model-name').fill('openai/gpt-4o-mini')
    await page.locator('#thinking-toggle').click()
    // Effort selector only appears once thinking is on.
    await expect(page.getByTestId('model-effort-high')).toBeVisible()
    await page.getByTestId('model-effort-high').click()
    await page.getByTestId('model-config-save').click()

    // Persisted to the global localStorage key.
    const stored = await page.evaluate(() => window.localStorage.getItem('modelConfig'))
    expect(JSON.parse(stored as string)).toEqual({
      model: 'openai/gpt-4o-mini',
      thinking: true,
      reasoningEffort: 'high',
    })

    // Survives a reload and is reflected in the menu subtitle.
    await page.reload()
    await page.getByRole('button', { name: 'Add to chat' }).click()
    const item = page.getByTestId('composer-model-item')
    await expect(item).toContainText('openai/gpt-4o-mini')
    await expect(item).toContainText('thinking high')
  })

  test('blank model name shows the server-default baseline', async ({ page }) => {
    await page.getByRole('button', { name: 'Add to chat' }).click()
    await expect(page.getByTestId('composer-model-item')).toContainText('Server default')
  })

  test('sends model + thinking + reasoning_effort in the message request', async ({ page }) => {
    // Seed the config directly — the composer reads localStorage at send time.
    await page.evaluate(() =>
      window.localStorage.setItem(
        'modelConfig',
        JSON.stringify({ model: 'openai/gpt-4o-mini', thinking: true, reasoningEffort: 'high' }),
      ),
    )
    await page.reload()

    // Intercept the message POST and stub a minimal SSE so we don't hit the LLM.
    let body: Record<string, unknown> | null = null
    await page.route('**/threads/*/messages', async (route) => {
      body = JSON.parse(route.request().postData() || '{}')
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body:
          'data: {"type":"text_delta","content":"ok"}\n\n' +
          'data: {"type":"response_completed","content":"ok"}\n\n',
      })
    })

    const composer = page.getByPlaceholder('Ask anything...')
    await composer.fill('hello there')
    await composer.press('Enter')

    await expect.poll(() => body, { timeout: 15_000 }).not.toBeNull()
    expect(body!.model).toBe('openai/gpt-4o-mini')
    expect(body!.thinking).toBe(true)
    expect(body!.reasoning_effort).toBe('high')
  })

  test('populates the model dropdown from the provider list', async ({ page }) => {
    await page.route('**/settings/models', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          provider: 'openrouter',
          models: [{ id: 'anthropic/claude-3.5-sonnet' }, { id: 'openai/gpt-4o' }],
        }),
      })
    })

    await openModelDialog(page)

    // Helper text reflects the provider + count, and the datalist holds the ids.
    await expect(page.getByText(/2 openrouter models available/i)).toBeVisible()
    await expect(page.locator('#model-options option')).toHaveCount(2)
    await expect(page.locator('#model-options option[value="openai/gpt-4o"]')).toHaveCount(1)
  })

  test('falls back to free-text when the model list is unavailable', async ({ page }) => {
    await page.route('**/settings/models', (route) => route.fulfill({ status: 500, body: '{}' }))

    await openModelDialog(page)

    await expect(page.getByText(/type a model name manually/i)).toBeVisible()
    // The input still works as free text.
    await page.locator('#model-name').fill('my/custom-model')
    await page.getByTestId('model-config-save').click()
    const stored = await page.evaluate(() => window.localStorage.getItem('modelConfig'))
    expect(JSON.parse(stored as string).model).toBe('my/custom-model')
  })
})
