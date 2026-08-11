/**
 * A strategy as sentences, assembled from the spec.
 *
 * The builder's primary explanation of itself used to be a hundred-line qrun
 * YAML. That is precise, and it answers none of the questions a person actually
 * has — starting with "what is it predicting?", whose answer appeared nowhere in
 * the UI at all.
 *
 * Two rules hold this honest:
 *
 * **Nothing is invented.** The prediction target comes from `explain.label`,
 * read out of qlib server-side. When the server cannot say, the clause is
 * *omitted* rather than filled with a plausible default — a confident wrong
 * sentence about what a model predicts is worse than no sentence.
 *
 * **No assumption prose.** `strategy_gen/draft.py` has a `_WHY` table, but it
 * says things like "not stated, so the default learner is used". Rendered under
 * a field the reader just set, that reads as a lie. It belongs where it already
 * is: the template popover's "Filled in for you", and the assistant's proposal
 * notes.
 */
import type { StrategyExplain, StrategySpec } from '@/lib/api'
import { roundTripBps, toBps } from '@/lib/bps'

export interface Clause {
  key: string
  /** The sentence. */
  text: string
  /** The literal behind it — an expression, a raw number. Shown on hover. */
  detail?: string
}

const HANDLER_COLUMNS: Record<string, number> = { Alpha158: 158, Alpha360: 360 }

const MODEL_LABEL: Record<string, string> = {
  lightgbm: 'LightGBM',
  xgboost: 'XGBoost',
  catboost: 'CatBoost',
  linear: 'a ridge linear model',
  double_ensemble: 'a DoubleEnsemble',
}

/** `100000000` -> `100,000,000`. A spec's account is eight digits and unreadable raw. */
const money = (value: number) => value.toLocaleString('en-US', { maximumFractionDigits: 0 })

const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many)

/**
 * How the target reads in words.
 *
 * `Ref($close,-2)/Ref($close,-1)-1` is habitually called a two-day return, and
 * it is not one: it is the return *between* two future closes. Two days of
 * look-ahead, one session of exposure. Both numbers are served precisely so
 * this sentence can keep them apart.
 */
function targetText(label: NonNullable<StrategyExplain['label']>): string {
  const { horizon_days: horizon, holding_days: holding } = label
  if (holding === 1 && horizon === 2) {
    return 'Ranks names by their predicted return from tomorrow’s close to the '
      + 'next close — one session of exposure, scored two days ahead.'
  }
  if (horizon && holding) {
    return `Ranks names by a predicted ${holding}-session return, scored `
      + `${horizon} ${plural(horizon, 'day')} ahead.`
  }
  return 'Ranks names by the handler’s own forward-return label.'
}

export function summarise(
  spec: StrategySpec,
  explain?: StrategyExplain,
  universeCount?: number | null,
): Clause[] {
  const clauses: Clause[] = []

  // 1. What is being predicted. Omitted entirely when the server cannot say.
  if (explain?.label) {
    clauses.push({
      key: 'target',
      text: targetText(explain.label),
      detail: explain.label.expression,
    })
  }

  // 2. Over which names.
  const size = typeof universeCount === 'number' && universeCount > 0
    ? `the ${universeCount.toLocaleString('en-US')} names in `
    : 'the '
  clauses.push({
    key: 'universe',
    text: `Ranked across ${size}${spec.universe}, on the ${spec.data_store} store.`,
  })

  // 3. What learns it, and from what.
  const model = MODEL_LABEL[spec.model] ?? spec.model
  const custom = spec.features?.length ?? 0
  const columns = HANDLER_COLUMNS[spec.handler]
  let features: string
  if (!custom) {
    features = `${spec.handler}’s own ${columns ? `${columns} ` : ''}factors`
  } else if (spec.feature_mode === 'replace') {
    features = `${custom} custom ${plural(custom, 'column')}, replacing ${spec.handler}’s`
  } else {
    features = `${spec.handler}’s own ${columns ? `${columns} ` : ''}factors `
      + `plus ${custom} custom ${plural(custom, 'column')}`
  }
  clauses.push({ key: 'model', text: `Learned by ${model} on ${features}.` })

  // 4. The windows, and where the run really stops.
  const clamped = explain?.effective_test_end
    && explain.effective_test_end !== spec.test_end
  clauses.push({
    key: 'windows',
    text: `Trained ${spec.train_start} to ${spec.train_end}, validated to `
      + `${spec.valid_end}, then backtested ${spec.test_start} to `
      + `${clamped ? explain!.effective_test_end : spec.test_end}.`
      + (clamped
        ? ` The run stops at ${explain!.effective_test_end} — the last day this `
          + 'store can safely backtest.'
        : ''),
    detail: clamped ? `you asked for ${spec.test_end}` : undefined,
  })

  // 5. What it holds. Daily is not a setting — `TopkDropoutStrategy` rebalances
  //    every bar — so it is stated rather than offered.
  clauses.push({
    key: 'portfolio',
    text: `Holds the top ${spec.topk}, replacing up to ${spec.n_drop} each session.`,
  })

  // 6. What it costs. In bps, and with the round trip spelled out — the two legs
  //    are configured apart and the number that matters is their sum.
  clauses.push({
    key: 'cost',
    text: `Costs ${toBps(spec.open_cost)} bps to open and ${toBps(spec.close_cost)} bps `
      + `to close — ${roundTripBps(spec.open_cost, spec.close_cost)} bps round trip — `
      + `with a floor of USD ${money(spec.min_cost)} per trade. `
      + `Starting capital USD ${money(spec.account)}.`,
  })

  clauses.push({
    key: 'benchmark',
    text: `Reported against ${spec.benchmark}, net of cost.`,
  })

  // 7. Only when set. There is no control for it, so a spec carrying one came
  //    from a template or the assistant — and it would otherwise be invisible.
  if (spec.limit_threshold != null) {
    clauses.push({
      key: 'limit',
      text: `Fills are refused when a name moves more than `
        + `${(spec.limit_threshold * 100).toFixed(1)}% in a day. That is a China `
        + `price-limit rule, and unusual for this store.`,
    })
  }

  return clauses
}
