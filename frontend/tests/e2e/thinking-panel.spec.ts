import { test, expect } from '@playwright/test'

const THREAD_ID = '00000000-0000-0000-0000-0000000000c3'
const HARNESS_THREAD_ID = '00000000-0000-0000-0000-0000000000c4'
const STREAM_THREAD_ID = '00000000-0000-0000-0000-0000000000c5'
const HEADLINE = 'Developing a creative response'
const BODY = 'I should focus on answering creatively without relying on any tools.'

test.describe('Thinking panel', () => {
  test('uses a leading thinking headline as the panel title', async ({ page }) => {
    const now = new Date().toISOString()
    const thread = {
      id: THREAD_ID,
      user_id: 'test-user',
      title: 'Thinking headline',
      created_at: now,
      updated_at: now,
    }

    await page.route('**/threads?*', route => route.fulfill({
      json: {
        threads: [thread],
        total_count: 1,
        has_more: false,
      },
    }))
    await page.route('**/settings/public', route => route.fulfill({ json: { context_window: 200000 } }))
    await page.route(`**/threads/${THREAD_ID}`, route => route.fulfill({ json: thread }))
    await page.route(`**/threads/${THREAD_ID}/todos`, route => route.fulfill({ json: [] }))
    await page.route(`**/threads/${THREAD_ID}/files`, route => route.fulfill({ json: [] }))
    await page.route(`**/threads/${THREAD_ID}/harness`, route => route.fulfill({ json: null }))
    await page.route(`**/threads/${THREAD_ID}/compactions`, route => route.fulfill({ json: [] }))
    await page.route(`**/threads/${THREAD_ID}/messages`, route => route.fulfill({
      json: [{
        id: 'assistant-thinking-1',
        thread_id: THREAD_ID,
        user_id: 'test-user',
        role: 'assistant',
        content: `<think>**${HEADLINE}**\n\n${BODY}</think>Once, in a town where the moon rose late...`,
        created_at: now,
      }],
    }))

    await page.goto(`/chat/${THREAD_ID}`)

    const panel = page.getByRole('button', { name: new RegExp(HEADLINE) })
    await expect(panel).toBeVisible({ timeout: 10_000 })
    await expect(panel).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByText('Thought process')).toHaveCount(0)
    await expect(page.getByTestId('thinking-body')).toHaveCount(0)

    await panel.click()
    await expect(panel).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByTestId('thinking-body')).toContainText(BODY)
    await expect(page.getByTestId('thinking-body')).not.toContainText(`**${HEADLINE}**`)
  })

  test('does not show raw think tags when final citation metadata replaces streamed text', async ({ page }) => {
    const now = new Date().toISOString()
    const headline = 'Clarifying regulatory explanation'
    const privateThought = 'I need to simplify the FIA 2026 regulations in plain terms.'
    const visibleAnswer = 'Based on the KB, the plank assembly is the regulated underside wear assembly {[S1]}.'
    const finalAnswer = `<think>**${headline}**\n\n${privateThought}</think>${visibleAnswer}`
    const thread = {
      id: STREAM_THREAD_ID,
      user_id: 'test-user',
      title: 'Streaming think metadata',
      created_at: now,
      updated_at: now,
    }
    const citation = {
      citation_id: 'cite-think-final',
      answer_id: 'assistant-final-1',
      display_ref: '{[S1]}',
      display_number: 1,
      source: {
        source_id: 'doc-think-final',
        source_type: 'document',
        title: 'FIA 2026 Regulations.pdf',
        document_id: '00000000-0000-0000-0000-0000000000d1',
        content_type: 'application/pdf',
      },
      target: { kind: 'text_quote', exact: 'plank assembly' },
      quote: 'plank assembly',
      status: 'not_verified',
    }

    await page.route('**/threads?*', route => route.fulfill({
      json: {
        threads: [thread],
        total_count: 1,
        has_more: false,
      },
    }))
    await page.route('**/settings/public', route => route.fulfill({ json: { context_window: 200000 } }))
    await page.route(`**/threads/${STREAM_THREAD_ID}`, route => route.fulfill({ json: thread }))
    await page.route(`**/threads/${STREAM_THREAD_ID}/todos`, route => route.fulfill({ json: [] }))
    await page.route(`**/threads/${STREAM_THREAD_ID}/files`, route => route.fulfill({ json: [] }))
    await page.route(`**/threads/${STREAM_THREAD_ID}/harness`, route => route.fulfill({ json: null }))
    await page.route(`**/threads/${STREAM_THREAD_ID}/compactions`, route => route.fulfill({ json: [] }))
    await page.route(`**/threads/${STREAM_THREAD_ID}/messages`, route => {
      if (route.request().method() === 'POST') {
        const body = [
          `data: ${JSON.stringify({ content: `<think>**${headline}**\n\n${privateThought}</think>` })}\n\n`,
          `data: ${JSON.stringify({ content: visibleAnswer })}\n\n`,
          `data: ${JSON.stringify({
            type: 'citation_metadata',
            message_id: 'assistant-final-1',
            verification_mode: 'unverified',
            answer_text: finalAnswer,
            citations: [citation],
          })}\n\n`,
          'event: done\ndata: {}\n\n',
        ].join('')
        return route.fulfill({ status: 200, contentType: 'text/event-stream', body })
      }
      return route.fulfill({ json: [] })
    })

    await page.goto(`/chat/${STREAM_THREAD_ID}`)
    await page.getByPlaceholder(/ask anything/i).fill('What is the plank assembly?')
    await page.getByPlaceholder(/ask anything/i).press('Enter')

    await expect(page.getByRole('button', { name: new RegExp(headline) })).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('.prose').filter({ hasText: 'regulated underside wear assembly' })).toBeVisible()
    await expect(page.locator('.prose')).not.toContainText('<think>')
    await expect(page.locator('.prose')).not.toContainText('</think>')
  })

  test('strips think tags from harness phase markdown output', async ({ page }) => {
    const now = new Date().toISOString()
    const thread = {
      id: HARNESS_THREAD_ID,
      user_id: 'test-user',
      title: 'Harness phase thinking',
      created_at: now,
      updated_at: now,
    }
    const privateThought = 'This should stay out of the printed phase output.'
    const visibleResult = 'The phase result is ready.'

    await page.route('**/threads?*', route => route.fulfill({
      json: {
        threads: [thread],
        total_count: 1,
        has_more: false,
      },
    }))
    await page.route('**/settings/public', route => route.fulfill({ json: { context_window: 200000 } }))
    await page.route(`**/threads/${HARNESS_THREAD_ID}`, route => route.fulfill({ json: thread }))
    await page.route(`**/threads/${HARNESS_THREAD_ID}/todos`, route => route.fulfill({ json: [] }))
    await page.route(`**/threads/${HARNESS_THREAD_ID}/files`, route => route.fulfill({ json: [] }))
    await page.route(`**/threads/${HARNESS_THREAD_ID}/compactions`, route => route.fulfill({ json: [] }))
    await page.route(`**/threads/${HARNESS_THREAD_ID}/harness`, route => route.fulfill({
      json: {
        id: 'harness-thinking-1',
        thread_id: HARNESS_THREAD_ID,
        harness_type: 'contract_review',
        status: 'completed',
        current_phase: 1,
        phases: [{
          index: 0,
          name: 'Gathering FIA 2026 F1 Regulations',
          description: 'Gather relevant sources',
          status: 'completed',
          result_markdown: `<think>**Gathering FIA 2026 F1 Regulations**\n\n${privateThought}</think>${visibleResult}`,
          tool_calls: [],
          phase_type: 'llm_agent',
        }],
      },
    }))
    await page.route(`**/threads/${HARNESS_THREAD_ID}/messages`, route => route.fulfill({
      json: [{
        id: 'assistant-harness-1',
        thread_id: HARNESS_THREAD_ID,
        user_id: 'test-user',
        role: 'assistant',
        content: 'Done.',
        created_at: now,
        harness_phases_before: [0],
      }],
    }))

    await page.goto(`/chat/${HARNESS_THREAD_ID}`)

    const phaseButton = page.getByRole('button', { name: /Gathering FIA 2026 F1 Regulations/i })
    await expect(phaseButton).toBeVisible({ timeout: 10_000 })
    await phaseButton.click()
    await expect(page.getByText(visibleResult)).toBeVisible()
    await expect(page.getByText('<think>', { exact: false })).toHaveCount(0)
    await expect(page.getByText('</think>', { exact: false })).toHaveCount(0)
    await expect(page.getByText(privateThought)).toHaveCount(0)
  })
})
