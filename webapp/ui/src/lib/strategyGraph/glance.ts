/**
 * Every string a stage card prints.
 *
 * Separate from the card on purpose. The card is a dumb printer of
 * `StageCardData`, so pushing all formatting here is what makes the canvas
 * testable in a repo with no component tests -- `glance.test.ts` covers the
 * strings, and there is nothing left in the card worth asserting.
 *
 * ## Headline vs detail
 *
 * The headline is what the stage is *set to*, and it is the card's bold line.
 * The stage's description ("Where the prices come from") is not: it is the same
 * eight sentences for every strategy anyone will ever build, so leading with it
 * made two different strategies draw two identical pictures while the only
 * things that actually differed -- `us`, `top500 vs SPY`, `LightGBM` -- were
 * rendered smallest. `StageDef.label` still exists, for the inspector heading
 * and the chip tooltip, where a description belongs.
 */
import type {
  DataStore, ModelsResponse, StrategyExplain, StrategySpec,
} from '@/lib/api'
import { roundTripBps } from '@/lib/bps'
import type { StageId } from './stages'

export interface GlanceLine {
  key: string
  value: string
  /** A value that is a problem in itself, e.g. a store with no data. */
  tone?: 'clay'
}

export interface StageGlance {
  /** The bold line. Never empty -- a stage always has a value. */
  headline: string
  /** Smaller lines under it, in reading order. */
  detail: GlanceLine[]
}

/** What the glance needs beyond the spec itself. All optional: it degrades to the raw value. */
export interface GlanceContext {
  store?: DataStore
  explain?: StrategyExplain
  models?: ModelsResponse | null
  /** Members of the selected universe on the selected store; null when unknown. */
  universeCount?: number | null
  /** Canvas columns still being built. Not errors, and not in the spec yet. */
  unfinished?: number
}

/** `100000000` -> `100,000,000`. Locale-independent so tests can pin it. */
function thousands(value: number): string {
  const [whole, fraction] = String(value).split('.')
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return fraction ? `${grouped}.${fraction}` : grouped
}

/** `2010-01-04` -> `2010`. Cards have room for the shape of a window, not its days. */
function year(date: string): string {
  return date.slice(0, 4) || date
}

/**
 * How many feature columns a handler contributes.
 *
 * Read off the name rather than tabulated, because that is what the name means
 * and a table would go stale against a handler this file has never heard of.
 * Unknown names get no count rather than a guess.
 *
 * Exported for the base feature chip, which prints the same count beside the
 * handler's name -- deriving it twice is how the card and the chip would come
 * to disagree.
 */
export function handlerColumns(handler: string): number | null {
  const digits = /(\d+)$/.exec(handler)
  return digits ? Number(digits[1]) : null
}

function storeGlance(spec: StrategySpec, ctx: GlanceContext): StageGlance {
  const store = ctx.store
  if (!store) return { headline: spec.data_store, detail: [] }
  if (!store.exists) {
    return {
      headline: spec.data_store,
      detail: [{ key: 'built', value: 'no data yet', tone: 'clay' }],
    }
  }
  return {
    headline: spec.data_store,
    detail: store.calendar_days
      ? [{ key: 'days', value: `${thousands(store.calendar_days)} trading days` }]
      : [],
  }
}

function universeGlance(spec: StrategySpec, ctx: GlanceContext): StageGlance {
  // Universe and benchmark on one line: "what am I picking from, and what am I
  // measured against" is one question, and the two fields are always read together.
  const headline = `${spec.universe} vs ${spec.benchmark}`
  const detail: GlanceLine[] = []
  // `null` is "not counted yet", which is not "zero names" -- so say nothing.
  if (typeof ctx.universeCount === 'number') {
    detail.push({ key: 'count', value: `${thousands(ctx.universeCount)} names` })
  }
  return { headline, detail }
}

