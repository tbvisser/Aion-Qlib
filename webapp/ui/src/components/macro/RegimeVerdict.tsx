import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react'
import { Panel } from '@/components/ui/panel'
import type { MacroRegimeResponse } from '@/lib/api'
import { formatIsoDate, formatLevel, formatSigned, toneFor } from '@/lib/macroFormat'
import { quadrantTone, rateStageGlyph, riskTone } from '@/lib/regimeTone'
import { verdictSentence } from '@/lib/regimeVerdict'
import { MicroLabel } from '@/components/ui/micro-label'
import { cn } from '@/lib/utils'

function Dir({ d }: { d?: string | null }) {
  if (d === 'rising') return <ArrowUpRight className="h-3 w-3 shrink-0" />
  if (d === 'falling') return <ArrowDownRight className="h-3 w-3 shrink-0" />
  return <Minus className="h-3 w-3 shrink-0" />
}

/** One evidence line. Never renders a value it does not have. */
function Row({ label, value, tone, icon }: {
  label: React.ReactNode
  value: string
  tone?: string
  icon?: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-2 py-1">
      <span className="inline-flex min-w-0 items-center gap-1 truncate text-xs text-muted-foreground">
        {icon}{label}
      </span>
      <span className={cn('tnum shrink-0 font-mono text-xs', tone)}>{value}</span>
    </div>
  )
}

function Chip({ tone, children }: { tone: string; children: React.ReactNode }) {
  return (
    <span className={cn(
      'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold', tone,
    )}>
      {children}
    </span>
  )
}

/**
 * A lens that could not be resolved renders its reason as prose.
 *
 * Never a fabricated value and never an empty panel: "we do not know, and here
 * is why" is a real answer and the only honest one.
 */
function Lens({ label, hint, chip, reason, children }: {
  label: string
  hint?: string
  chip?: React.ReactNode
  reason?: string | null
  children?: React.ReactNode
}) {
  return (
    <Panel title={label} hint={hint}>
      {reason ? (
        <p className="text-xs leading-relaxed text-muted-foreground">{reason}</p>
      ) : (
        <>
          {chip}
          <div className="mt-2 divide-y divide-border/30">{children}</div>
        </>
      )}
    </Panel>
  )
}

/**
 * The page's argument: what regime we are in, and the evidence for it.
 *
 * Four lenses side by side. The first three are the top-down read from
 * economic releases and policy; the fourth is deliberately labelled
 * price-based, because conflating it with the macro read is the easiest
 * misinterpretation available on this page.
 */
