/**
 * The badge each stage card wears, folded from three unrelated sources.
 *
 * The severity distinction is the point, and it is the one `CoverageBanner`
 * already makes at length:
 *
 *   blocked    a preview warning that says the run should not start --
 *              everything from `validate_windows` and `inspect_features`.
 *   attention  coverage, unfinished canvas columns, and `validate_execution`.
 *              Advisory by construction. Coverage *never* blocks: the generated
 *              config drops a dead column before training, and an unfinished
 *              column is simply not in the spec yet. Execution warnings do not
 *              block either: a one-name bet on an unfiltered universe runs
 *              perfectly well, it just does not produce a result.
 *   ok         nothing to say.
 *
 * The advisory tier of *preview* warnings is new, and the severity has to travel
 * on the routed warning rather than be re-derived here -- see `RoutedWarning`.
 * Reading every routed warning as a blocker, which is what this module did while
 * `validate_execution` did not exist, would tell a reader a runnable strategy
 * cannot run and break every edge downstream of the card saying so.
 *
 * `checked === false` means the store could not be read -- "no answer", not
 * "no columns" -- so it produces no badges at all rather than a clean bill.
 */
import type { StrategyCoverage } from '@/lib/api'
import { STAGE_ORDER, type StageId } from './stages'
import { advisoryFor, blockingFor, type RoutedWarning } from './routeWarning'

export type StageStatus = 'ok' | 'attention' | 'blocked'

export interface StageBadge {
  status: StageStatus
  /** Every sentence behind the badge, both tiers, for the card's title. */
  notes: string[]
  /**
   * The advisory tier alone, for the inspector rail — which prints blockers
   * from its own prop and must not say them twice. Carried separately because
   * recovering it from `notes` means re-deriving which sentences were which.
   */
  advisories: string[]
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
    const blocking = blockingFor(routed, id)
    // Execution warnings join coverage in the advisory bucket, ahead of it: they
    // are about the spec the reader just wrote, not about the store underneath.
    const notes = [...advisoryFor(routed, id), ...advisory[id]]
    if (blocking.length) {
      out[id] = { status: 'blocked', notes: [...blocking, ...notes], advisories: notes }
    } else if (notes.length) {
      out[id] = { status: 'attention', notes, advisories: notes }
    } else {
      out[id] = { status: 'ok', notes: [], advisories: [] }
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
