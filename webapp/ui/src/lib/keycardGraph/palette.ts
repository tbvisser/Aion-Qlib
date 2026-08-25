/**
 * The keycard canvas's one colour vocabulary.
 *
 * Three maps give keycard things an identity colour — node categories
 * (`nodeRegistry.ts`), port types (`keycardFlow.ts`) and template families
 * (`NodePalette.tsx`) — and they used to hold three overlapping sets of raw
 * hex values, which meant dark mode could not retune them and near-duplicate
 * shades (blue-400 beside blue-500) drifted in independently. Every identity
 * colour now names one of these eight hues, and the hues resolve through the
 * `--kc-*` tokens in `index.css`, where each carries a light and a dark value.
 *
 * A hue is a token *reference* (`var(--kc-blue)`), not a paintable colour —
 * wrap it in `solid()` or `wash()` at the point of use. That split is what
 * lets one stored value serve both a full-strength tile and an 8% tint,
 * the same `hsl(var(...) / alpha)` composition the stylesheet uses.
 */

export const KEYCARD_HUES = {
  blue: 'var(--kc-blue)',
  emerald: 'var(--kc-emerald)',
  violet: 'var(--kc-violet)',
  orange: 'var(--kc-orange)',
  rose: 'var(--kc-rose)',
  amber: 'var(--kc-amber)',
  cyan: 'var(--kc-cyan)',
  slate: 'var(--kc-slate)',
} as const

export type KeycardHue = (typeof KEYCARD_HUES)[keyof typeof KEYCARD_HUES]

/** The fallback for anything without an identity: the muted text tone. */
export const NEUTRAL_HUE = 'var(--muted-foreground)'

/** The hue at full strength — tiles, borders, strokes, labels. */
export const solid = (hue: string): string => `hsl(${hue})`

/** The hue as a faint tint behind its own icon. */
export const wash = (hue: string): string => `hsl(${hue} / 0.08)`
