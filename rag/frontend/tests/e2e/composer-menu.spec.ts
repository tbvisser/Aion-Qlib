import { test, expect, type Page } from '@playwright/test'

// The composer "+" menu consolidates Upload files, Deep Mode, Contract Review,
// and Context statistics. These tests mock the backend so they're fast and
// deterministic (no live LLM).

const THREAD_ID = '00000000-0000-0000-0000-0000000005a1'
const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p94AAAAASUVORK5CYII='

type MockThreadOptions = {
  harness: unknown
  hasMessage?: boolean
  messages?: unknown[] | (() => unknown[])
  workspaceFiles?: unknown[] | (() => unknown[])
  onMessagePost?: (body: any) => void
}

function optionValue<T>(value: T[] | (() => T[]) | undefined, fallback: T[]): T[] {
  return typeof value === 'function' ? value() : (value ?? fallback)
}

function stubThreadList(page: Page, now: string) {
  return page.route('**/threads?*', route => route.fulfill({
    json: {
      threads: [{ id: THREAD_ID, user_id: 'test-user', title: 'Composer menu', created_at: now, updated_at: now }],
      total_count: 1,
      has_more: false,
    },
  }))
}

// Stand up a thread; pass a harness run to simulate a committed Contract Review.
async function mockThread(
  page: Page,
  opts: MockThreadOptions = { harness: null },
) {
  const now = new Date().toISOString()
  const defaultMessages = opts.hasMessage
    ? [{ id: 'msg-1', thread_id: THREAD_ID, user_id: 'test-user', role: 'assistant', content: 'Hello there.', created_at: now }]
    : []

  await stubThreadList(page, now)
  await page.route(`**/threads/${THREAD_ID}`, route => route.fulfill({
    json: { id: THREAD_ID, user_id: 'test-user', title: 'Composer menu', created_at: now, updated_at: now },
  }))
  await page.route(`**/threads/${THREAD_ID}/todos`, route => route.fulfill({ json: [] }))
  await page.route(`**/threads/${THREAD_ID}/files`, route => route.fulfill({
    json: optionValue(opts.workspaceFiles, []),
  }))
  await page.route(`**/threads/${THREAD_ID}/harness`, route => route.fulfill({ json: opts.harness }))
  await page.route(`**/threads/${THREAD_ID}/compactions`, route => route.fulfill({ json: [] }))
  await page.route(`**/threads/${THREAD_ID}/messages`, route => {
    if (route.request().method() === 'POST') {
      opts.onMessagePost?.(route.request().postDataJSON())
      return route.fulfill({
        headers: { 'content-type': 'text/event-stream' },
        body: 'event: done\ndata: {}\n\n',
      })
    }
    return route.fulfill({
      json: optionValue(opts.messages, defaultMessages),
    })
  })
}

async function dispatchFileDragEvent(
  page: Page,
  eventType: 'dragenter' | 'drop',
  filename = 'drop-notes.txt',
  contentType = 'text/plain',
) {
  await page.evaluate(({ eventType, filename, contentType }) => {
    const file = new File(['hello from drop'], filename, { type: contentType })
    const event = new Event(eventType, {
      bubbles: true,
      cancelable: true,
    })
    Object.defineProperty(event, 'dataTransfer', {
      value: {
        dropEffect: 'copy',
        files: [file],
        items: [{ kind: 'file' }],
        types: ['Files'],
      },
    })
    window.dispatchEvent(event)
  }, { eventType, filename, contentType })
}

