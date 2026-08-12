/**
 * The badge each stage card wears, folded from three unrelated sources.
 *
 * The severity distinction is the point, and it is the one `CoverageBanner`
 * already makes at length:
 *
 *   blocked    a preview warning. These gate the Run button today and must
 *              keep gating it -- this change does not introduce a
 *              non-blocking warning tier.
 *   attention  coverage, and unfinished canvas columns. Advisory by
 *              construction. Coverage *never* blocks: the generated config
 *              drops a dead column before training, and an unfinished column
 *              is simply not in the spec yet.
 *   ok         nothing to say.
 *
 * `checked === false` means the store could not be read -- "no answer", not
 * "no columns" -- so it produces no badges at all rather than a clean bill.
 */
import type { StrategyCoverage } from '@/lib/api'
import { STAGE_ORDER, type StageId } from './stages'
import { warningsFor, type RoutedWarning } from './routeWarning'

export type StageStatus = 'ok' | 'attention' | 'blocked'

export interface StageBadge {
  status: StageStatus
  /** The sentences behind the badge, for the card's title and the inspector. */
  notes: string[]
}

export interface StatusContext {
  coverage?: StrategyCoverage
  /** Canvas columns still being built. Advisory. */
  unfinished?: number
}

function coverageNotes(coverage: StrategyCoverage | undefined): Record<StageId, string[]> {
  const empty = {} as Record<StageId, string[]>
  for (const id of STAGE_ORDER) empty[id] = []
  if (!coverage || !coverage.checked) return empty

  const dead = coverage.dead_columns ?? []
  if (dead.length) {
    const columns = `${dead.length} ${coverage.handler} column${dead.length === 1 ? '' : 's'}`
    empty.store.push(coverage.dropped
      ? `${columns} this store cannot compute — dropped before training.`
      : `${columns} this store cannot compute.`)
    // The banner's severity is model-dependent: a linear model is the one that
    // actually suffers, so the learner card has to carry it too or the reader
    // never sees it while choosing a model.
    if (coverage.model === 'linear') {
      empty.learner.push(
        `${columns} are missing on this store, which a linear model feels more than a tree does.`)
    }
  }

  const partialFields = coverage.feature_partial_fields ?? []
  if (partialFields.length) {
    empty.features.push(
      `Your factors read ${partialFields.map((f) => `$${f}`).join(', ')}, which only some ` +
      `instruments carry — the rest drop out of the cross-section.`)
  }

  const proxyFields = Object.keys(coverage.feature_proxy_fields ?? {})
  if (proxyFields.length) {
    empty.features.push(
      `Your factors read ${proxyFields.map((f) => `$${f}`).join(', ')}, which is a stand-in ` +
      `on this store.`)
  }

  return empty
}

/**
 * One badge per stage.
 *
 * A blocker outranks coverage on the same stage: if a run cannot start, that is
 * the thing to say, and the advisory note is still in `notes` behind it.
 */
export function stageStatus(
  routed: readonly RoutedWarning[], ctx: StatusContext = {},
): Record<StageId, StageBadge> {
  const advisory = coverageNotes(ctx.coverage)
  const unfinished = ctx.unfinished ?? 0
  if (unfinished > 0) {
    advisory.features.push(
      `${unfinished} feature${unfinished === 1 ? ' is' : 's are'} unfinished and not in the ` +
      `config yet.`)
  }

  const out = {} as Record<StageId, StageBadge>
  for (const id of STAGE_ORDER) {
    const blocking = warningsFor(routed, id)
    if (blocking.length) {
      out[id] = { status: 'blocked', notes: [...blocking, ...advisory[id]] }
    } else if (advisory[id].length) {
      out[id] = { status: 'attention', notes: advisory[id] }
    } else {
      out[id] = { status: 'ok', notes: [] }
    }
  }
  return out
}

/** The first stage carrying a blocker, for the header chip to jump to. */
export function firstBlockedStage(
  status: Readonly<Record<StageId, StageBadge>>,
): StageId | null {
  return STAGE_ORDER.find((id) => status[id].status === 'blocked') ?? null
}
