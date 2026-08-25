/**
 * The blocks you can add, grouped and searchable.
 *
 * Click-to-insert rather than drag-and-drop, deliberately for now: the insert
 * rule in `tree.ts` already puts a block somewhere sensible without being told
 * where, and a drop target is only worth building once there is more than one
 * sensible destination.
 *
 * Rows are single-line `RailRow`s. What used to be a clamped second line — the
 * summary, the caveat, the raw expression — is in the tooltip, which can hold
 * all three without costing every row its height.
 */
import { useCallback, useMemo } from 'react'

import { Badge } from '@/components/ui/badge'
import { RailRow, RailSection, RailTip } from '@/components/ui/rail'
import type { CatalogFactor, FactorFamily, Indicator } from '@/lib/api'
import { CATEGORY_LABELS } from '@/lib/factorExpr/registry'
import type {
  ExprNode, OpCategory, OperatorRegistry, OperatorSpec,
} from '@/lib/factorExpr/types'
import { call, constant, field } from '@/lib/factorExpr/types'

const CATEGORY_ORDER: OpCategory[] = [
  'rolling', 'arithmetic', 'pair', 'elementwise', 'compare', 'logic',
]

/** Alpha158 is 184 rows, so it stays collapsed until searched or expanded. */
const FAMILY_LABELS: Record<string, string> = {
  kbar: 'Candle', price: 'Price lags', volume: 'Volume lags', rolling: 'Rolling',
}
const FAMILY_ORDER = ['rolling', 'kbar', 'price', 'volume']
const SEARCH_LIMIT = 40

interface Props {
  registry: OperatorRegistry
  fields: string[]
  /** The curated factor library, each entry a whole expression. */
  catalog: CatalogFactor[]
  /**
   * The families the backend served, in its order.
   *
   * `curated.py` calls that order authoritative — it decides how the palette
   * reads to someone who has never seen the library. Deriving an order here
   * from whichever factor happened to come first would quietly fight it, and
   * capitalising the raw key would print "Anomaly" where the Factor Lab prints
   * "Academic anomalies".
   */
  families: FactorFamily[]
  /** The full Alpha158 library, when the API has answered. */
  indicators: Indicator[]
  /** The rail's search box, already trimmed and lowercased. */
  needle: string
  onInsert: (node: ExprNode) => void
  /**
   * Adds the expression as a new named column.
   *
   * It used to replace the active column. That was defensible while the library
   * was ten entries; at a hundred it made every misclick destroy a tree.
   */
  onAdd: (expression: string, name?: string) => void
}

export function BlockPalette({
  registry, fields, catalog, families, indicators, needle, onInsert, onAdd,
}: Props) {
  const matches = useCallback(
    (name: string, summary: string) =>
      !needle || name.toLowerCase().includes(needle) || summary.toLowerCase().includes(needle),
    [needle])

  const grouped = useMemo(() => {
    const out = new Map<OpCategory, OperatorSpec[]>()
    for (const spec of Object.values(registry)) {
      if (!matches(spec.name, spec.summary)) continue
      const list = out.get(spec.category) ?? []
      list.push(spec)
      out.set(spec.category, list)
    }
    for (const list of out.values()) list.sort((a, b) => a.name.localeCompare(b.name))
    return out
  }, [registry, matches])

  const visibleFields = fields.filter((f) => matches(`$${f}`, 'price volume field'))

  /**
   * The curated library, grouped the same way Alpha158 is.
   *
   * Flat and unbounded was fine at ten entries. At a hundred it pushed the
   * fields, all six operator categories and the whole Alpha158 group below the
   * fold of the rail.
   */
  const curated = useMemo(() => {
    const hits = catalog.filter(
      (c) => matches(c.name, `${c.summary} ${c.family} ${c.expression} ${c.tags.join(' ')}`))
    const byFamily = new Map<string, CatalogFactor[]>()
    for (const factor of hits) {
      byFamily.set(factor.family, [...(byFamily.get(factor.family) ?? []), factor])
    }
    // Served order. A family the backend knows about but that has no hits is
    // dropped rather than shown empty.
    const order = families.length
      ? families.map((f) => f.key).filter((key) => byFamily.has(key))
      : [...byFamily.keys()]
    const label = (key: string) => families.find((f) => f.key === key)?.label ?? key
    return { hits, byFamily, order, label }
  }, [catalog, families, matches])

  const library = useMemo(() => {
    const hits = indicators.filter(
      (i) => matches(i.name, `${i.description} ${i.group} ${i.expression}`))
    const byFamily = new Map<string, Indicator[]>()
    for (const indicator of hits) {
      const list = byFamily.get(indicator.family) ?? []
      list.push(indicator)
      byFamily.set(indicator.family, list)
    }
    return { hits, byFamily }
  }, [indicators, matches])

  // A search wants results, not somewhere to click to find them: every section
  // is forced open while a query is live, and forgotten again when it clears.
  const searching = !!needle

  return (
    <>
      {curated.hits.length > 0 && (
        searching ? (
          <RailSection label="Factor library" count={curated.hits.length} open>
            {curated.hits.slice(0, SEARCH_LIMIT).map((entry) => (
              <FactorRow key={entry.name} factor={entry} onAdd={onAdd} />
            ))}
            {curated.hits.length > SEARCH_LIMIT && (
              <Overflow n={curated.hits.length - SEARCH_LIMIT} where="the Factor Lab" />
            )}
          </RailSection>
        ) : (
          curated.order.map((family) => (
            <RailSection
              key={family}
              label={curated.label(family)}
              count={(curated.byFamily.get(family) ?? []).length}
              defaultOpen={false}
            >
              {(curated.byFamily.get(family) ?? []).map((entry) => (
                <FactorRow key={entry.name} factor={entry} onAdd={onAdd} />
              ))}
            </RailSection>
          ))
        )
      )}

      {visibleFields.length > 0 && (
        <RailSection label="Fields" count={visibleFields.length + 1} open={searching || undefined}>
          {visibleFields.map((name) => (
            <RailRow
              key={name}
              data-testid={`block-$${name}`}
              label={<span className="font-mono">${name}</span>}
              tooltip={<RailTip body="A column from the store." hint="Click to insert." />}
              onClick={() => onInsert(field(name))}
            />
          ))}
          <RailRow
            data-testid="block-number"
            label={<span className="font-mono">number</span>}
            tooltip={<RailTip body="A constant, e.g. 1 or 1e-12." hint="Click to insert." />}
            onClick={() => onInsert(constant(1))}
          />
        </RailSection>
      )}

      {CATEGORY_ORDER.map((category) => {
        const specs = grouped.get(category)
        if (!specs?.length) return null
        return (
          <RailSection
            key={category}
            label={CATEGORY_LABELS[category]}
            count={specs.length}
            open={searching || undefined}
          >
            {specs.map((spec) => (
              <RailRow
                key={spec.name}
                data-testid={`block-${spec.name}`}
                label={
                  <span className="font-mono">
                    {spec.name}
                    {spec.symbol && (
                      <span className="ml-1.5 text-muted-foreground">{spec.symbol}</span>
                    )}
                  </span>
                }
                tooltip={<RailTip body={spec.summary} hint="Click to insert." />}
                onClick={() => onInsert(call(spec))}
              />
            ))}
          </RailSection>
        )
      })}

      {library.hits.length > 0 && (
        searching ? (
          <RailSection label="Alpha158" count={library.hits.length} open>
            {library.hits.slice(0, SEARCH_LIMIT).map((indicator) => (
              <IndicatorRow key={indicator.name} indicator={indicator} onOpen={onAdd} />
            ))}
            {library.hits.length > SEARCH_LIMIT && (
              <Overflow n={library.hits.length - SEARCH_LIMIT} where="the Indicators page" />
            )}
          </RailSection>
        ) : (
          FAMILY_ORDER.map((family) => {
            const rows = library.byFamily.get(family)
            if (!rows?.length) return null
            return (
              <RailSection
                key={family}
                label={`Alpha158 · ${FAMILY_LABELS[family] ?? family}`}
                count={rows.length}
                defaultOpen={false}
              >
                {rows.map((indicator) => (
                  <IndicatorRow key={indicator.name} indicator={indicator} onOpen={onAdd} />
                ))}
              </RailSection>
            )
          })
        )
      )}

      {visibleFields.length === 0 && grouped.size === 0 && curated.hits.length === 0
        && library.hits.length === 0 && (
        <p className="px-2 py-6 text-center text-label text-muted-foreground">
          Nothing matches “{needle}”.
        </p>
      )}
    </>
  )
}

