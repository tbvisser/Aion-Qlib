import type { AgendaType } from '@/lib/agenda'

/**
 * Identity styling per agenda type — the one place the five hues live.
 *
 * Identity is carried by dots, rails, chips and text accents; verdicts
 * (destructive/primary washes, clay, status colours) never come from this
 * map. Full class literals so Tailwind's JIT sees every string.
 *
 * The hues are the dataviz reference palette's blue/violet/aqua/magenta/
 * yellow slots, validated as a set in both modes against this app's card
 * surfaces in the dot display order trade → release → message →
 * notification → process (see DOT_ORDER in MonthGrid).
 */
export const TYPE_STYLES: Record<AgendaType, {
  dot: string
  glowDot: string
  rail: string
  chipBg: string
  text: string
  filterActive: string
}> = {
  release: {
    dot: 'bg-type-release',
    glowDot: 'bg-type-release shadow-[0_0_5px_hsl(var(--type-release)/0.6)]',
    rail: 'bg-type-release/70',
    chipBg: 'bg-type-release/10 text-type-release',
    text: 'text-type-release',
    filterActive: 'border-type-release/40 bg-type-release/10 text-foreground',
  },
  process: {
    dot: 'bg-type-process',
    glowDot: 'bg-type-process shadow-[0_0_5px_hsl(var(--type-process)/0.6)]',
    rail: 'bg-type-process/70',
    chipBg: 'bg-type-process/10 text-type-process',
    text: 'text-type-process',
    filterActive: 'border-type-process/40 bg-type-process/10 text-foreground',
  },
  trade: {
    dot: 'bg-type-trade',
    glowDot: 'bg-type-trade shadow-[0_0_5px_hsl(var(--type-trade)/0.6)]',
    rail: 'bg-type-trade/70',
    chipBg: 'bg-type-trade/10 text-type-trade',
    text: 'text-type-trade',
    filterActive: 'border-type-trade/40 bg-type-trade/10 text-foreground',
  },
  message: {
    dot: 'bg-type-message',
    glowDot: 'bg-type-message shadow-[0_0_5px_hsl(var(--type-message)/0.6)]',
    rail: 'bg-type-message/70',
    chipBg: 'bg-type-message/10 text-type-message',
    text: 'text-type-message',
    filterActive: 'border-type-message/40 bg-type-message/10 text-foreground',
  },
  notification: {
    dot: 'bg-type-notification',
    glowDot: 'bg-type-notification shadow-[0_0_5px_hsl(var(--type-notification)/0.6)]',
    rail: 'bg-type-notification/70',
    chipBg: 'bg-type-notification/10 text-type-notification',
    text: 'text-type-notification',
    filterActive: 'border-type-notification/40 bg-type-notification/10 text-foreground',
  },
}

/**
 * The month grid's macro-heat band, in the release hue so it reads as
 * "release load" beside the release dots. Kept here so the ladder classes
 * live beside the hue they use (and stay JIT-visible literals).
 *
 * Deliberately faint: the cell also carries a saturated type-mix bar along
 * its bottom edge, and at full strength these two read as stripes rather
 * than as two different facts. This one is the quiet background temperature.
 */
export function heatStripClass(tier: 0 | 1 | 2 | 3): string {
  switch (tier) {
    case 1: return 'bg-type-release/15'
    case 2: return 'bg-type-release/35'
    case 3: return 'bg-type-release/60'
    default: return ''
  }
}
