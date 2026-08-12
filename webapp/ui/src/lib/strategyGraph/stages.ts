/**
 * The seven stages a strategy is drawn as, and which spec fields each owns.
 *
 * The spec is the source of truth and the graph is derived from it on every
 * render. Nothing is written back -- not even positions. This mirrors the rule
 * `lib/factorExpr` holds for expression trees, for the same reason: a picture
 * that can disagree with the thing it depicts is worse than no picture.
 *
 * The chain is fixed. A user never adds, removes or reconnects a stage -- only
 * edits one -- so `STAGE_ORDER` is a constant rather than a computed topology.
 *
 * Deliberately free of React and of `@xyflow/react`: `toFlow.ts` is the only
 * module in this directory allowed to know a graph library exists.
 */
import type { StrategySpec } from '@/lib/api'

export type StageId =
  | 'store' | 'universe' | 'features' | 'periods' | 'learner' | 'portfolio' | 'costs'

/**
 * Four phases over seven stages.
 *
 * `index.css` reserves five `--type-*` hues for identity and says they are
 * never verdicts, so there is no sixth or seventh to hand out. Rather than
 * invent one, adjacent stages share a phase colour -- which says more than
 * seven arbitrary hues would, and is the opposite of what a node editor
 * usually does.
 */
export type StagePhase = 'data' | 'shape' | 'fit' | 'execute'

/** Icon keys, resolved to lucide components in the card. Keeps this file React-free. */
export type StageIcon =
  | 'database' | 'listFilter' | 'sigma' | 'calendarRange' | 'cpu' | 'layers' | 'receipt'

export interface StageDef {
  id: StageId
  phase: StagePhase
  /** Card eyebrow, e.g. `DATA STORE`. */
  eyebrow: string
  /** The bold line. */
  label: string
  icon: StageIcon
  /**
   * The spec keys this stage owns.
   *
   * Load-bearing: it drives warning routing, and `stages.test.ts` asserts the
   * union covers every `StrategySpec` key except `name`. That assertion is what
   * breaks the day a field is added to the spec and forgotten here -- the exact
   * failure mode of exploding one form into seven panels.
   */
  owns: readonly (keyof StrategySpec)[]
}

export const STAGE_ORDER = [
  'store', 'universe', 'features', 'periods', 'learner', 'portfolio', 'costs',
] as const satisfies readonly StageId[]

export const STAGES: Readonly<Record<StageId, StageDef>> = {
  store: {
    id: 'store',
    phase: 'data',
    eyebrow: 'Data store',
    label: 'Where the prices come from',
    icon: 'database',
    owns: ['data_store'],
  },
  universe: {
    id: 'universe',
    phase: 'data',
    eyebrow: 'Universe',
    label: 'Which names, against what',
    icon: 'listFilter',
    // `benchmark` sits here rather than with the store: it is the same kind of
    // question (which symbols), it comes off the same `DataStore` object, and
    // switching store invalidates both together.
    owns: ['universe', 'benchmark'],
  },
  features: {
    id: 'features',
    phase: 'shape',
    eyebrow: 'Features',
    label: 'What the model sees',
    icon: 'sigma',
    // `handler` belongs here, not with the learner: it *is* a feature set, and
    // `feature_mode: extend|replace` is meaningless without knowing which one.
    owns: ['handler', 'features', 'feature_mode'],
  },
  periods: {
    id: 'periods',
    phase: 'shape',
    eyebrow: 'Periods',
    label: 'Train, validate, test',
    icon: 'calendarRange',
    // Between Features and Learner because that is where qlib applies the
    // split -- `fit_start_time`/`fit_end_time` land on the handler's processors.
    owns: [
      'train_start', 'train_end', 'valid_start', 'valid_end', 'test_start', 'test_end',
    ],
  },
  learner: {
    id: 'learner',
    phase: 'fit',
    eyebrow: 'Learner',
    label: 'What fits the signal',
    icon: 'cpu',
    // Exactly one field, and that is the point: which model to use is a setting
    // with a default, not the first decision. Sweeping several is ML Studio's job.
    owns: ['model'],
  },
  portfolio: {
    id: 'portfolio',
    phase: 'execute',
    eyebrow: 'Portfolio',
    label: 'How the signal is traded',
    icon: 'layers',
    owns: ['topk', 'n_drop'],
  },
  costs: {
    id: 'costs',
    phase: 'execute',
    eyebrow: 'Costs',
    label: 'What trading takes off the top',
    icon: 'receipt',
    owns: ['open_cost', 'close_cost', 'min_cost', 'account', 'limit_threshold'],
  },
}

/** Phase display names, in pipeline order. Used by the stage strip. */
export const PHASE_ORDER = ['data', 'shape', 'fit', 'execute'] as const

export const PHASE_LABELS: Readonly<Record<StagePhase, string>> = {
  data: 'Data',
  shape: 'Shape',
  fit: 'Fit',
  execute: 'Execute',
}

/** The stage that owns a spec field, or null. Used to route a warning by key. */
export function stageOwning(key: keyof StrategySpec): StageId | null {
  for (const id of STAGE_ORDER) {
    if (STAGES[id].owns.includes(key)) return id
  }
  return null
}
