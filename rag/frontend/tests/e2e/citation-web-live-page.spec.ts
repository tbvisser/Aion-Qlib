import { test, expect } from '@playwright/test'

const THREAD_ID = '00000000-0000-0000-0000-000000000144'
const SOURCE_ID = 'web_citation_snapshots'
const PDF_SOURCE_ID = 'web_fia_pdf'
const LIVE_URL = 'https://www.forbes.com/citation-snapshots'
const PDF_URL = 'https://www.fia.com/sites/default/files/fia_formula_one_regulations.pdf'
const SNAPSHOT_FETCHED_AT = '2026-06-04T10:15:00+00:00'
const CITED = 'The snapshot is the exact text the model was shown when it generated the answer.'
const PDF_CITED = 'The plank assembly must comply with the dimensional requirements.'

test.describe('Web citation preview', () => {
  test('defaults to rendered snapshot and can switch to live page iframe', async ({ page }) => {
    const now = new Date().toISOString()

    await page.route('**/settings/public', route => route.fulfill({ json: { context_window: 128000 } }))
    await page.route('**/threads?*', route => route.fulfill({
      json: {
        threads: [{ id: THREAD_ID, user_id: 'test-user', title: 'Web citation', created_at: now, updated_at: now }],
        total_count: 1,
        has_more: false,
      },
    }))
    await page.route(`**/threads/${THREAD_ID}`, route => route.fulfill({
      json: { id: THREAD_ID, user_id: 'test-user', title: 'Web citation', created_at: now, updated_at: now },
    }))
    await page.route(`**/threads/${THREAD_ID}/todos`, route => route.fulfill({ json: [] }))
    await page.route(`**/threads/${THREAD_ID}/files`, route => route.fulfill({ json: [] }))
    await page.route(`**/threads/${THREAD_ID}/harness`, route => route.fulfill({ json: null }))
    await page.route(`**/threads/${THREAD_ID}/messages`, route => route.fulfill({
      json: [
        {
          id: 'msg-1',
          thread_id: THREAD_ID,
          user_id: 'test-user',
          role: 'assistant',
          content: 'Citation snapshots preserve the cited text {[S1]}. PDFs open outside the iframe {[S2]}.',
          created_at: now,
          verification_mode: 'unverified',
          citations: [
            {
              citation_id: 'cite_web_snapshot',
              answer_id: 'msg-1',
              display_ref: '{[S1]}',
              display_number: 1,
              source: {
                source_id: SOURCE_ID,
                source_type: 'web',
                title: 'How citation snapshots work',
                uri: LIVE_URL,
                content_type: 'text/html',
              },
              target: { kind: 'text_quote', exact: CITED },
              quote: CITED,
              status: 'not_verified',
            },
            {
              citation_id: 'cite_web_pdf',
              answer_id: 'msg-1',
              display_ref: '{[S2]}',
              display_number: 2,
              source: {
                source_id: PDF_SOURCE_ID,
                source_type: 'web',
                title: 'FIA Formula One Regulations PDF',
                uri: PDF_URL,
                content_type: 'application/pdf',
              },
              target: { kind: 'text_quote', exact: PDF_CITED },
              quote: PDF_CITED,
              status: 'not_verified',
            },
          ],
          claim_states: [],
        },
      ],
    }))
    await page.route(`**/citations/web-source/${SOURCE_ID}`, route => route.fulfill({
      json: {
        content_type: 'text/markdown',
        uri: LIVE_URL,
        fetched_at: SNAPSHOT_FETCHED_AT,
        content: [
          '# How citation snapshots keep AI answers honest',
          '',
          'A growing number of AI products now store a point-in-time copy of every page they read.',
          '',
          CITED,
        ].join('\n\n'),
      },
    }))
    await page.route(`**/citations/web-source/${PDF_SOURCE_ID}`, route => route.fulfill({
      json: {
        content_type: 'text/markdown',
        uri: PDF_URL,
        fetched_at: SNAPSHOT_FETCHED_AT,
        content: `# FIA Formula One Regulations\n\n${PDF_CITED}`,
      },
    }))

    await page.goto(`/chat/${THREAD_ID}`)
    await page.getByRole('button', { name: /Citation 1: How citation snapshots work/i }).click()

    const panel = page.locator('[data-testid="citation-source-panel"]:visible')
    await expect(panel).toBeVisible()
    await expect(panel.getByRole('button', { name: 'Snapshot' })).toHaveAttribute('aria-pressed', 'true')
    await expect(panel.getByRole('button', { name: 'Live page' })).toHaveAttribute('aria-pressed', 'false')
    await expect(panel.getByText(/Snapshot captured/i)).toBeVisible()
    await expect(panel.getByRole('group', { name: 'View mode' })).toHaveCount(0)
    await expect(panel.getByRole('link', { name: /Open in new tab/i })).toHaveAttribute('href', LIVE_URL)
    await expect(panel.getByRole('heading', { name: /How citation snapshots keep AI answers honest/i })).toBeVisible()
    await expect(panel.locator('mark[data-citation-target="active"]').first()).toContainText('snapshot is the exact text')

    await panel.getByRole('button', { name: 'Live page' }).click()
    await expect(panel.getByRole('button', { name: 'Live page' })).toHaveAttribute('aria-pressed', 'true')
    await expect(panel.getByTestId('web-live-iframe')).toHaveAttribute('src', LIVE_URL)

    await page.getByRole('button', { name: /Citation 2: FIA Formula One Regulations PDF/i }).click()
    await expect(panel.getByRole('button', { name: 'Snapshot' })).toHaveAttribute('aria-pressed', 'true')
    await panel.getByRole('button', { name: 'Live page' }).click()
    await expect(panel.getByText('PDF live previews are usually blocked by Chrome.')).toBeVisible()
    await expect(panel.getByTestId('web-live-iframe')).toHaveCount(0)
    await expect(panel.locator(`a[href="${PDF_URL}"]`).last()).toHaveText(/Open in new tab/)
  })
})