test.describe('Composer "+" menu', () => {
  test('welcome screen exposes upload + modes, but not context statistics', async ({ page }) => {
    const now = new Date().toISOString()
    await stubThreadList(page, now)

    await page.goto('/')
    await page.getByRole('button', { name: /new chat/i }).click()

    await page.getByRole('button', { name: 'Add to chat' }).first().click()

    await expect(page.getByRole('menuitem', { name: /upload files/i })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: /deep mode/i })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: /contract review/i })).toBeVisible()
    // No token usage yet on the welcome screen → no context stats item
    await expect(page.getByRole('menuitem', { name: /context statistics/i })).toHaveCount(0)
  })

  test('upload is available in a normal (non-harness) thread', async ({ page }) => {
    await mockThread(page, { harness: null, hasMessage: true })
    await page.goto(`/chat/${THREAD_ID}`)

    await page.getByRole('button', { name: 'Add to chat' }).first().click()

    // Upload is no longer gated behind harness mode
    await expect(page.getByRole('menuitem', { name: /upload files/i })).toBeVisible()
    // Contract Review is offered (not locked) since no run exists
    await expect(page.getByRole('menuitem', { name: /structured analysis workflow/i })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: /active for this thread/i })).toHaveCount(0)
  })

  test('dropping a file into an existing thread stages it in the composer', async ({ page }) => {
    let uploadCount = 0
    await mockThread(page, { harness: null, hasMessage: true })
    await page.route(`**/threads/${THREAD_ID}/files/upload`, async route => {
      uploadCount += 1
      await route.fulfill({
        status: 201,
        json: {
          id: 'drop-file',
          file_path: 'uploads/drop-notes.txt',
          content_type: 'text/plain',
          size_bytes: 15,
          storage_path: null,
        },
      })
    })

    await page.goto(`/chat/${THREAD_ID}`)
    await expect(page.locator('textarea[placeholder="Ask anything..."]').last()).toBeVisible()
    await page.waitForTimeout(100)

    await dispatchFileDragEvent(page, 'drop')

    await expect(page.getByTestId('chat-file-drop-overlay')).toHaveCount(0)
    await expect(page.getByTestId('pending-attachment')).toBeVisible()
    await expect(page.getByText('drop-notes.txt')).toBeVisible()
    await expect.poll(() => uploadCount).toBe(0)
  })

  test('dropping a file into the welcome composer stages it for a new thread', async ({ page }) => {
    const now = new Date().toISOString()
    await stubThreadList(page, now)

    await page.goto('/chat')
    await expect(page.locator('textarea[placeholder="Ask anything..."]').last()).toBeVisible()
    await page.waitForTimeout(100)

    await dispatchFileDragEvent(page, 'drop', 'welcome-drop.md', 'text/markdown')

    await expect(page.getByTestId('chat-file-drop-overlay')).toHaveCount(0)
    await expect(page.getByTestId('pending-attachment')).toBeVisible()
    await expect(page.getByText('welcome-drop.md')).toBeVisible()
  })

  test('pasting an image stages it, then sends it as a workspace attachment', async ({ page }) => {
    const now = new Date().toISOString()
    let messageBody: any = null
    const uploadedFile = {
      id: 'pasted-image-file',
      file_path: 'uploads/pasted-image-test.png',
      content_type: 'image/png',
      size_bytes: 4,
      source: 'upload',
      storage_path: `${THREAD_ID}/pasted-image-test.png`,
      created_at: now,
      updated_at: now,
    }
    let workspaceFiles: unknown[] = []
    let messages: unknown[] = [
      { id: 'msg-1', thread_id: THREAD_ID, user_id: 'test-user', role: 'assistant', content: 'Hello there.', created_at: now },
    ]
    await mockThread(page, {
      harness: null,
      workspaceFiles: () => workspaceFiles,
      messages: () => messages,
      onMessagePost: (body) => {
        messageBody = body
        workspaceFiles = [uploadedFile]
        messages = [
          ...messages,
          {
            id: 'user-with-attachment',
            thread_id: THREAD_ID,
            user_id: 'test-user',
            role: 'user',
            content: body.content,
            attachments: [{
              file_path: 'uploads/pasted-image-test.png',
              content_type: 'image/png',
              size_bytes: 4,
              source: 'upload',
            }],
            created_at: new Date().toISOString(),
          },
        ]
      },
    })

    let uploadCount = 0
    await page.route(`**/threads/${THREAD_ID}/files/upload`, async route => {
      uploadCount += 1
      const request = route.request()
      expect(request.headers()['content-type']).toContain('multipart/form-data')
      const body = request.postDataBuffer()?.toString('utf-8') ?? ''
      expect(body).toContain('filename="pasted-image-')
      expect(body).toContain('Content-Type: image/png')
      await route.fulfill({
        status: 201,
        json: {
          id: 'pasted-image-file',
          file_path: 'uploads/pasted-image-test.png',
          content_type: 'image/png',
          size_bytes: 4,
          storage_path: `${THREAD_ID}/pasted-image-test.png`,
        },
      })
    })
    await page.route(
      url => url.pathname.endsWith(`/threads/${THREAD_ID}/files/uploads/pasted-image-test.png`)
        && url.searchParams.get('download') === 'true',
      route => route.fulfill({ json: { url: `data:image/png;base64,${TINY_PNG_BASE64}` } }),
    )

    await page.goto(`/chat/${THREAD_ID}`)

    await page.locator('textarea[placeholder="Ask anything..."]').last().evaluate((textarea, pngBase64) => {
      const dataTransfer = new DataTransfer()
      const bytes = Uint8Array.from(atob(pngBase64), (char) => char.charCodeAt(0))
      dataTransfer.items.add(new File(
        [bytes],
        'image.png',
        { type: 'image/png' },
      ))
      textarea.dispatchEvent(new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: dataTransfer,
      }))
    }, TINY_PNG_BASE64)

    await expect(page.getByTestId('pending-attachment')).toBeVisible()
    await expect.poll(() => uploadCount).toBe(0)
    await expect(page.getByTestId('workspace-file-uploads/pasted-image-test.png')).toHaveCount(0)

    await page.locator('textarea[placeholder="Ask anything..."]').last().fill('What is in this screenshot?')
    await page.getByRole('button', { name: 'Send message' }).last().click()

    await expect.poll(() => uploadCount).toBe(1)
    await expect.poll(() => messageBody).toMatchObject({
      content: 'What is in this screenshot?',
      attachment_file_paths: ['uploads/pasted-image-test.png'],
    })
    await expect(page.getByTestId('pending-attachment')).toHaveCount(0)
    await expect(page.locator('img[alt^="pasted-image-"]').last()).toBeVisible()
    await expect(page.getByTestId('workspace-file-uploads/pasted-image-test.png')).toBeVisible()

    await page.reload()

    await expect(page.getByText('What is in this screenshot?')).toBeVisible()
    await expect(page.locator('img[alt="pasted-image-test.png"]')).toBeVisible()
  })

  test('contract review is locked once a run is committed to the thread', async ({ page }) => {
    await mockThread(page, {
      harness: {
        id: 'run-1',
        thread_id: THREAD_ID,
        harness_type: 'contract_review',
        status: 'running',
        current_phase: 0,
        phases: [],
      },
    })
    await page.goto(`/chat/${THREAD_ID}`)

    // The active-mode chip reflects the committed harness and offers no clear button
    await expect(page.getByText('Contract Review')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Turn off Contract Review' })).toHaveCount(0)

    // In the menu, Contract Review is marked active/locked and Deep Mode is disabled
    await page.getByRole('button', { name: 'Add to chat' }).first().click()
    await expect(page.getByRole('menuitem', { name: /active for this thread/i })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: /deep mode/i })).toBeDisabled()
  })
})