export function RegimeVerdict({ regime, loading }: {
  regime: MacroRegimeResponse | null
  loading: boolean
}) {
  // A fixed-height spacer matched to the resolved panel, so the page does not
  // jump when the data lands. Never a spinner.
  if (!regime) {
    return <div className={cn('h-[248px]', loading && 'animate-subtle-pulse')} />
  }

  if (!regime.available) {
    return (
      <div className="rounded-lg border border-clay/40 bg-clay/5 p-3 text-sm">
        {regime.reason ?? 'The regime read could not be computed.'}
      </div>
    )
  }

  const { quadrant: q, rate_cycle: c, risk: r, market: m } = regime
  const verdict = verdictSentence(regime)

  return (
    <div className="space-y-3">
      {/* The only element whose accent varies by state — the same rule the
          validation verdict band follows. */}
      <div
        className={cn('border-l-2 pl-3', verdict.tone.band)}
        data-testid="macro-verdict-band"
      >
        <p className="text-sm leading-snug">
          <span className={cn('font-semibold', verdict.tone.text)}>{verdict.headline}</span>
          {verdict.sub && <span className="text-muted-foreground"> — {verdict.sub}</span>}
        </p>
        <MicroLabel as="div" className="mt-0.5">
          Top-down read as of {formatIsoDate(regime.as_of)} · {regime.vintage} vintage
          {verdict.knownLenses < 4 &&
            ` · ${4 - verdict.knownLenses} of 4 lenses unresolved`}
        </MicroLabel>
      </div>

      {regime.warnings.length > 0 && (
        <div className="rounded-lg border border-clay/40 bg-clay/5 p-3 text-xs">
          {regime.warnings.map((w) => <p key={w}>{w}</p>)}
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Lens
          label="Growth / inflation"
          hint="Top-down"
          reason={q.state === 'unknown'
            ? (q.reason ?? 'Not enough history to place the quadrant.') : null}
          chip={<Chip tone={quadrantTone(q.state).chip}>{q.label}</Chip>}
        >
          <Row
            icon={<Dir d={q.growth.direction} />}
            label={<>Growth {q.growth.direction}</>}
            value={q.growth.delta_6m == null
              ? '—' : `${formatSigned(q.growth.delta_6m, 1)}pp 6m`}
            tone={toneFor(q.growth.delta_6m)}
          />
          <Row
            icon={<Dir d={q.inflation.direction} />}
            label={<>Inflation {q.inflation.direction}</>}
            value={q.inflation.delta_6m == null
              ? '—' : `${formatSigned(q.inflation.delta_6m, 1)}pp 6m`}
            /* No sign colour: falling inflation is not "good" and rising is not
               "bad". Direction against precedent, not desirability. */
          />
          {q.tie_break_used && (
            <p className="pt-1 text-micro leading-relaxed text-muted-foreground">
              Growth sat inside the flat band; the call was broken on recent
              releases beating or missing expectations.
            </p>
          )}
        </Lens>

        <Lens
          label="Rate cycle"
          hint={c.source === 'US3M' ? '3-month bill' : 'FOMC decisions'}
          reason={c.stage === 'unknown'
            ? (c.reason ?? 'No policy-rate history on disk.') : null}
          chip={
            <span className="inline-flex items-center gap-1.5 rounded-full bg-foreground/[0.07] px-2 py-0.5 text-xs font-semibold">
              <span className="font-mono">{rateStageGlyph(c.stage)}</span>
              {c.stage}
            </span>
          }
        >
          <Row
            label="Front end"
            value={c.front_end == null ? '—' : `${c.front_end.toFixed(2)}%`}
          />
          <Row
            label="Δ 3m / 12m"
            value={`${c.delta_3m == null ? '—' : formatSigned(c.delta_3m, 2)} / ${
              c.delta_12m == null ? '—' : formatSigned(c.delta_12m, 2)}`}
          />
          {c.policy_rate != null && (
            <Row
              label="Fed target (upper)"
              value={`${c.policy_rate.toFixed(2)}%`}
            />
          )}
          {c.curve_spread != null && (
            <Row
              label="10Y − 3M"
              value={`${formatSigned(c.curve_spread, 2)}pp${c.inverted ? ' · inverted' : ''}`}
              tone={c.inverted ? 'text-clay' : undefined}
            />
          )}
        </Lens>

        <Lens
          label="Risk appetite"
          hint={r.score == null ? undefined : `score ${formatSigned(r.score, 2)}`}
          reason={r.label === 'unknown'
            ? (r.reason ?? 'No risk components had data.') : null}
          chip={<Chip tone={riskTone(r.label).chip}>{r.label}</Chip>}
        >
          {r.components.map((k) => (
            <Row
              key={k.name}
              label={k.name}
              value={k.value == null ? '—' : `${formatSigned(k.value, 1)}%`}
              tone={k.vote > 0 ? 'text-primary'
                : k.vote < 0 ? 'text-clay' : 'text-muted-foreground'}
            />
          ))}
          {r.missing.length > 0 && (
            <p className="pt-1 text-micro leading-relaxed text-muted-foreground">
              No data: {r.missing.join(', ')}
            </p>
          )}
        </Lens>

        {/* Deliberately last and deliberately labelled. This is NOT the
            top-down read: it is rates x vol computed from prices, the same two
            axes the attribution at the foot of the page splits a book on. */}
        <Lens
          label="Market regime"
          hint="Price-based"
          reason={m.state === 'unknown'
            ? (m.reason ?? 'Not enough price history to classify.') : null}
          chip={
            <span className="inline-flex items-center rounded-full bg-foreground/[0.07] px-2 py-0.5 text-xs font-semibold">
              {m.label}
            </span>
          }
        >
          <Row
            label="Rates, 60d"
            value={m.rates_momentum == null
              ? (m.rates ?? '—') : `${m.rates} · ${formatSigned(m.rates_momentum, 2)}pp`}
          />
          <Row
            label="Vol z-score"
            value={m.vol_z == null ? (m.vol ?? '—') : `${m.vol} · ${formatSigned(m.vol_z, 2)}σ`}
          />
          <p className="pt-1 text-micro leading-relaxed text-muted-foreground">
            From prices, not from prints — the linkage panel below splits your
            book on these same two axes.
          </p>
        </Lens>
      </div>

      {regime.headline_readings.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-3">
          {regime.headline_readings.slice(0, 3).map((h) => (
            <Panel key={h.code} title={h.label}>
              <div className="flex items-baseline gap-2">
                <span className="tnum font-mono text-lg">
                  {formatLevel(h.value, h.unit)}
                </span>
                {h.prior != null && (
                  <span className="tnum font-mono text-micro text-muted-foreground">
                    prior {formatLevel(h.prior, h.unit)}
                  </span>
                )}
              </div>
              <MicroLabel className="mt-0.5 block">{formatIsoDate(h.date)}</MicroLabel>
            </Panel>
          ))}
        </div>
      )}
    </div>
  )
}
