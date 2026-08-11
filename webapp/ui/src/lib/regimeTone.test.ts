import { describe, expect, it } from 'vitest'
import {
  QUADRANT_ORDER, QUADRANT_TONES, marketGlyph, marketTone, quadrantLabel,
  quadrantTone, rateStageGlyph, riskTone,
} from './regimeTone'

const ALL = Object.values(QUADRANT_TONES)
const FIELDS = ['chip', 'dot', 'cell', 'text', 'band'] as const

describe('regime palette scoping', () => {
  it('confines the four hues to quadrant states', () => {
    // Reusing rose for both "Stagflation" and "hiking" would double-book the
    // hue and recreate the tint patchwork in a new colour space.
    for (const tone of ALL) {
      for (const field of FIELDS) {
        expect(tone[field]).toMatch(/amber|emerald|rose|sky|slate|muted-foreground/)
        expect(tone[field]).not.toMatch(/\b(primary|clay)\b/)
      }
    }
  })

  it('keeps risk and market on the verdict palette only', () => {
    for (const tone of [riskTone('Risk-On'), riskTone('Risk-Off'), riskTone('Neutral'),
                        marketTone('rising_high'), marketTone('falling_low'),
                        marketTone(null)]) {
      for (const field of FIELDS) {
        expect(tone[field]).not.toMatch(/amber|emerald|rose|sky/)
      }
    }
    expect(riskTone('Risk-On').text).toBe('text-primary')
    expect(riskTone('Risk-Off').text).toBe('text-clay')
    expect(marketTone('rising_low').text).toBe('text-primary')
    expect(marketTone('falling_high').text).toBe('text-clay')
  })

  it('uses only literal class strings', () => {
    // Tailwind's JIT scanner cannot see `bg-${hue}-500/15`; an interpolated
    // class renders unstyled and nothing warns.
    for (const tone of ALL) {
      for (const field of FIELDS) {
        expect(tone[field]).not.toContain('${')
        expect(tone[field]).not.toContain('#')
      }
    }
  })

  it('gives every state a distinct cell fill', () => {
    const cells = ALL.map((t) => t.cell)
    expect(new Set(cells).size).toBe(cells.length)
  })

  it('distinguishes transitional from unknown', () => {
    // Transitional is a *resolved* state; unknown is a failure to resolve.
    expect(QUADRANT_TONES.transitional.cell).not.toBe(QUADRANT_TONES.unknown.cell)
  })
})

describe('quadrantTone', () => {
  it('never throws, whatever it is handed', () => {
    for (const input of [null, undefined, '', 'nonsense', 'GOLDILOCKS',
                         'Disinflationary Slowdown']) {
      expect(FIELDS.every((f) => typeof quadrantTone(input as never)[f] === 'string'))
        .toBe(true)
    }
  })

  it('is keyed on the machine state, case-insensitively', () => {
    expect(quadrantTone('goldilocks')).toBe(QUADRANT_TONES.goldilocks)
    expect(quadrantTone('GOLDILOCKS')).toBe(QUADRANT_TONES.goldilocks)
    // A display label is not a state — it must fall through, not silently match.
    expect(quadrantTone('Disinflationary Slowdown')).toBe(QUADRANT_TONES.unknown)
  })

  it('labels every ordered state', () => {
    expect(QUADRANT_ORDER).toHaveLength(5)
    for (const state of QUADRANT_ORDER) {
      expect(quadrantLabel(state)).toBeTruthy()
      expect(quadrantLabel(state)).not.toBe('Unresolved')
    }
    expect(quadrantLabel('nope')).toBe('Unresolved')
  })
})

describe('glyphs', () => {
  it('maps rate stages, including ones the backend may invent', () => {
    expect(rateStageGlyph('Hiking')).toBe('↑')
    expect(rateStageGlyph('Cutting')).toBe('↓')
    expect(rateStageGlyph('Hold (post-hike plateau)')).toBe('–')
    expect(rateStageGlyph('Neutral / on hold')).toBe('–')
    expect(rateStageGlyph('Something New')).toBe('–')
    expect(rateStageGlyph(null)).toBe('·')
    expect(rateStageGlyph(undefined)).toBe('·')
  })

  it('maps the market lens vol channel', () => {
    expect(marketGlyph('rising_high')).toBe('▲')
    expect(marketGlyph('falling_low')).toBe('▼')
    expect(marketGlyph(null)).toBe('·')
    expect(marketGlyph('weird')).toBe('·')
  })
})
