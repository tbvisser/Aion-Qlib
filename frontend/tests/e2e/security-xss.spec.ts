import { test, expect } from '@playwright/test'

// Workstream E (Frontend Client Security) — validation for the chat markdown
// XSS pipeline. Verifies remediation commit 6c0cc0b (citation URL allowlist /
// urlTransform) plus react-markdown v10's default sanitization: an assistant
// message is attacker-influenceable (direct prompt, ingested document, web
// search, imported skill), so anything it emits must render INERT.
//
// Pattern mirrors the other citation specs: the API is route-mocked (no live
// backend, no DB seeding — keeps the audit off the shared stack and makes the
// payload deterministic). storageState comes from auth-setup via the chromium
// project. Run isolated with:
//   npx playwright test security-xss --project=chromium
// (auth-setup + cleanup are project dependencies; --no-deps skips them when a
// saved session already exists.)

const THREAD_ID = '00000000-0000-0000-0000-0000000000e5'
const CITATION_ID = 'cite_xss_probe'

// Five payloads, one assistant message. Each must be neutralized:
//  1. raw <img onerror>            -> react-markdown escapes raw HTML to text
//  2. raw <script>                 -> escaped to text, never a <script> element
//  3. [x](javascript:alert(1))     -> href stripped by defaultUrlTransform
//  4. ![x](data:text/html,...)     -> img src stripped (images auto-fetch!)
//  5. ![y](javascript:alert(1))    -> img src stripped
//  6. {[S1]} citation token        -> renders an inert citation chip (button)
const PAYLOAD = [
  'Intro line.',
  '',
  '<img src=x onerror="window.__xss_img=1;alert(1)" data-testid="xss-img">',
  '',
  '<script>window.__xss_script=1;alert(2)</script>',
  '',
  '[click-me](javascript:window.__xss_jslink=1;alert(3))',
  '',
  '![alt-data](data:text/html,<script>window.__xss_dataimg=1<\/script>)',
  '',
  '![alt-js](javascript:window.__xss_jsimg=1)',
  '',
  'A real citation {[S1]} follows.',
].join('\n')

test.describe('Chat markdown XSS hardening', () => {
  test('assistant-message payloads render inert; citation chip is non-executable', async ({ page }) => {
    const now = new Date().toISOString()

    // Any alert() is the canonical "script executed" signal. Fail loudly if one
    // ever opens, and auto-dismiss so a (hypothetical) leak can't hang the run.
    const dialogs: string[] = []
    page.on('dialog', (dialog) => {
      dialogs.push(dialog.message())
      void dialog.dismiss()
    })
    const pageErrors: string[] = []
    page.on('pageerror', (err) => pageErrors.push(String(err)))

    await page.route('**/settings/public', route => route.fulfill({ json: { context_window: 128000 } }))
    await page.route('**/threads?*', route => route.fulfill({
      json: {
        threads: [{ id: THREAD_ID, user_id: 'test-user', title: 'XSS probe', created_at: now, updated_at: now }],
        total_count: 1,
        has_more: false,
      },
    }))
    await page.route(`**/threads/${THREAD_ID}`, route => route.fulfill({
      json: { id: THREAD_ID, user_id: 'test-user', title: 'XSS probe', created_at: now, updated_at: now },
    }))
    await page.route(`**/threads/${THREAD_ID}/todos`, route => route.fulfill({ json: [] }))
    await page.route(`**/threads/${THREAD_ID}/files`, route => route.fulfill({ json: [] }))
    await page.route(`**/threads/${THREAD_ID}/harness`, route => route.fulfill({ json: null }))
    await page.route(`**/threads/${THREAD_ID}/compactions`, route => route.fulfill({ json: [] }))
    await page.route(`**/threads/${THREAD_ID}/messages`, route => route.fulfill({
      json: [
        {
          id: 'msg-xss',
          thread_id: THREAD_ID,
          user_id: 'test-user',
          role: 'assistant',
          content: PAYLOAD,
          created_at: now,
          verification_mode: 'unverified',
          citations: [
            {
              citation_id: CITATION_ID,
              answer_id: 'msg-xss',
              display_ref: '{[S1]}',
              display_number: 1,
              source: {
                source_id: 'doc_xss',
                source_type: 'web',
                title: 'Probe source',
                // A hostile source URI: must never become a clickable
                // javascript: link in the popover (safeWebUrl gates it).
                uri: 'javascript:alert(99)',
              },
              target: { kind: 'text_quote', exact: 'follows' },
              quote: 'A real citation follows.',
              status: 'not_verified',
            },
          ],
          claim_states: [],
        },
      ],
    }))

    await page.goto(`/chat/${THREAD_ID}`)

    // The citation chip is rendered by the markdown pipeline once the message
    // loads — wait on it as the "render complete" anchor.
    const chip = page.getByRole('button', { name: /Citation 1: Probe source/i })
    await expect(chip).toBeVisible({ timeout: 15_000 })

    // Give any deferred script (onerror, async eval) a tick to (not) fire.
    await page.waitForTimeout(500)

    // 1) Nothing executed.
    expect(dialogs, `XSS alert() fired: ${dialogs.join(', ')}`).toHaveLength(0)
    const flags = await page.evaluate(() => ({
      img: (window as any).__xss_img,
      script: (window as any).__xss_script,
      jslink: (window as any).__xss_jslink,
      dataimg: (window as any).__xss_dataimg,
      jsimg: (window as any).__xss_jsimg,
    }))
    expect(flags).toEqual({ img: undefined, script: undefined, jslink: undefined, dataimg: undefined, jsimg: undefined })

    // 2) The raw <img onerror> never became a real element (react-markdown
    //    escapes raw HTML to text, so no element carries the injected testid).
    await expect(page.locator('[data-testid="xss-img"]')).toHaveCount(0)

    // 3) The raw <script> is inert: it shows up as visible text, not as a
    //    <script> element inside the message.
    await expect(page.locator('script', { hasText: '__xss_script' })).toHaveCount(0)
    await expect(page.getByText('window.__xss_script=1', { exact: false })).toBeVisible()

    // 4) No anchor or image in the document carries a javascript:/data: URL —
    //    defaultUrlTransform stripped them (links AND images, per 6c0cc0b).
    const dangerous = await page.evaluate(() => {
      const bad: string[] = []
      document.querySelectorAll('a[href]').forEach(a => {
        const href = (a.getAttribute('href') || '').toLowerCase()
        if (href.startsWith('javascript:') || href.startsWith('data:') || href.startsWith('vbscript:')) bad.push('a:' + href)
      })
      document.querySelectorAll('img[src]').forEach(img => {
        const src = (img.getAttribute('src') || '').toLowerCase()
        if (src.startsWith('javascript:') || src.startsWith('data:') || src.startsWith('vbscript:')) bad.push('img:' + src)
      })
      return bad
    })
    expect(dangerous, `dangerous URLs survived urlTransform: ${dangerous.join(', ')}`).toEqual([])

    // 5) The citation chip is a plain button (inert) — clicking opens the
    //    in-app source panel, it does NOT navigate to citation:cite_xss_probe
    //    and does not expose the hostile source URI as a real link.
    await chip.click()
    const panel = page.locator('[data-testid="citation-source-panel"]:visible')
    await expect(panel).toBeVisible()
    // The hostile javascript: source URI must NOT be rendered as an <a href>.
    const jsLinks = await panel.locator('a[href^="javascript:"]').count()
    expect(jsLinks).toBe(0)

    // No uncaught page errors from the payload.
    expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toHaveLength(0)
  })
})