function featuresGlance(spec: StrategySpec, ctx: GlanceContext): StageGlance {
  const own = spec.features?.length ?? 0
  const detail: GlanceLine[] = []
  let headline: string

  if (!own) {
    headline = spec.handler
    const columns = handlerColumns(spec.handler)
    if (columns !== null) {
      detail.push({ key: 'columns', value: `${columns} columns` })
    }
  } else if (spec.feature_mode === 'replace') {
    headline = `${own} column${own === 1 ? '' : 's'}`
    detail.push({ key: 'mode', value: `${spec.handler} replaced` })
  } else {
    headline = `${spec.handler} + ${own}`
    const columns = handlerColumns(spec.handler)
    if (columns !== null) {
      detail.push({ key: 'columns', value: `${columns + own} columns` })
    }
  }

  const unfinished = ctx.unfinished ?? 0
  if (unfinished > 0) {
    detail.push({ key: 'unfinished', value: `${unfinished} unfinished`, tone: 'clay' })
  }
  return { headline, detail }
}

function periodsGlance(spec: StrategySpec, ctx: GlanceContext): StageGlance {
  // The *test* window leads. It is the one anyone reads, because it is the
  // period the reported numbers came from; train and validate are how it was
  // arrived at.
  const clamped = ctx.explain?.effective_test_end
  const stopsEarly = Boolean(clamped && clamped !== spec.test_end)
  const end = stopsEarly ? clamped! : spec.test_end

  return {
    headline: `${year(spec.test_start)} → ${year(end)}`,
    detail: [
      {
        key: 'fit',
        value: `train ${year(spec.train_start)}–${year(spec.train_end)} · `
          + `valid ${year(spec.valid_start)}–${year(spec.valid_end)}`,
      },
      // The clamp is applied silently by `build_workflow_config`, and a backtest
      // that quietly stops before the date on the card is exactly the kind of
      // difference that gets attributed to the strategy.
      ...(stopsEarly
        ? [{ key: 'clamp', value: 'store ends early', tone: 'clay' as const }]
        : []),
    ],
  }
}

function learnerGlance(spec: StrategySpec, ctx: GlanceContext): StageGlance {
  const label = ctx.models?.models.find((m) => m.id === spec.model)?.label
  return { headline: label || spec.model, detail: [] }
}

function portfolioGlance(spec: StrategySpec): StageGlance {
  return {
    headline: `Top ${spec.topk}`,
    detail: [{ key: 'ndrop', value: `drop ${spec.n_drop} per rebalance` }],
  }
}

function costsGlance(spec: StrategySpec): StageGlance {
  const detail: GlanceLine[] = [
    { key: 'account', value: `$${thousands(spec.account)}` },
  ]
  // Absent from the old form, so a template or the assistant can carry one in
  // and only the run summary ever reported it. A card can say it beforehand.
  if (spec.limit_threshold !== null && spec.limit_threshold !== undefined) {
    detail.push({ key: 'limit', value: `limit ${spec.limit_threshold}` })
  }
  return {
    // The number that decides whether a strategy survives its own turnover, and
    // the one neither of the two fields it comes from ever shows.
    headline: `${roundTripBps(spec.open_cost, spec.close_cost)} bps round trip`,
    detail,
  }
}

function contextGlance(spec: StrategySpec): StageGlance {
  const text = spec.context.trim()
  return {
    headline: 'Objective',
    detail: text
      ? [{ key: 'context', value: text.length > 40 ? `${text.slice(0, 40)}…` : text }]
      : [{ key: 'context', value: 'No objective set' }],
  }
}

const GLANCE: Record<StageId, (spec: StrategySpec, ctx: GlanceContext) => StageGlance> = {
  context: (spec) => contextGlance(spec),
  store: storeGlance,
  universe: universeGlance,
  features: featuresGlance,
  periods: periodsGlance,
  learner: learnerGlance,
  portfolio: (spec) => portfolioGlance(spec),
  costs: (spec) => costsGlance(spec),
}

export function stageGlance(
  stage: StageId, spec: StrategySpec, ctx: GlanceContext = {},
): StageGlance {
  return GLANCE[stage](spec, ctx)
}
