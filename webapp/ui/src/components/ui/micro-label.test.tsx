import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

import { MicroLabel } from './micro-label'

/**
 * Pins the micro-label literal the way regimeTone.test.ts pins its palette:
 * the string below is the app's one eyebrow style, and 100+ call sites now
 * point here instead of pasting it. Change it deliberately or not at all.
 */
describe('MicroLabel', () => {
  it('renders the canonical label classes', () => {
    const html = renderToStaticMarkup(<MicroLabel>alpha</MicroLabel>)
    expect(html).toContain('text-micro uppercase tracking-wider text-muted-foreground/70')
  })

  it('renders the requested element', () => {
    const html = renderToStaticMarkup(<MicroLabel as="div">alpha</MicroLabel>)
    expect(html).toMatch(/^<div/)
  })

  it('lets className extend but not replace', () => {
    const html = renderToStaticMarkup(<MicroLabel className="text-right">alpha</MicroLabel>)
    expect(html).toContain('uppercase')
    expect(html).toContain('text-right')
  })
})
