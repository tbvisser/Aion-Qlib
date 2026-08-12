import { test, expect } from '@playwright/test'

const THREAD_ID = '00000000-0000-0000-0000-0000000000a7'
const DOC_TITLE = 'sample-legal-brief-full.pdf'

const LONG_ANALYSIS = Array.from({ length: 40 }, (_, idx) => {
  const section = idx + 1
  return [
    `## Section ${section}`,
    '',
    `This is analysis paragraph ${section}. It has enough text to create a tall document-analysis result with multiple headings and paragraphs in the sub-agent output area.`,
  ].join('\n')
}).join('\n\n')

test.describe('Sub-agent panel', () => {
  test('caps long analyze document output and makes it scrollable', async ({ page }) => {
    const now = new Date().toISOString()
    const thread = {
      id: THREAD_ID,
      user_id: 'test-user',
      title: 'Analyze document output',
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
      json: [
        {
          id: 'user-analyze-1',
          thread_id: THREAD_ID,
          user_id: 'test-user',
          role: 'user',
          content: `Analyze ${DOC_TITLE}`,
          created_at: now,
        },
        {
          id: 'assistant-analyze-1',
          thread_id: THREAD_ID,
          user_id: 'test-user',
          role: 'assistant',
          content: '',
          created_at: now,
          tool_calls: [
            {
              tool_name: 'analyze_document',
              arguments: JSON.stringify({ document_id: 'doc-analyze', query: 'summarize' }),
              status: 'completed',
              result_summary: DOC_TITLE,
              sub_agent_state: {
                active: false,
                mode: 'analyze',
                documentId: 'doc-analyze',
                filename: DOC_TITLE,
                reasoning: '',
                result: LONG_ANALYSIS,
                status: 'completed',
              },
            },
          ],
        },
      ],
    }))

    await page.goto(`/chat/${THREAD_ID}`)

    await expect(page.getByRole('button', { name: `Analyzing: ${DOC_TITLE}` })).toBeVisible()

    const output = page.getByLabel(`Analyzing: ${DOC_TITLE} output`)
    await expect(output).toBeVisible()

    const metrics = await output.evaluate((el) => {
      const htmlEl = el as HTMLElement
      const styles = getComputedStyle(htmlEl)
      htmlEl.scrollTop = htmlEl.scrollHeight
      return {
        clientHeight: htmlEl.clientHeight,
        maxHeight: styles.maxHeight,
        overflowY: styles.overflowY,
        scrollHeight: htmlEl.scrollHeight,
        scrollTop: htmlEl.scrollTop,
        tabIndex: htmlEl.tabIndex,
      }
    })

    expect(metrics.overflowY).toBe('auto')
    expect(metrics.maxHeight).not.toBe('none')
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight)
    expect(metrics.scrollTop).toBeGreaterThan(0)
    expect(metrics.tabIndex).toBe(0)
  })
})