function Overflow({ n, where }: { n: number; where: string }) {
  return (
    <p className="px-1 py-1 text-micro text-muted-foreground">
      …and {n} more. Narrow the search, or open {where}.
    </p>
  )
}

/**
 * One curated factor.
 *
 * The warm-up badge is the point of the row beyond its name. qlib's rolling
 * uses `min_periods=1`, so a 60-day volatility returns a confident number from
 * two observations while a 252-day lag is honestly blank for a year — and the
 * two can sit in the same feature set with nothing else telling them apart.
 */
function FactorRow({ factor, onAdd }: {
  factor: CatalogFactor
  onAdd: (expression: string, name?: string) => void
}) {
  const dead = factor.runnable === false
  const slow = (factor.back_days ?? 0) >= 60
  return (
    <RailRow
      data-testid={`factor-${factor.name}`}
      disabled={dead}
      onClick={() => onAdd(factor.expression, factor.name)}
      label={<span className="font-mono">{factor.name}</span>}
      badges={
        dead ? (
          <Badge variant="clay" className="shrink-0">no data</Badge>
        ) : slow ? (
          <Badge className="shrink-0 normal-case">{factor.back_days}d</Badge>
        ) : null
      }
      tooltip={
        <RailTip
          title={factor.expression}
          body={[factor.summary, factor.note].filter(Boolean).join(' ')}
          constraint={
            dead
              ? factor.caveat ?? 'This store has no data for it.'
              : slow
                ? `Needs ${factor.back_days} trading days of history.`
                : factor.caveat
          }
          hint={dead ? undefined : 'Click to add as a column.'}
        />
      }
    />
  )
}

/**
 * One Alpha158 row.
 *
 * An indicator the store cannot evaluate is shown and disabled rather than
 * hidden: it is part of the feature set a strategy trains on, so pretending it
 * does not exist would be a different lie than the one we are fixing. The
 * tooltip carries the reason.
 */
function IndicatorRow({ indicator, onOpen }: {
  indicator: Indicator
  onOpen: (expression: string, name?: string) => void
}) {
  const dead = indicator.runnable === false
  return (
    <RailRow
      data-testid={`indicator-${indicator.name}`}
      disabled={dead}
      onClick={() => onOpen(indicator.expression, indicator.name)}
      label={<span className="font-mono">{indicator.name}</span>}
      badges={dead ? <Badge variant="clay" className="shrink-0">no data</Badge> : null}
      tooltip={
        <RailTip
          title={indicator.expression}
          body={indicator.description}
          constraint={dead ? indicator.note ?? 'This store has no data for it.' : null}
          hint={dead ? undefined : 'Click to add as a column.'}
        />
      }
    />
  )
}
