import { test, expect } from '@playwright/test'

const THREAD_ID = '00000000-0000-0000-0000-000000000133'
const DOC_ID = '00000000-0000-0000-0000-000000000234'
const CITATION_ID = 'cite_md_table_highlight'

// What the model cited: the span the smart chunker produced for a split table
// section. It opens with a SYNTHETIC "(Part 3)" heading (the chunker injects it
// per continuation chunk; it does not exist in the source) and runs straight
// into the start of table row 4, cut off mid-cell at "…Ms.".
const CITED = [
  '## Evaluation answer key (⚠ spoilers) (Part 3)',
  '',
  '| 4 | `42 U.S.C. § 1983(c)` | Appended to "…Bradley Griffith settled with Ms.',
].join('\n')

// The ORIGINAL document markdown (what /render returns as full_markdown). The
// heading has no "(Part N)" label, row 4 sits below a real table header and
// rows 1-3, and the "Note the hardest one" paragraph follows the table with no
// heading between — so neither cited span is contiguous as stored.
const SOURCE_MARKDOWN = [
  '# Sample documents',
  '',
  '## Evaluation answer key (⚠ spoilers)',
  '',
  '| # | statute | appended | note | flag |',
  '|---|---------|----------|------|------|',
  '| 1 | first | a | foo | ok |',
  '| 2 | second | b | bar | ok |',
  '| 3 | third | c | baz | ok |',
  '| 4 | `42 U.S.C. § 1983(c)` | Appended to "…Bradley Griffith settled with Ms. Latiolais." | § 1983 is real but has **no subsection (c)** — miscited | flagged — **miscited** |',
  '',
  "**Note the hardest one — #4.** It's a *real* statute with a fabricated subsection, the kind of “swallowed fabrication” an auditor most easily waves through as “verified.” Catching it is the job of the **adjudicator** (Phase 3), not the output gate — the gate doesn't ground-check verdicts.",
].join('\n')

// Regression: a citation whose span begins with the chunker's synthetic
// "(Part N)" heading and then a table row must still highlight in the rendered
// markdown. The highlighter strips the synthetic label and the leading heading
// line, then matches the flattened table row against the rendered <table>.
test.describe('Citation markdown table highlight', () => {
  test('highlights a table-row span that opens with a synthetic Part heading', async ({ page }) => {
    const now = new Date().toISOString()

    await page.route('**/threads?*', route => route.fulfill({
      json: {
        threads: [{ id: THREAD_ID, user_id: 'test-user', title: 'MD citation', created_at: now, updated_at: now }],
        total_count: 1,
        has_more: false,
      },
    }))
    await page.route(`**/threads/${THREAD_ID}`, route => route.fulfill({
      json: { id: THREAD_ID, user_id: 'test-user', title: 'MD citation', created_at: now, updated_at: now },
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
          content: 'Row four is miscited {[S1]}.',
          created_at: now,
          verification_mode: 'unverified',
          citations: [
            {
              citation_id: CITATION_ID,
              answer_id: 'msg-1',
              display_ref: '{[S1]}',
              display_number: 1,
              source: {
                source_id: 'doc_md',
                source_type: 'document',
                title: 'sample-documents.md',
                document_id: DOC_ID,
                content_type: 'text/markdown',
              },
              target: { kind: 'text_quote', exact: CITED },
              quote: CITED,
              status: 'not_verified',
            },
          ],
          claim_states: [],
        },
      ],
    }))

    await page.route(`**/documents/${DOC_ID}/download`, route =>
      route.fulfill({ json: { url: 'http://localhost:5173/__unused__.md', file_type: 'text/markdown' } }),
    )
    await page.route(`**/documents/${DOC_ID}/render`, route => route.fulfill({
      json: {
        document_id: DOC_ID,
        markdown: SOURCE_MARKDOWN,
        structure: null,
        pages: [],
      },
    }))

    await page.goto(`/chat/${THREAD_ID}`)

    const panel = page.locator('[data-testid="citation-source-panel"]:visible')
    await page.getByRole('button', { name: /Citation 1: sample-documents\.md/i }).click()
    await expect(panel).toBeVisible()

    // The cited passage is located by flattening the table row and matching it
    // against the rendered <table>, even though the stored span carried the
    // synthetic heading and a non-contiguous row.
    const highlight = panel.locator('mark[data-citation-target="active"]')
    await expect(highlight.first()).toBeVisible({ timeout: 15_000 })
    await expect(highlight.filter({ hasText: '1983' }).first()).toBeVisible()
  })

  // Harder variant: the span straddles two chunk parts, so the synthetic
  // "(Part 4)" heading sits in the MIDDLE of the quote, between the tail of the
  // table row and the following paragraph. The highlighter must drop that
  // embedded heading line so the table tail and paragraph match as one run.
  test('highlights a span with a synthetic Part heading embedded mid-passage', async ({ page }) => {
    const now = new Date().toISOString()

    const citedMid = [
      'Latiolais." | § 1983 is real but has **no subsection (c)** — miscited | flagged — **miscited** |',
      '',
      '## Evaluation answer key (⚠️ spoilers) (Part 4)',
      '',
      "**Note the hardest one — #4.** It's a *real* statute with a fabricated subsection, the kind of “swallowed fabrication” an auditor most easily waves through as “verified.” Catching it is the job of the **adjudicator** (Phase 3), not the output gate —",
    ].join('\n')

    await page.route('**/threads?*', route => route.fulfill({
      json: {
        threads: [{ id: THREAD_ID, user_id: 'test-user', title: 'MD citation', created_at: now, updated_at: now }],
        total_count: 1,
        has_more: false,
      },
    }))
    await page.route(`**/threads/${THREAD_ID}`, route => route.fulfill({
      json: { id: THREAD_ID, user_id: 'test-user', title: 'MD citation', created_at: now, updated_at: now },
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
          content: 'See the note {[S1]}.',
          created_at: now,
          verification_mode: 'unverified',
          citations: [
            {
              citation_id: CITATION_ID,
              answer_id: 'msg-1',
              display_ref: '{[S1]}',
              display_number: 1,
              source: {
                source_id: 'doc_md',
                source_type: 'document',
                title: 'sample-documents.md',
                document_id: DOC_ID,
                content_type: 'text/markdown',
              },
              target: { kind: 'text_quote', exact: citedMid },
              quote: citedMid,
              status: 'not_verified',
            },
          ],
          claim_states: [],
        },
      ],
    }))

    await page.route(`**/documents/${DOC_ID}/download`, route =>
      route.fulfill({ json: { url: 'http://localhost:5173/__unused__.md', file_type: 'text/markdown' } }),
    )
    await page.route(`**/documents/${DOC_ID}/render`, route => route.fulfill({
      json: { document_id: DOC_ID, markdown: SOURCE_MARKDOWN, structure: null, pages: [] },
    }))

    await page.goto(`/chat/${THREAD_ID}`)

    const panel = page.locator('[data-testid="citation-source-panel"]:visible')
    await page.getByRole('button', { name: /Citation 1: sample-documents\.md/i }).click()
    await expect(panel).toBeVisible()

    const highlight = panel.locator('mark[data-citation-target="active"]')
    await expect(highlight.first()).toBeVisible({ timeout: 15_000 })
    await expect(highlight.filter({ hasText: 'Note the hardest one' }).first()).toBeVisible()
  })
})
