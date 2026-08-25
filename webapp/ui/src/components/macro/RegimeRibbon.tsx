import { Panel } from '@/components/ui/panel'
import { Segmented } from '@/components/ui/segmented'
import type { MacroRegimeHistory } from '@/lib/api'
import { ribbonCells } from '@/lib/regimeHistory'
import {
  QUADRANT_ORDER, QUADRANT_TONES, marketGlyph, marketTone, quadrantLabel,
  quadrantTone, rateStageGlyph,
} from '@/lib/regimeTone'
import { cn } from '@/lib/utils'

export type RibbonLens = 'quadrant' | 'market'

/**
 * Two years of month-end regime, one cell per month.
 *
 * The cell carries two orthogonal channels: the **fill** is the state, and the
 * **glyph** is a second dimension — the rate-cycle stage on the quadrant lens,
 * the volatility level on the market lens. A glyph is not a colour, so one
 * cell holds both without ambiguity, and the tooltip carries all four lenses
 * as text so nothing here is colour-only.
 *
 * Switching lens swaps the fill and the glyph and leaves the geometry alone.
 */
export function RegimeRibbon({ history, lens, onLensChange, loading }: {
  history: MacroRegimeHistory | null
  lens: RibbonLens
  onLensChange: (lens: RibbonLens) => void
  loading: boolean
}) {
  const cells = ribbonCells(history?.months ?? [])

  return (
    <Panel
      title="Regime history"
      hint="24 months, month-end"
      loading={loading}
      actions={
        <Segmented
          value={lens}
          options={[
            { value: 'quadrant', label: 'Quadrant', title: 'Top-down growth/inflation state' },
            { value: 'market', label: 'Market', title: 'Price-based rates × vol state' },
          ]}
          onChange={(v) => onLensChange(v as RibbonLens)}
          size="sm"
        />
      }
    >
      {!history ? (
        <div className="h-[70px]" />
      ) : !history.available || cells.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {history.reason ?? 'No regime history available.'}
        </p>
      ) : (
        <>
          <div className="flex items-end gap-1 overflow-x-auto pb-1">
            {cells.map((cell) => {
              const tone = lens === 'quadrant'
                ? quadrantTone(cell.quadrantState)
                : marketTone(cell.marketState)
              const glyph = lens === 'quadrant'
                ? rateStageGlyph(cell.rateStage)
                : marketGlyph(cell.marketState)
              return (
                <div key={cell.month} className="flex shrink-0 flex-col items-center gap-1">
                  <span
                    title={cell.title}
                    data-testid={`macro-ribbon-cell-${cell.month}`}
                    className={cn(
                      'flex h-8 w-6 items-center justify-center rounded font-mono text-label',
                      cell.missing
                        ? 'border border-dashed border-border/60 text-muted-foreground/40'
                        : cn(tone.cell, 'text-black/70 dark:text-white/85'),
                      // The present month is marked by a ring, not a hue —
                      // hue is already spoken for.
                      cell.current &&
                        'ring-1 ring-foreground/50 ring-offset-1 ring-offset-card',
                    )}
                  >
                    {cell.missing ? '·' : glyph}
                  </span>
                  <span className="tnum h-3 font-mono text-micro text-muted-foreground">
                    {cell.yearLabel ?? ' '}
                  </span>
                </div>
              )
            })}
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
            {lens === 'quadrant' ? (
              <>
                {QUADRANT_ORDER.map((state) => (
                  <span
                    key={state}
                    className="inline-flex items-center gap-1.5 text-micro text-muted-foreground"
                  >
                    <span className={cn('h-2 w-2 rounded-full', QUADRANT_TONES[state].dot)} />
                    {quadrantLabel(state)}
                  </span>
                ))}
                <span className="font-mono text-micro text-muted-foreground/70">
                  ↑ hiking · ↓ cutting · – hold
                </span>
              </>
            ) : (
              <>
                <span className="inline-flex items-center gap-1.5 text-micro text-muted-foreground">
                  <span className="h-2 w-2 rounded-full bg-primary" /> Rates rising
                </span>
                <span className="inline-flex items-center gap-1.5 text-micro text-muted-foreground">
                  <span className="h-2 w-2 rounded-full bg-clay" /> Rates falling
                </span>
                <span className="font-mono text-micro text-muted-foreground/70">
                  ▲ vol high · ▼ vol low · price-based, not the top-down read
                </span>
              </>
            )}
          </div>
        </>
      )}
    </Panel>
  )
}
