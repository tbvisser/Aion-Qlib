/**
 * Static fallback strategy templates for the Keycard Builder.
 *
 * These mirror the shipped strategy templates in
 * `webapp/api/strategy_gen/templates/`. When the backend is online and the
 * migration has run, `/api/keycards?is_template=true` returns the same set
 * (with stable ids `template-{id}`), so the palette deduplicates and the
 * fallback becomes invisible. When the backend is offline, the builder still
 * offers a useful starting gallery.
 *
 * The gallery provides Aion-style rule workflows (Schedule -> Rules -> buy_now -> portfolio -> costs -> records).
 */
import type { Keycard, KeycardNode, KeycardSpec, KeycardWindows } from '@/lib/api'
import { layoutTree } from './keycardFlow'

const DEFAULT_WINDOWS: KeycardWindows = {
  train_start: '2010-01-04',
  train_end: '2019-12-31',
  valid_start: '2020-01-01',
  valid_end: '2021-12-31',
  test_start: '2022-01-01',
  test_end: '2026-08-07',
}

const LEFT = 100
const TOP = 300
const SPACING = 220

interface AionTemplateDef {
  id: string
  name: string
  description: string
  tags: string[]
  family: string
  schedule: { type: string; config: Record<string, unknown> }
  rules: { type: string; config: Record<string, unknown> }[]
  buy: { config: Record<string, unknown> }
  portfolio: { topk: number; nDrop: number }
  windows?: Partial<KeycardWindows>
}

const aionDefs: AionTemplateDef[] = [
  {
    id: 'opening-range-breakout',
    name: 'Opening Range Breakout',
    description:
      'Aion-style rule workflow: run once per candle, require the previous day to be bullish, then wait for a close above the 30-minute opening range before buying.',
    tags: ['aion', 'breakout', 'rules'],
    family: 'aion',
    schedule: { type: 'run_per_candle', config: { timeframe: '1d' } },
    rules: [
      { type: 'previous_day_bullish', config: { lookback: 1 } },
      { type: 'candle_close_above_opening_range', config: { minutes: 30 } },
    ],
    buy: { config: { side: 'long', size: '100%' } },
    portfolio: { topk: 50, nDrop: 5 },
  },
  {
    id: 'bullish-continuation',
    name: 'Bullish Continuation',
    description:
      'Aion-style rule workflow: buy when the previous day was bullish and the current price is above the prior close.',
    tags: ['aion', 'momentum', 'rules'],
    family: 'aion',
    schedule: { type: 'run_per_candle', config: { timeframe: '1d' } },
    rules: [
      { type: 'previous_day_bullish', config: { lookback: 1 } },
      { type: 'price_above_previous_day_close', config: { confirm: true } },
    ],
    buy: { config: { side: 'long', size: '100%' } },
    portfolio: { topk: 50, nDrop: 5 },
  },
  {
    id: 'news-aware-breakout',
    name: 'News-Aware Breakout',
    description:
      'Aion-style rule workflow: opening-range breakout filtered by a general-news sentiment filter.',
    tags: ['aion', 'news', 'breakout'],
    family: 'aion',
    schedule: { type: 'run_per_candle', config: { timeframe: '1d' } },
    rules: [
      { type: 'previous_day_bullish', config: { lookback: 1 } },
      { type: 'news_filter', config: { source: 'general', sentiment: 'positive' } },
      { type: 'candle_close_above_opening_range', config: { minutes: 30 } },
    ],
    buy: { config: { side: 'long', size: '100%' } },
    portfolio: { topk: 30, nDrop: 5 },
  },
]

function buildAionKeycard(def: AionTemplateDef): Keycard {
  const windows = { ...DEFAULT_WINDOWS, ...def.windows }
  const scheduleId = 'schedule-1'
  const buyId = 'buy-1'
  const portfolioId = 'portfolio-1'
  const costsId = 'costs-1'
  const recordsId = 'records-1'

  const nodes: KeycardSpec['nodes'] = [
    {
      id: scheduleId,
      type: def.schedule.type,
      position: { x: LEFT, y: TOP },
      config: def.schedule.config,
      notes: '',
    },
    ...def.rules.map((rule, i) => ({
      id: `rule-${i + 1}`,
      type: rule.type,
      position: { x: LEFT + SPACING * (i + 1), y: TOP },
      config: rule.config,
      notes: '',
    })),
    {
      id: buyId,
      type: 'buy_now',
      position: { x: LEFT + SPACING * (def.rules.length + 1), y: TOP },
      config: def.buy.config,
      notes: '',
    },
    {
      id: portfolioId,
      type: 'portfolio',
      position: { x: LEFT + SPACING * (def.rules.length + 2), y: TOP },
      config: { strategy: 'TopkDropoutStrategy', topk: def.portfolio.topk, n_drop: def.portfolio.nDrop },
      notes: '',
    },
    {
      id: costsId,
      type: 'costs',
      position: { x: LEFT + SPACING * (def.rules.length + 3), y: TOP },
      config: { open_cost: 0.0005, close_cost: 0.0015, min_cost: 5, account: 100_000_000 },
      notes: '',
    },
    {
      id: recordsId,
      type: 'records',
      position: { x: LEFT + SPACING * (def.rules.length + 4), y: TOP },
      config: {},
      notes: '',
    },
  ]

  const edges: KeycardSpec['edges'] = []
  let previousId = scheduleId
  def.rules.forEach((_, i) => {
    const ruleId = `rule-${i + 1}`
    edges.push({
      id: `e-${i + 1}`,
      source: previousId,
      source_port: 'trigger',
      target: ruleId,
      target_port: 'trigger',
    })
    previousId = ruleId
  })
  edges.push({
    id: `e-${def.rules.length + 1}`,
    source: previousId,
    source_port: 'trigger',
    target: buyId,
    target_port: 'trigger',
  })
  edges.push({
    id: `e-${def.rules.length + 2}`,
    source: buyId,
    source_port: 'signal',
    target: portfolioId,
    target_port: 'signal',
  })
  edges.push({
    id: `e-${def.rules.length + 3}`,
    source: portfolioId,
    source_port: 'trades',
    target: costsId,
    target_port: 'trades',
  })
  edges.push({
    id: `e-${def.rules.length + 4}`,
    source: costsId,
    source_port: 'trades',
    target: recordsId,
    target_port: 'trades',
  })

  return {
    id: `template-${def.id}`,
    name: def.name,
    description: def.description,
    tags: def.tags,
    is_template: true,
    template_family: def.family,
    nodes,
    edges,
    windows,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    user_id: 'system',
    visibility: 'org',
  } as Keycard
}

function buildExampleKeycard(
  id: string,
  name: string,
  description: string,
  tags: string[],
  nodes: Array<Omit<KeycardNode, 'position'>>,
  edges: KeycardSpec['edges'],
  family: string = 'examples',
  windows?: Partial<KeycardWindows>,
): Keycard {
  const spec: KeycardSpec = {
    name,
    description,
    tags,
    is_template: true,
    template_family: family,
    windows: { ...DEFAULT_WINDOWS, ...windows },
    nodes: nodes.map((n) => ({ ...n, position: { x: 0, y: 0 } })),
    edges,
  }
  const positions = layoutTree(spec)
  return {
    id: `template-${id}`,
    name,
    description,
    tags,
    is_template: true,
    template_family: family,
    nodes: spec.nodes.map((n) => ({ ...n, position: positions.get(n.id) ?? { x: 0, y: 0 } })),
    edges,
    windows: spec.windows,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    user_id: 'system',
    visibility: 'org',
  } as Keycard
}

const EXAMPLE_TEMPLATES: Keycard[] = [
  buildExampleKeycard(
    'example-1-nested-branches',
    'Example 1 — Nested Branches',
    'A rule workflow with two nested Branch nodes: only enters the trade when price, volume and news all line up.',
    ['example', 'branching', 'rules'],
    [
      { id: 'schedule-1', type: 'run_per_candle', config: { timeframe: '1d' }, notes: '' },
      { id: 'branch-1', type: 'branch', config: { condition: 'close > open' }, notes: '' },
      { id: 'branch-2', type: 'branch', config: { condition: 'volume > Mean($volume,20)' }, notes: '' },
      { id: 'news-1', type: 'branch', config: { condition: 'news_sentiment > 0' }, notes: '' },
      { id: 'buy-1', type: 'buy_now', config: { side: 'long', size: '100%' }, notes: '' },
      { id: 'portfolio-1', type: 'portfolio', config: { strategy: 'TopkDropoutStrategy', topk: 30, n_drop: 5 }, notes: '' },
      { id: 'costs-1', type: 'costs', config: { open_cost: 0.0005, close_cost: 0.0015, min_cost: 5, account: 100_000_000 }, notes: '' },
      { id: 'records-1', type: 'records', config: {}, notes: '' },
      { id: 'no-trade-1', type: 'no_trade_for_day', config: { reason: 'price not bullish' }, notes: '' },
      { id: 'no-trade-2', type: 'no_trade_for_day', config: { reason: 'volume too low' }, notes: '' },
      { id: 'no-trade-3', type: 'no_trade_for_day', config: { reason: 'news not positive' }, notes: '' },
    ],
    [
      { id: 'e1', source: 'schedule-1', source_port: 'trigger', target: 'branch-1', target_port: 'trigger' },
      { id: 'e2', source: 'branch-1', source_port: 'true', target: 'branch-2', target_port: 'trigger' },
      { id: 'e3', source: 'branch-1', source_port: 'false', target: 'no-trade-1', target_port: 'trigger' },
      { id: 'e4', source: 'branch-2', source_port: 'true', target: 'news-1', target_port: 'trigger' },
      { id: 'e5', source: 'branch-2', source_port: 'false', target: 'no-trade-2', target_port: 'trigger' },
      { id: 'e6', source: 'news-1', source_port: 'trigger', target: 'buy-1', target_port: 'trigger' },
      { id: 'e7', source: 'news-1', source_port: 'trigger', target: 'no-trade-3', target_port: 'trigger' },
      { id: 'e8', source: 'buy-1', source_port: 'signal', target: 'portfolio-1', target_port: 'signal' },
      { id: 'e9', source: 'portfolio-1', source_port: 'trades', target: 'costs-1', target_port: 'trades' },
      { id: 'e10', source: 'costs-1', source_port: 'trades', target: 'records-1', target_port: 'trades' },
    ],
  ),
  buildExampleKeycard(
    'example-2-parallel-paths',
    'Example 2 — Parallel Paths',
    'One schedule fans out to three independent rule chains, each with its own execution path.',
    ['example', 'parallel', 'rules'],
    [
      { id: 'schedule-1', type: 'run_per_candle', config: { timeframe: '1d' }, notes: '' },
      { id: 'rule-a', type: 'previous_day_bullish', config: { lookback: 1 }, notes: '' },
      { id: 'rule-b', type: 'price_above_previous_day_close', config: { confirm: true }, notes: '' },
      { id: 'rule-c', type: 'candle_close_above_opening_range', config: { minutes: 30 }, notes: '' },
      { id: 'buy-a', type: 'buy_now', config: { side: 'long', size: '100%' }, notes: '' },
      { id: 'buy-b', type: 'buy_now', config: { side: 'long', size: '100%' }, notes: '' },
      { id: 'buy-c', type: 'buy_now', config: { side: 'long', size: '100%' }, notes: '' },
      { id: 'portfolio-a', type: 'portfolio', config: { strategy: 'TopkDropoutStrategy', topk: 20, n_drop: 5 }, notes: '' },
      { id: 'portfolio-b', type: 'portfolio', config: { strategy: 'TopkDropoutStrategy', topk: 20, n_drop: 5 }, notes: '' },
      { id: 'portfolio-c', type: 'portfolio', config: { strategy: 'TopkDropoutStrategy', topk: 20, n_drop: 5 }, notes: '' },
      { id: 'costs-a', type: 'costs', config: { open_cost: 0.0005, close_cost: 0.0015, min_cost: 5, account: 100_000_000 }, notes: '' },
      { id: 'costs-b', type: 'costs', config: { open_cost: 0.0005, close_cost: 0.0015, min_cost: 5, account: 100_000_000 }, notes: '' },
      { id: 'costs-c', type: 'costs', config: { open_cost: 0.0005, close_cost: 0.0015, min_cost: 5, account: 100_000_000 }, notes: '' },
      { id: 'records-a', type: 'records', config: {}, notes: '' },
      { id: 'records-b', type: 'records', config: {}, notes: '' },
      { id: 'records-c', type: 'records', config: {}, notes: '' },
    ],
    [
      { id: 'e1', source: 'schedule-1', source_port: 'trigger', target: 'rule-a', target_port: 'trigger' },
      { id: 'e2', source: 'schedule-1', source_port: 'trigger', target: 'rule-b', target_port: 'trigger' },
      { id: 'e3', source: 'schedule-1', source_port: 'trigger', target: 'rule-c', target_port: 'trigger' },
      { id: 'e4', source: 'rule-a', source_port: 'trigger', target: 'buy-a', target_port: 'trigger' },
      { id: 'e5', source: 'rule-b', source_port: 'trigger', target: 'buy-b', target_port: 'trigger' },
      { id: 'e6', source: 'rule-c', source_port: 'trigger', target: 'buy-c', target_port: 'trigger' },
      { id: 'e7', source: 'buy-a', source_port: 'signal', target: 'portfolio-a', target_port: 'signal' },
      { id: 'e8', source: 'buy-b', source_port: 'signal', target: 'portfolio-b', target_port: 'signal' },
      { id: 'e9', source: 'buy-c', source_port: 'signal', target: 'portfolio-c', target_port: 'signal' },
      { id: 'e10', source: 'portfolio-a', source_port: 'trades', target: 'costs-a', target_port: 'trades' },
      { id: 'e11', source: 'portfolio-b', source_port: 'trades', target: 'costs-b', target_port: 'trades' },
      { id: 'e12', source: 'portfolio-c', source_port: 'trades', target: 'costs-c', target_port: 'trades' },
      { id: 'e13', source: 'costs-a', source_port: 'trades', target: 'records-a', target_port: 'trades' },
      { id: 'e14', source: 'costs-b', source_port: 'trades', target: 'records-b', target_port: 'trades' },
      { id: 'e15', source: 'costs-c', source_port: 'trades', target: 'records-c', target_port: 'trades' },
    ],
  ),
  buildExampleKeycard(
    'example-3-decision-tree',
    'Example 3 — Decision Tree',
    'A deeper tree: market direction decides whether to check spread, and a final news filter gates the trade.',
    ['example', 'tree', 'rules'],
    [
      { id: 'schedule-1', type: 'run_at_time', config: { time: '09:31', timezone: 'America/New_York' }, notes: '' },
      { id: 'branch-market', type: 'branch', config: { condition: 'close > Ref(close,1)' }, notes: '' },
      { id: 'branch-spread', type: 'branch', config: { condition: 'spread_bps < 10' }, notes: '' },
      { id: 'branch-news', type: 'branch', config: { condition: 'news_sentiment > 0' }, notes: '' },
      { id: 'buy-1', type: 'buy_now', config: { side: 'long', size: '100%' }, notes: '' },
      { id: 'portfolio-1', type: 'portfolio', config: { strategy: 'TopkDropoutStrategy', topk: 50, n_drop: 5 }, notes: '' },
      { id: 'costs-1', type: 'costs', config: { open_cost: 0.0005, close_cost: 0.0015, min_cost: 5, account: 100_000_000 }, notes: '' },
      { id: 'records-1', type: 'records', config: {}, notes: '' },
      { id: 'oversold-1', type: 'branch', config: { condition: 'RSI($close,14) < 30' }, notes: '' },
      { id: 'mean-reversion-buy', type: 'buy_now', config: { side: 'long', size: '50%' }, notes: '' },
      { id: 'portfolio-mr', type: 'portfolio', config: { strategy: 'TopkDropoutStrategy', topk: 20, n_drop: 5 }, notes: '' },
      { id: 'costs-mr', type: 'costs', config: { open_cost: 0.0005, close_cost: 0.0015, min_cost: 5, account: 100_000_000 }, notes: '' },
      { id: 'records-mr', type: 'records', config: {}, notes: '' },
      { id: 'no-trade-2', type: 'no_trade_for_day', config: { reason: 'spread too wide' }, notes: '' },
      { id: 'no-trade-3', type: 'no_trade_for_day', config: { reason: 'news negative' }, notes: '' },
      { id: 'no-trade-4', type: 'no_trade_for_day', config: { reason: 'not oversold' }, notes: '' },
    ],
    [
      { id: 'e1', source: 'schedule-1', source_port: 'trigger', target: 'branch-market', target_port: 'trigger' },
      { id: 'e2', source: 'branch-market', source_port: 'true', target: 'branch-spread', target_port: 'trigger' },
      { id: 'e3', source: 'branch-market', source_port: 'false', target: 'oversold-1', target_port: 'trigger' },
      { id: 'e4', source: 'branch-spread', source_port: 'true', target: 'branch-news', target_port: 'trigger' },
      { id: 'e5', source: 'branch-spread', source_port: 'false', target: 'no-trade-2', target_port: 'trigger' },
      { id: 'e6', source: 'branch-news', source_port: 'true', target: 'buy-1', target_port: 'trigger' },
      { id: 'e7', source: 'branch-news', source_port: 'false', target: 'no-trade-3', target_port: 'trigger' },
      { id: 'e8', source: 'buy-1', source_port: 'signal', target: 'portfolio-1', target_port: 'signal' },
      { id: 'e9', source: 'portfolio-1', source_port: 'trades', target: 'costs-1', target_port: 'trades' },
      { id: 'e10', source: 'costs-1', source_port: 'trades', target: 'records-1', target_port: 'trades' },
      { id: 'e11', source: 'oversold-1', source_port: 'true', target: 'mean-reversion-buy', target_port: 'trigger' },
      { id: 'e12', source: 'oversold-1', source_port: 'false', target: 'no-trade-4', target_port: 'trigger' },
      { id: 'e13', source: 'mean-reversion-buy', source_port: 'signal', target: 'portfolio-mr', target_port: 'signal' },
      { id: 'e14', source: 'portfolio-mr', source_port: 'trades', target: 'costs-mr', target_port: 'trades' },
      { id: 'e15', source: 'costs-mr', source_port: 'trades', target: 'records-mr', target_port: 'trades' },
    ],
  ),
]

export const STATIC_KEYCARD_TEMPLATES: Keycard[] = [
  // Universe
  buildExampleKeycard(
    'sp500-breakout',
    `SP500 Breakout`,
    `Momentum breakout on the broad US large-cap universe, framed as an S&P 500 breakout strategy. The model is given the distance to the 20-day high as an extra signal.`,
    ['sp500', 'breakout', 'momentum'],
  [
    { id: 'sp500-ctx', type: 'context', config: { text: 'S&P 500 breakout. Store: us, universe: top500, benchmark: SPY. Enter on a close above the 20-day high after a bullish market filter.' }, notes: '' },
    { id: 'sp500-var', type: 'variable', config: { name: 'breakout_threshold', value: '0.0' }, notes: '' },
    { id: 'sp500-draw', type: 'chart_drawing', config: { type: 'level', price: 0 }, notes: '' },
    { id: 'sp500-sched', type: 'run_per_candle', config: { timeframe: '1d' }, notes: '' },
    { id: 'sp500-mkt', type: 'branch', config: { condition: 'close > EMA($close,50)' }, notes: '' },
    { id: 'sp500-prev', type: 'previous_day_bullish', config: { lookback: 1 }, notes: '' },
    { id: 'sp500-spread', type: 'check_spread', config: { max_spread_bps: 10 }, notes: '' },
    { id: 'sp500-news', type: 'news_filter', config: { source: 'general', sentiment: 'positive' }, notes: '' },
    { id: 'sp500-entry', type: 'branch', config: { condition: '$close > Ref(Max($high,20),1)' }, notes: '' },
    { id: 'sp500-buy', type: 'buy_now', config: { side: 'long', size: '100%' }, notes: '' },
    { id: 'sp500-port', type: 'portfolio', config: { strategy: 'TopkDropoutStrategy', topk: 20, n_drop: 5 }, notes: '' },
    { id: 'sp500-costs', type: 'costs', config: { open_cost: 0.0005, close_cost: 0.0015, min_cost: 5, account: 100000000 }, notes: '' },
    { id: 'sp500-rec', type: 'records', config: {  }, notes: '' },
    { id: 'sp500-no-mkt', type: 'no_trade_for_day', config: { reason: 'market filter failed' }, notes: '' },
    { id: 'sp500-no-entry', type: 'no_trade_for_day', config: { reason: 'entry condition failed' }, notes: '' }
  ],
  [
    { id: 'sp500-e1', source: 'sp500-sched', source_port: 'trigger', target: 'sp500-mkt', target_port: 'trigger' },
    { id: 'sp500-e2', source: 'sp500-mkt', source_port: 'true', target: 'sp500-prev', target_port: 'trigger' },
    { id: 'sp500-e3', source: 'sp500-mkt', source_port: 'false', target: 'sp500-no-mkt', target_port: 'trigger' },
    { id: 'sp500-e4', source: 'sp500-prev', source_port: 'trigger', target: 'sp500-spread', target_port: 'trigger' },
    { id: 'sp500-e5', source: 'sp500-spread', source_port: 'trigger', target: 'sp500-entry', target_port: 'trigger' },
    { id: 'sp500-e6', source: 'sp500-news', source_port: 'trigger', target: 'sp500-entry', target_port: 'trigger' },
    { id: 'sp500-e7', source: 'sp500-draw', source_port: 'trigger', target: 'sp500-entry', target_port: 'trigger' },
    { id: 'sp500-e8', source: 'sp500-entry', source_port: 'true', target: 'sp500-buy', target_port: 'trigger' },
    { id: 'sp500-e9', source: 'sp500-entry', source_port: 'false', target: 'sp500-no-entry', target_port: 'trigger' },
    { id: 'sp500-e10', source: 'sp500-buy', source_port: 'signal', target: 'sp500-port', target_port: 'signal' },
    { id: 'sp500-e11', source: 'sp500-port', source_port: 'trades', target: 'sp500-costs', target_port: 'trades' },
    { id: 'sp500-e12', source: 'sp500-costs', source_port: 'trades', target: 'sp500-rec', target_port: 'trades' }
  ],
    'universe',
  ),
  buildExampleKeycard(
    'crypto-breakout',
    `Crypto Breakout`,
    `A tight momentum book on the top 100 crypto names. Runs on the 365-day calendar and benchmarks against BTC-USD.`,
    ['crypto', 'breakout', 'momentum'],
  [
    { id: 'crypto-ctx', type: 'context', config: { text: 'Crypto breakout. Store: crypto_365, universe: crypto_top100, benchmark: BTC-USD. Trade breakouts on the 365-day calendar.' }, notes: '' },
    { id: 'crypto-var', type: 'variable', config: { name: 'crypto_lookback', value: '20' }, notes: '' },
    { id: 'crypto-draw', type: 'chart_drawing', config: { type: 'level', price: 0 }, notes: '' },
    { id: 'crypto-sched', type: 'run_per_candle', config: { timeframe: '1d' }, notes: '' },
    { id: 'crypto-mkt', type: 'branch', config: { condition: 'close > EMA($close,20)' }, notes: '' },
    { id: 'crypto-prev', type: 'previous_day_bullish', config: { lookback: 1 }, notes: '' },
    { id: 'crypto-spread', type: 'check_spread', config: { max_spread_bps: 10 }, notes: '' },
    { id: 'crypto-news', type: 'news_filter', config: { source: 'macro', sentiment: 'positive' }, notes: '' },
    { id: 'crypto-entry', type: 'branch', config: { condition: '$close > Ref(Max($high,20),1)' }, notes: '' },
    { id: 'crypto-buy', type: 'buy_now', config: { side: 'long', size: '100%' }, notes: '' },
    { id: 'crypto-port', type: 'portfolio', config: { strategy: 'TopkDropoutStrategy', topk: 10, n_drop: 2 }, notes: '' },
    { id: 'crypto-costs', type: 'costs', config: { open_cost: 0.0005, close_cost: 0.0015, min_cost: 5, account: 100000000 }, notes: '' },
    { id: 'crypto-rec', type: 'records', config: {  }, notes: '' },
    { id: 'crypto-no-mkt', type: 'no_trade_for_day', config: { reason: 'market filter failed' }, notes: '' },
    { id: 'crypto-no-entry', type: 'no_trade_for_day', config: { reason: 'entry condition failed' }, notes: '' }
  ],
  [
    { id: 'crypto-e1', source: 'crypto-sched', source_port: 'trigger', target: 'crypto-mkt', target_port: 'trigger' },
    { id: 'crypto-e2', source: 'crypto-mkt', source_port: 'true', target: 'crypto-prev', target_port: 'trigger' },
    { id: 'crypto-e3', source: 'crypto-mkt', source_port: 'false', target: 'crypto-no-mkt', target_port: 'trigger' },
    { id: 'crypto-e4', source: 'crypto-prev', source_port: 'trigger', target: 'crypto-spread', target_port: 'trigger' },
    { id: 'crypto-e5', source: 'crypto-spread', source_port: 'trigger', target: 'crypto-entry', target_port: 'trigger' },
    { id: 'crypto-e6', source: 'crypto-news', source_port: 'trigger', target: 'crypto-entry', target_port: 'trigger' },
    { id: 'crypto-e7', source: 'crypto-draw', source_port: 'trigger', target: 'crypto-entry', target_port: 'trigger' },
    { id: 'crypto-e8', source: 'crypto-entry', source_port: 'true', target: 'crypto-buy', target_port: 'trigger' },
    { id: 'crypto-e9', source: 'crypto-entry', source_port: 'false', target: 'crypto-no-entry', target_port: 'trigger' },
    { id: 'crypto-e10', source: 'crypto-buy', source_port: 'signal', target: 'crypto-port', target_port: 'signal' },
    { id: 'crypto-e11', source: 'crypto-port', source_port: 'trades', target: 'crypto-costs', target_port: 'trades' },
    { id: 'crypto-e12', source: 'crypto-costs', source_port: 'trades', target: 'crypto-rec', target_port: 'trades' }
  ],
    'universe',
  ),
  buildExampleKeycard(
    'index-breakout',
    `Index Breakout`,
    `Momentum breakout on a curated set of index proxies. The cross-section is small, so read it as a timing signal on broad exposures rather than stock selection.`,
    ['index', 'breakout', 'momentum'],
  [
    { id: 'index-ctx', type: 'context', config: { text: 'Index breakout. Store: us, universe: index_top50, benchmark: SPY. Timing signal on broad index exposures.' }, notes: '' },
    { id: 'index-var', type: 'variable', config: { name: 'index_topk', value: '10' }, notes: '' },
    { id: 'index-draw', type: 'chart_drawing', config: { type: 'zone', price: 0 }, notes: '' },
    { id: 'index-sched', type: 'run_at_time', config: { time: '09:31', timezone: 'America/New_York' }, notes: '' },
    { id: 'index-mkt', type: 'branch', config: { condition: 'close > Ref(close,1)' }, notes: '' },
    { id: 'index-prev', type: 'previous_day_bullish', config: { lookback: 1 }, notes: '' },
    { id: 'index-open', type: 'candle_close_above_opening_range', config: { minutes: 30 }, notes: '' },
    { id: 'index-spread', type: 'check_spread', config: { max_spread_bps: 10 }, notes: '' },
    { id: 'index-news', type: 'news_filter', config: { source: 'general', sentiment: 'positive' }, notes: '' },
    { id: 'index-entry', type: 'branch', config: { condition: '$close > Ref(Max($high,20),1)' }, notes: '' },
    { id: 'index-buy', type: 'buy_now', config: { side: 'long', size: '100%' }, notes: '' },
    { id: 'index-port', type: 'portfolio', config: { strategy: 'TopkDropoutStrategy', topk: 10, n_drop: 2 }, notes: '' },
    { id: 'index-costs', type: 'costs', config: { open_cost: 0.0005, close_cost: 0.0015, min_cost: 5, account: 100000000 }, notes: '' },
    { id: 'index-rec', type: 'records', config: {  }, notes: '' },
    { id: 'index-no-mkt', type: 'no_trade_for_day', config: { reason: 'market filter failed' }, notes: '' },
    { id: 'index-no-entry', type: 'no_trade_for_day', config: { reason: 'entry condition failed' }, notes: '' }
  ],
  [
    { id: 'index-e1', source: 'index-sched', source_port: 'trigger', target: 'index-mkt', target_port: 'trigger' },
    { id: 'index-e2', source: 'index-mkt', source_port: 'true', target: 'index-prev', target_port: 'trigger' },
    { id: 'index-e3', source: 'index-mkt', source_port: 'false', target: 'index-no-mkt', target_port: 'trigger' },
    { id: 'index-e4', source: 'index-prev', source_port: 'trigger', target: 'index-open', target_port: 'trigger' },
    { id: 'index-e5', source: 'index-open', source_port: 'trigger', target: 'index-spread', target_port: 'trigger' },
    { id: 'index-e6', source: 'index-spread', source_port: 'trigger', target: 'index-entry', target_port: 'trigger' },
    { id: 'index-e7', source: 'index-news', source_port: 'trigger', target: 'index-entry', target_port: 'trigger' },
    { id: 'index-e8', source: 'index-draw', source_port: 'trigger', target: 'index-entry', target_port: 'trigger' },
    { id: 'index-e9', source: 'index-entry', source_port: 'true', target: 'index-buy', target_port: 'trigger' },
    { id: 'index-e10', source: 'index-entry', source_port: 'false', target: 'index-no-entry', target_port: 'trigger' },
    { id: 'index-e11', source: 'index-buy', source_port: 'signal', target: 'index-port', target_port: 'signal' },
    { id: 'index-e12', source: 'index-port', source_port: 'trades', target: 'index-costs', target_port: 'trades' },
    { id: 'index-e13', source: 'index-costs', source_port: 'trades', target: 'index-rec', target_port: 'trades' }
  ],
    'universe',
  ),
  buildExampleKeycard(
    'etf-momentum',
    `ETF Momentum`,
    `Cross-asset momentum on the top 100 ETFs. Correlations are high, so read this as exposure rotation rather than stock selection.`,
    ['etf', 'momentum', 'rotation'],
  [
    { id: 'etf-ctx', type: 'context', config: { text: 'ETF momentum rotation. Store: us, universe: etf_top100, benchmark: SPY. Rotate into the strongest ETFs using 12-month and 3-month momentum.' }, notes: '' },
    { id: 'etf-var', type: 'variable', config: { name: 'momentum_horizon', value: '252' }, notes: '' },
    { id: 'etf-draw', type: 'chart_drawing', config: { type: 'trend', price: 0 }, notes: '' },
    { id: 'etf-sched', type: 'run_per_candle', config: { timeframe: '1d' }, notes: '' },
    { id: 'etf-mkt', type: 'branch', config: { condition: 'close > EMA($close,50)' }, notes: '' },
    { id: 'etf-prev', type: 'previous_day_bullish', config: { lookback: 1 }, notes: '' },
    { id: 'etf-mom12', type: 'trade_rule', config: { condition: 'Ref($close,21)/(Ref($close,252)+1e-12) - 1 > 0' }, notes: '' },
    { id: 'etf-spread', type: 'check_spread', config: { max_spread_bps: 10 }, notes: '' },
    { id: 'etf-news', type: 'news_filter', config: { source: 'general', sentiment: 'positive' }, notes: '' },
    { id: 'etf-entry', type: 'branch', config: { condition: 'Ref($close,21)/(Ref($close,63)+1e-12) - 1 > 0' }, notes: '' },
    { id: 'etf-buy', type: 'buy_now', config: { side: 'long', size: '100%' }, notes: '' },
    { id: 'etf-port', type: 'portfolio', config: { strategy: 'TopkDropoutStrategy', topk: 15, n_drop: 3 }, notes: '' },
    { id: 'etf-costs', type: 'costs', config: { open_cost: 0.0005, close_cost: 0.0015, min_cost: 5, account: 100000000 }, notes: '' },
    { id: 'etf-rec', type: 'records', config: {  }, notes: '' },
    { id: 'etf-no-mkt', type: 'no_trade_for_day', config: { reason: 'market filter failed' }, notes: '' },
    { id: 'etf-no-entry', type: 'no_trade_for_day', config: { reason: 'entry condition failed' }, notes: '' }
  ],
  [
    { id: 'etf-e1', source: 'etf-sched', source_port: 'trigger', target: 'etf-mkt', target_port: 'trigger' },
    { id: 'etf-e2', source: 'etf-mkt', source_port: 'true', target: 'etf-prev', target_port: 'trigger' },
    { id: 'etf-e3', source: 'etf-mkt', source_port: 'false', target: 'etf-no-mkt', target_port: 'trigger' },
    { id: 'etf-e4', source: 'etf-prev', source_port: 'trigger', target: 'etf-mom12', target_port: 'trigger' },
    { id: 'etf-e5', source: 'etf-mom12', source_port: 'trigger', target: 'etf-spread', target_port: 'trigger' },
    { id: 'etf-e6', source: 'etf-spread', source_port: 'trigger', target: 'etf-entry', target_port: 'trigger' },
    { id: 'etf-e7', source: 'etf-news', source_port: 'trigger', target: 'etf-entry', target_port: 'trigger' },
    { id: 'etf-e8', source: 'etf-draw', source_port: 'trigger', target: 'etf-entry', target_port: 'trigger' },
    { id: 'etf-e9', source: 'etf-entry', source_port: 'true', target: 'etf-buy', target_port: 'trigger' },
    { id: 'etf-e10', source: 'etf-entry', source_port: 'false', target: 'etf-no-entry', target_port: 'trigger' },
    { id: 'etf-e11', source: 'etf-buy', source_port: 'signal', target: 'etf-port', target_port: 'signal' },
    { id: 'etf-e12', source: 'etf-port', source_port: 'trades', target: 'etf-costs', target_port: 'trades' },
    { id: 'etf-e13', source: 'etf-costs', source_port: 'trades', target: 'etf-rec', target_port: 'trades' }
  ],
    'universe',
  ),

  // Factors
  buildExampleKeycard(
    'inside-bar-breakout',
    `Inside Bar Breakout`,
    `Price-action template: today's range contracts inside yesterday's, then breaks out. The signal is the ratio of today's range to yesterday's.`,
    ['price-action', 'breakout', 'alpha158'],
  [
    { id: 'inside-ctx', type: 'context', config: { text: 'Inside bar breakout. Store: us, universe: top500, benchmark: SPY. Wait for an inside day, then buy a breakout above the 5-day high.' }, notes: '' },
    { id: 'inside-var', type: 'variable', config: { name: 'range_shrink', value: '0.9' }, notes: '' },
    { id: 'inside-draw', type: 'chart_drawing', config: { type: 'zone', price: 0 }, notes: '' },
    { id: 'inside-sched', type: 'run_per_candle', config: { timeframe: '1d' }, notes: '' },
    { id: 'inside-mkt', type: 'branch', config: { condition: 'close > EMA($close,20)' }, notes: '' },
    { id: 'inside-prev', type: 'previous_day_bullish', config: { lookback: 1 }, notes: '' },
    { id: 'inside-inside', type: 'trade_rule', config: { condition: '($high - $low) < (Ref($high,1) - Ref($low,1))' }, notes: '' },
    { id: 'inside-spread', type: 'check_spread', config: { max_spread_bps: 10 }, notes: '' },
    { id: 'inside-news', type: 'news_filter', config: { source: 'general', sentiment: 'positive' }, notes: '' },
    { id: 'inside-entry', type: 'branch', config: { condition: '$close > Ref(Max($high,5),1)' }, notes: '' },
    { id: 'inside-buy', type: 'buy_now', config: { side: 'long', size: '100%' }, notes: '' },
    { id: 'inside-port', type: 'portfolio', config: { strategy: 'TopkDropoutStrategy', topk: 30, n_drop: 5 }, notes: '' },
    { id: 'inside-costs', type: 'costs', config: { open_cost: 0.0005, close_cost: 0.0015, min_cost: 5, account: 100000000 }, notes: '' },
    { id: 'inside-rec', type: 'records', config: {  }, notes: '' },
    { id: 'inside-no-mkt', type: 'no_trade_for_day', config: { reason: 'market filter failed' }, notes: '' },
    { id: 'inside-no-entry', type: 'no_trade_for_day', config: { reason: 'entry condition failed' }, notes: '' }
  ],
  [
    { id: 'inside-e1', source: 'inside-sched', source_port: 'trigger', target: 'inside-mkt', target_port: 'trigger' },
    { id: 'inside-e2', source: 'inside-mkt', source_port: 'true', target: 'inside-prev', target_port: 'trigger' },
    { id: 'inside-e3', source: 'inside-mkt', source_port: 'false', target: 'inside-no-mkt', target_port: 'trigger' },
    { id: 'inside-e4', source: 'inside-prev', source_port: 'trigger', target: 'inside-inside', target_port: 'trigger' },
    { id: 'inside-e5', source: 'inside-inside', source_port: 'trigger', target: 'inside-spread', target_port: 'trigger' },
    { id: 'inside-e6', source: 'inside-spread', source_port: 'trigger', target: 'inside-entry', target_port: 'trigger' },
    { id: 'inside-e7', source: 'inside-news', source_port: 'trigger', target: 'inside-entry', target_port: 'trigger' },
    { id: 'inside-e8', source: 'inside-draw', source_port: 'trigger', target: 'inside-entry', target_port: 'trigger' },
    { id: 'inside-e9', source: 'inside-entry', source_port: 'true', target: 'inside-buy', target_port: 'trigger' },
    { id: 'inside-e10', source: 'inside-entry', source_port: 'false', target: 'inside-no-entry', target_port: 'trigger' },
    { id: 'inside-e11', source: 'inside-buy', source_port: 'signal', target: 'inside-port', target_port: 'signal' },
    { id: 'inside-e12', source: 'inside-port', source_port: 'trades', target: 'inside-costs', target_port: 'trades' },
    { id: 'inside-e13', source: 'inside-costs', source_port: 'trades', target: 'inside-rec', target_port: 'trades' }
  ],
    'factors',
  ),
  buildExampleKeycard(
    'golden-cross',
    `Golden Cross`,
    `Trend-following template built around the classic 50/200 EMA cross. The normalized spread is added to Alpha158.`,
    ['trend', 'moving-average', 'alpha158'],
  [
    { id: 'golden-ctx', type: 'context', config: { text: 'Golden cross. Store: us, universe: top500, benchmark: SPY. Buy when price is above the 200-day EMA and the 50-day EMA crosses above the 200-day EMA.' }, notes: '' },
    { id: 'golden-var', type: 'variable', config: { name: 'slow_ema', value: '200' }, notes: '' },
    { id: 'golden-draw', type: 'chart_drawing', config: { type: 'trend', price: 0 }, notes: '' },
    { id: 'golden-sched', type: 'run_per_candle', config: { timeframe: '1d' }, notes: '' },
    { id: 'golden-mkt', type: 'branch', config: { condition: 'close > EMA($close,200)' }, notes: '' },
    { id: 'golden-prev', type: 'previous_day_bullish', config: { lookback: 1 }, notes: '' },
    { id: 'golden-cross', type: 'trade_rule', config: { condition: 'EMA($close,50) > EMA($close,200)' }, notes: '' },
    { id: 'golden-spread', type: 'check_spread', config: { max_spread_bps: 10 }, notes: '' },
    { id: 'golden-news', type: 'news_filter', config: { source: 'general', sentiment: 'positive' }, notes: '' },
    { id: 'golden-entry', type: 'branch', config: { condition: 'close > open' }, notes: '' },
    { id: 'golden-buy', type: 'buy_now', config: { side: 'long', size: '100%' }, notes: '' },
    { id: 'golden-port', type: 'portfolio', config: { strategy: 'TopkDropoutStrategy', topk: 30, n_drop: 5 }, notes: '' },
    { id: 'golden-costs', type: 'costs', config: { open_cost: 0.0005, close_cost: 0.0015, min_cost: 5, account: 100000000 }, notes: '' },
    { id: 'golden-rec', type: 'records', config: {  }, notes: '' },
    { id: 'golden-no-mkt', type: 'no_trade_for_day', config: { reason: 'market filter failed' }, notes: '' },
    { id: 'golden-no-entry', type: 'no_trade_for_day', config: { reason: 'entry condition failed' }, notes: '' }
  ],
  [
    { id: 'golden-e1', source: 'golden-sched', source_port: 'trigger', target: 'golden-mkt', target_port: 'trigger' },
    { id: 'golden-e2', source: 'golden-mkt', source_port: 'true', target: 'golden-prev', target_port: 'trigger' },
    { id: 'golden-e3', source: 'golden-mkt', source_port: 'false', target: 'golden-no-mkt', target_port: 'trigger' },
    { id: 'golden-e4', source: 'golden-prev', source_port: 'trigger', target: 'golden-cross', target_port: 'trigger' },
    { id: 'golden-e5', source: 'golden-cross', source_port: 'trigger', target: 'golden-spread', target_port: 'trigger' },
    { id: 'golden-e6', source: 'golden-spread', source_port: 'trigger', target: 'golden-entry', target_port: 'trigger' },
    { id: 'golden-e7', source: 'golden-news', source_port: 'trigger', target: 'golden-entry', target_port: 'trigger' },
    { id: 'golden-e8', source: 'golden-draw', source_port: 'trigger', target: 'golden-entry', target_port: 'trigger' },
    { id: 'golden-e9', source: 'golden-entry', source_port: 'true', target: 'golden-buy', target_port: 'trigger' },
    { id: 'golden-e10', source: 'golden-entry', source_port: 'false', target: 'golden-no-entry', target_port: 'trigger' },
    { id: 'golden-e11', source: 'golden-buy', source_port: 'signal', target: 'golden-port', target_port: 'signal' },
    { id: 'golden-e12', source: 'golden-port', source_port: 'trades', target: 'golden-costs', target_port: 'trades' },
    { id: 'golden-e13', source: 'golden-costs', source_port: 'trades', target: 'golden-rec', target_port: 'trades' }
  ],
    'factors',
  ),
  buildExampleKeycard(
    'mean-reversion-rsi',
    `Mean Reversion RSI`,
    `Oscillator mean-reversion. Adds RSI and Bollinger %B to the handler so the model can learn when stretched prices revert.`,
    ['mean-reversion', 'rsi', 'oscillators'],
  [
    { id: 'rsi-ctx', type: 'context', config: { text: 'Mean reversion RSI. Store: us, universe: top500, benchmark: SPY. Buy when the market filter is bullish and RSI(14) is below 30.' }, notes: '' },
    { id: 'rsi-var', type: 'variable', config: { name: 'rsi_period', value: '14' }, notes: '' },
    { id: 'rsi-draw', type: 'chart_drawing', config: { type: 'zone', price: 0 }, notes: '' },
    { id: 'rsi-sched', type: 'run_per_candle', config: { timeframe: '1d' }, notes: '' },
    { id: 'rsi-mkt', type: 'branch', config: { condition: 'close > EMA($close,50)' }, notes: '' },
    { id: 'rsi-prev', type: 'previous_day_bullish', config: { lookback: 1 }, notes: '' },
    { id: 'rsi-spread', type: 'check_spread', config: { max_spread_bps: 10 }, notes: '' },
    { id: 'rsi-news', type: 'news_filter', config: { source: 'general', sentiment: 'positive' }, notes: '' },
    { id: 'rsi-entry', type: 'branch', config: { condition: 'RSI($close,14) < 30' }, notes: '' },
    { id: 'rsi-buy', type: 'buy_now', config: { side: 'long', size: '100%' }, notes: '' },
    { id: 'rsi-port', type: 'portfolio', config: { strategy: 'TopkDropoutStrategy', topk: 30, n_drop: 5 }, notes: '' },
    { id: 'rsi-costs', type: 'costs', config: { open_cost: 0.0005, close_cost: 0.0015, min_cost: 5, account: 100000000 }, notes: '' },
    { id: 'rsi-rec', type: 'records', config: {  }, notes: '' },
    { id: 'rsi-no-mkt', type: 'no_trade_for_day', config: { reason: 'market filter failed' }, notes: '' },
    { id: 'rsi-no-entry', type: 'no_trade_for_day', config: { reason: 'entry condition failed' }, notes: '' }
  ],
  [
    { id: 'rsi-e1', source: 'rsi-sched', source_port: 'trigger', target: 'rsi-mkt', target_port: 'trigger' },
    { id: 'rsi-e2', source: 'rsi-mkt', source_port: 'true', target: 'rsi-prev', target_port: 'trigger' },
    { id: 'rsi-e3', source: 'rsi-mkt', source_port: 'false', target: 'rsi-no-mkt', target_port: 'trigger' },
    { id: 'rsi-e4', source: 'rsi-prev', source_port: 'trigger', target: 'rsi-spread', target_port: 'trigger' },
    { id: 'rsi-e5', source: 'rsi-spread', source_port: 'trigger', target: 'rsi-entry', target_port: 'trigger' },
    { id: 'rsi-e6', source: 'rsi-news', source_port: 'trigger', target: 'rsi-entry', target_port: 'trigger' },
    { id: 'rsi-e7', source: 'rsi-draw', source_port: 'trigger', target: 'rsi-entry', target_port: 'trigger' },
    { id: 'rsi-e8', source: 'rsi-entry', source_port: 'true', target: 'rsi-buy', target_port: 'trigger' },
    { id: 'rsi-e9', source: 'rsi-entry', source_port: 'false', target: 'rsi-no-entry', target_port: 'trigger' },
    { id: 'rsi-e10', source: 'rsi-buy', source_port: 'signal', target: 'rsi-port', target_port: 'signal' },
    { id: 'rsi-e11', source: 'rsi-port', source_port: 'trades', target: 'rsi-costs', target_port: 'trades' },
    { id: 'rsi-e12', source: 'rsi-costs', source_port: 'trades', target: 'rsi-rec', target_port: 'trades' }
  ],
    'factors',
  ),
  buildExampleKeycard(
    'quality-minus-junk',
    `Quality Minus Junk`,
    `Quality proxy using low return volatility as a stand-in for stable fundamentals. The model prefers smoother names.`,
    ['quality', 'low-volatility', 'alpha158'],
  [
    { id: 'quality-ctx', type: 'context', config: { text: 'Quality minus junk. Store: us, universe: top500, benchmark: SPY. Prefer names with smoother 60-day return volatility.' }, notes: '' },
    { id: 'quality-var', type: 'variable', config: { name: 'vol_lookback', value: '60' }, notes: '' },
    { id: 'quality-draw', type: 'chart_drawing', config: { type: 'level', price: 0 }, notes: '' },
    { id: 'quality-sched', type: 'run_per_candle', config: { timeframe: '1d' }, notes: '' },
    { id: 'quality-mkt', type: 'branch', config: { condition: 'close > EMA($close,50)' }, notes: '' },
    { id: 'quality-prev', type: 'previous_day_bullish', config: { lookback: 1 }, notes: '' },
    { id: 'quality-quality', type: 'trade_rule', config: { condition: '-1 * Std($change,60) > 0' }, notes: '' },
    { id: 'quality-spread', type: 'check_spread', config: { max_spread_bps: 10 }, notes: '' },
    { id: 'quality-news', type: 'news_filter', config: { source: 'earnings', sentiment: 'positive' }, notes: '' },
    { id: 'quality-entry', type: 'branch', config: { condition: 'close > open' }, notes: '' },
    { id: 'quality-buy', type: 'buy_now', config: { side: 'long', size: '100%' }, notes: '' },
    { id: 'quality-port', type: 'portfolio', config: { strategy: 'TopkDropoutStrategy', topk: 50, n_drop: 5 }, notes: '' },
    { id: 'quality-costs', type: 'costs', config: { open_cost: 0.0005, close_cost: 0.0015, min_cost: 5, account: 100000000 }, notes: '' },
    { id: 'quality-rec', type: 'records', config: {  }, notes: '' },
    { id: 'quality-no-mkt', type: 'no_trade_for_day', config: { reason: 'market filter failed' }, notes: '' },
    { id: 'quality-no-entry', type: 'no_trade_for_day', config: { reason: 'entry condition failed' }, notes: '' }
  ],
  [
    { id: 'quality-e1', source: 'quality-sched', source_port: 'trigger', target: 'quality-mkt', target_port: 'trigger' },
    { id: 'quality-e2', source: 'quality-mkt', source_port: 'true', target: 'quality-prev', target_port: 'trigger' },
    { id: 'quality-e3', source: 'quality-mkt', source_port: 'false', target: 'quality-no-mkt', target_port: 'trigger' },
    { id: 'quality-e4', source: 'quality-prev', source_port: 'trigger', target: 'quality-quality', target_port: 'trigger' },
    { id: 'quality-e5', source: 'quality-quality', source_port: 'trigger', target: 'quality-spread', target_port: 'trigger' },
    { id: 'quality-e6', source: 'quality-spread', source_port: 'trigger', target: 'quality-entry', target_port: 'trigger' },
    { id: 'quality-e7', source: 'quality-news', source_port: 'trigger', target: 'quality-entry', target_port: 'trigger' },
    { id: 'quality-e8', source: 'quality-draw', source_port: 'trigger', target: 'quality-entry', target_port: 'trigger' },
    { id: 'quality-e9', source: 'quality-entry', source_port: 'true', target: 'quality-buy', target_port: 'trigger' },
    { id: 'quality-e10', source: 'quality-entry', source_port: 'false', target: 'quality-no-entry', target_port: 'trigger' },
    { id: 'quality-e11', source: 'quality-buy', source_port: 'signal', target: 'quality-port', target_port: 'signal' },
    { id: 'quality-e12', source: 'quality-port', source_port: 'trades', target: 'quality-costs', target_port: 'trades' },
    { id: 'quality-e13', source: 'quality-costs', source_port: 'trades', target: 'quality-rec', target_port: 'trades' }
  ],
    'factors',
  ),
  buildExampleKeycard(
    'value-momentum',
    `Value Momentum`,
    `Combines a value proxy (distance from the 52-week high) with 12-month momentum. Cheap and strong names are favoured.`,
    ['value', 'momentum', 'alpha158'],
  [
    { id: 'value-ctx', type: 'context', config: { text: 'Value momentum. Store: us, universe: top500, benchmark: SPY. Buy cheap names that also show 12-month momentum.' }, notes: '' },
    { id: 'value-var', type: 'variable', config: { name: 'value_lookback', value: '252' }, notes: '' },
    { id: 'value-draw', type: 'chart_drawing', config: { type: 'level', price: 0 }, notes: '' },
    { id: 'value-sched', type: 'run_per_candle', config: { timeframe: '1d' }, notes: '' },
    { id: 'value-mkt', type: 'branch', config: { condition: 'close > EMA($close,50)' }, notes: '' },
    { id: 'value-prev', type: 'previous_day_bullish', config: { lookback: 1 }, notes: '' },
    { id: 'value-value', type: 'trade_rule', config: { condition: '$close/(Max($high,252)+1e-12) - 1 < -0.2' }, notes: '' },
    { id: 'value-spread', type: 'check_spread', config: { max_spread_bps: 10 }, notes: '' },
    { id: 'value-news', type: 'news_filter', config: { source: 'general', sentiment: 'positive' }, notes: '' },
    { id: 'value-entry', type: 'branch', config: { condition: 'Ref($close,21)/(Ref($close,252)+1e-12) - 1 > 0' }, notes: '' },
    { id: 'value-buy', type: 'buy_now', config: { side: 'long', size: '100%' }, notes: '' },
    { id: 'value-port', type: 'portfolio', config: { strategy: 'TopkDropoutStrategy', topk: 40, n_drop: 5 }, notes: '' },
    { id: 'value-costs', type: 'costs', config: { open_cost: 0.0005, close_cost: 0.0015, min_cost: 5, account: 100000000 }, notes: '' },
    { id: 'value-rec', type: 'records', config: {  }, notes: '' },
    { id: 'value-no-mkt', type: 'no_trade_for_day', config: { reason: 'market filter failed' }, notes: '' },
    { id: 'value-no-entry', type: 'no_trade_for_day', config: { reason: 'entry condition failed' }, notes: '' }
  ],
  [
    { id: 'value-e1', source: 'value-sched', source_port: 'trigger', target: 'value-mkt', target_port: 'trigger' },
    { id: 'value-e2', source: 'value-mkt', source_port: 'true', target: 'value-prev', target_port: 'trigger' },
    { id: 'value-e3', source: 'value-mkt', source_port: 'false', target: 'value-no-mkt', target_port: 'trigger' },
    { id: 'value-e4', source: 'value-prev', source_port: 'trigger', target: 'value-value', target_port: 'trigger' },
    { id: 'value-e5', source: 'value-value', source_port: 'trigger', target: 'value-spread', target_port: 'trigger' },
    { id: 'value-e6', source: 'value-spread', source_port: 'trigger', target: 'value-entry', target_port: 'trigger' },
    { id: 'value-e7', source: 'value-news', source_port: 'trigger', target: 'value-entry', target_port: 'trigger' },
    { id: 'value-e8', source: 'value-draw', source_port: 'trigger', target: 'value-entry', target_port: 'trigger' },
    { id: 'value-e9', source: 'value-entry', source_port: 'true', target: 'value-buy', target_port: 'trigger' },
    { id: 'value-e10', source: 'value-entry', source_port: 'false', target: 'value-no-entry', target_port: 'trigger' },
    { id: 'value-e11', source: 'value-buy', source_port: 'signal', target: 'value-port', target_port: 'signal' },
    { id: 'value-e12', source: 'value-port', source_port: 'trades', target: 'value-costs', target_port: 'trades' },
    { id: 'value-e13', source: 'value-costs', source_port: 'trades', target: 'value-rec', target_port: 'trades' }
  ],
    'factors',
  ),
  buildExampleKeycard(
    'low-volatility',
    `Low Volatility`,
    `Explicit low-volatility signal. Adds normalized ATR and 20-day return volatility so the model can learn the anomaly directly.`,
    ['low-vol', 'risk', 'alpha158'],
  [
    { id: 'lowvol-ctx', type: 'context', config: { text: 'Low volatility. Store: us, universe: top500, benchmark: SPY. Buy names with 20-day realized volatility below 2%.' }, notes: '' },
    { id: 'lowvol-var', type: 'variable', config: { name: 'vol_window', value: '20' }, notes: '' },
    { id: 'lowvol-draw', type: 'chart_drawing', config: { type: 'zone', price: 0 }, notes: '' },
    { id: 'lowvol-sched', type: 'run_per_candle', config: { timeframe: '1d' }, notes: '' },
    { id: 'lowvol-mkt', type: 'branch', config: { condition: 'close > EMA($close,50)' }, notes: '' },
    { id: 'lowvol-prev', type: 'previous_day_bullish', config: { lookback: 1 }, notes: '' },
    { id: 'lowvol-lowvol', type: 'trade_rule', config: { condition: 'Std($change,20) < 0.02' }, notes: '' },
    { id: 'lowvol-spread', type: 'check_spread', config: { max_spread_bps: 10 }, notes: '' },
    { id: 'lowvol-news', type: 'news_filter', config: { source: 'general', sentiment: 'positive' }, notes: '' },
    { id: 'lowvol-entry', type: 'branch', config: { condition: 'close > open' }, notes: '' },
    { id: 'lowvol-buy', type: 'buy_now', config: { side: 'long', size: '100%' }, notes: '' },
    { id: 'lowvol-port', type: 'portfolio', config: { strategy: 'TopkDropoutStrategy', topk: 50, n_drop: 5 }, notes: '' },
    { id: 'lowvol-costs', type: 'costs', config: { open_cost: 0.0005, close_cost: 0.0015, min_cost: 5, account: 100000000 }, notes: '' },
    { id: 'lowvol-rec', type: 'records', config: {  }, notes: '' },
    { id: 'lowvol-no-mkt', type: 'no_trade_for_day', config: { reason: 'market filter failed' }, notes: '' },
    { id: 'lowvol-no-entry', type: 'no_trade_for_day', config: { reason: 'entry condition failed' }, notes: '' }
  ],
  [
    { id: 'lowvol-e1', source: 'lowvol-sched', source_port: 'trigger', target: 'lowvol-mkt', target_port: 'trigger' },
    { id: 'lowvol-e2', source: 'lowvol-mkt', source_port: 'true', target: 'lowvol-prev', target_port: 'trigger' },
    { id: 'lowvol-e3', source: 'lowvol-mkt', source_port: 'false', target: 'lowvol-no-mkt', target_port: 'trigger' },
    { id: 'lowvol-e4', source: 'lowvol-prev', source_port: 'trigger', target: 'lowvol-lowvol', target_port: 'trigger' },
    { id: 'lowvol-e5', source: 'lowvol-lowvol', source_port: 'trigger', target: 'lowvol-spread', target_port: 'trigger' },
    { id: 'lowvol-e6', source: 'lowvol-spread', source_port: 'trigger', target: 'lowvol-entry', target_port: 'trigger' },
    { id: 'lowvol-e7', source: 'lowvol-news', source_port: 'trigger', target: 'lowvol-entry', target_port: 'trigger' },
    { id: 'lowvol-e8', source: 'lowvol-draw', source_port: 'trigger', target: 'lowvol-entry', target_port: 'trigger' },
    { id: 'lowvol-e9', source: 'lowvol-entry', source_port: 'true', target: 'lowvol-buy', target_port: 'trigger' },
    { id: 'lowvol-e10', source: 'lowvol-entry', source_port: 'false', target: 'lowvol-no-entry', target_port: 'trigger' },
    { id: 'lowvol-e11', source: 'lowvol-buy', source_port: 'signal', target: 'lowvol-port', target_port: 'signal' },
    { id: 'lowvol-e12', source: 'lowvol-port', source_port: 'trades', target: 'lowvol-costs', target_port: 'trades' },
    { id: 'lowvol-e13', source: 'lowvol-costs', source_port: 'trades', target: 'lowvol-rec', target_port: 'trades' }
  ],
    'factors',
  ),
  buildExampleKeycard(
    'short-term-momentum',
    `Short Term Momentum`,
    `Very short-horizon momentum using 5-day and 10-day returns. Higher turnover by design; pair it with cost-conscious settings.`,
    ['short-term', 'momentum', '5-day'],
  [
    { id: 'short-ctx', type: 'context', config: { text: 'Short term momentum. Store: us, universe: top500, benchmark: SPY. Buy on 5-day and 10-day momentum signals.' }, notes: '' },
    { id: 'short-var', type: 'variable', config: { name: 'short_window', value: '5' }, notes: '' },
    { id: 'short-draw', type: 'chart_drawing', config: { type: 'level', price: 0 }, notes: '' },
    { id: 'short-sched', type: 'run_per_candle', config: { timeframe: '1d' }, notes: '' },
    { id: 'short-mkt', type: 'branch', config: { condition: 'close > EMA($close,10)' }, notes: '' },
    { id: 'short-prev', type: 'previous_day_bullish', config: { lookback: 1 }, notes: '' },
    { id: 'short-mom5', type: 'trade_rule', config: { condition: '$close/(Ref($close,5)+1e-12) - 1 > 0' }, notes: '' },
    { id: 'short-spread', type: 'check_spread', config: { max_spread_bps: 10 }, notes: '' },
    { id: 'short-news', type: 'news_filter', config: { source: 'general', sentiment: 'positive' }, notes: '' },
    { id: 'short-entry', type: 'branch', config: { condition: '$close/(Ref($close,10)+1e-12) - 1 > 0' }, notes: '' },
    { id: 'short-buy', type: 'buy_now', config: { side: 'long', size: '100%' }, notes: '' },
    { id: 'short-port', type: 'portfolio', config: { strategy: 'TopkDropoutStrategy', topk: 30, n_drop: 10 }, notes: '' },
    { id: 'short-costs', type: 'costs', config: { open_cost: 0.0005, close_cost: 0.0015, min_cost: 5, account: 100000000 }, notes: '' },
    { id: 'short-rec', type: 'records', config: {  }, notes: '' },
    { id: 'short-no-mkt', type: 'no_trade_for_day', config: { reason: 'market filter failed' }, notes: '' },
    { id: 'short-no-entry', type: 'no_trade_for_day', config: { reason: 'entry condition failed' }, notes: '' }
  ],
  [
    { id: 'short-e1', source: 'short-sched', source_port: 'trigger', target: 'short-mkt', target_port: 'trigger' },
    { id: 'short-e2', source: 'short-mkt', source_port: 'true', target: 'short-prev', target_port: 'trigger' },
    { id: 'short-e3', source: 'short-mkt', source_port: 'false', target: 'short-no-mkt', target_port: 'trigger' },
    { id: 'short-e4', source: 'short-prev', source_port: 'trigger', target: 'short-mom5', target_port: 'trigger' },
    { id: 'short-e5', source: 'short-mom5', source_port: 'trigger', target: 'short-spread', target_port: 'trigger' },
    { id: 'short-e6', source: 'short-spread', source_port: 'trigger', target: 'short-entry', target_port: 'trigger' },
    { id: 'short-e7', source: 'short-news', source_port: 'trigger', target: 'short-entry', target_port: 'trigger' },
    { id: 'short-e8', source: 'short-draw', source_port: 'trigger', target: 'short-entry', target_port: 'trigger' },
    { id: 'short-e9', source: 'short-entry', source_port: 'true', target: 'short-buy', target_port: 'trigger' },
    { id: 'short-e10', source: 'short-entry', source_port: 'false', target: 'short-no-entry', target_port: 'trigger' },
    { id: 'short-e11', source: 'short-buy', source_port: 'signal', target: 'short-port', target_port: 'signal' },
    { id: 'short-e12', source: 'short-port', source_port: 'trades', target: 'short-costs', target_port: 'trades' },
    { id: 'short-e13', source: 'short-costs', source_port: 'trades', target: 'short-rec', target_port: 'trades' }
  ],
    'factors',
  ),
  buildExampleKeycard(
    'trend-following',
    `Trend Following`,
    `Multi-horizon trend signal. Adds 1-month, 3-month, 6-month and 12-month momentum to let the model weigh horizons.`,
    ['trend', 'multi-horizon', 'alpha158'],
  [
    { id: 'trend-ctx', type: 'context', config: { text: 'Trend following. Store: us, universe: top500, benchmark: SPY. Align 1-month, 3-month and 12-month momentum before buying.' }, notes: '' },
    { id: 'trend-var', type: 'variable', config: { name: 'trend_lookback', value: '252' }, notes: '' },
    { id: 'trend-draw', type: 'chart_drawing', config: { type: 'trend', price: 0 }, notes: '' },
    { id: 'trend-sched', type: 'run_per_candle', config: { timeframe: '1d' }, notes: '' },
    { id: 'trend-mkt', type: 'branch', config: { condition: 'close > EMA($close,50)' }, notes: '' },
    { id: 'trend-prev', type: 'previous_day_bullish', config: { lookback: 1 }, notes: '' },
    { id: 'trend-mom12m', type: 'trade_rule', config: { condition: '$close/(Ref($close,252)+1e-12) - 1 > 0' }, notes: '' },
    { id: 'trend-spread', type: 'check_spread', config: { max_spread_bps: 10 }, notes: '' },
    { id: 'trend-mom1m', type: 'trade_rule', config: { condition: '$close/(Ref($close,21)+1e-12) - 1 > 0' }, notes: '' },
    { id: 'trend-entry', type: 'branch', config: { condition: '$close/(Ref($close,63)+1e-12) - 1 > 0' }, notes: '' },
    { id: 'trend-buy', type: 'buy_now', config: { side: 'long', size: '100%' }, notes: '' },
    { id: 'trend-port', type: 'portfolio', config: { strategy: 'TopkDropoutStrategy', topk: 40, n_drop: 5 }, notes: '' },
    { id: 'trend-costs', type: 'costs', config: { open_cost: 0.0005, close_cost: 0.0015, min_cost: 5, account: 100000000 }, notes: '' },
    { id: 'trend-rec', type: 'records', config: {  }, notes: '' },
    { id: 'trend-no-mkt', type: 'no_trade_for_day', config: { reason: 'market filter failed' }, notes: '' },
    { id: 'trend-no-entry', type: 'no_trade_for_day', config: { reason: 'entry condition failed' }, notes: '' }
  ],
  [
    { id: 'trend-e1', source: 'trend-sched', source_port: 'trigger', target: 'trend-mkt', target_port: 'trigger' },
    { id: 'trend-e2', source: 'trend-mkt', source_port: 'true', target: 'trend-prev', target_port: 'trigger' },
    { id: 'trend-e3', source: 'trend-mkt', source_port: 'false', target: 'trend-no-mkt', target_port: 'trigger' },
    { id: 'trend-e4', source: 'trend-prev', source_port: 'trigger', target: 'trend-mom12m', target_port: 'trigger' },
    { id: 'trend-e5', source: 'trend-mom12m', source_port: 'trigger', target: 'trend-spread', target_port: 'trigger' },
    { id: 'trend-e6', source: 'trend-spread', source_port: 'trigger', target: 'trend-entry', target_port: 'trigger' },
    { id: 'trend-e7', source: 'trend-mom1m', source_port: 'trigger', target: 'trend-entry', target_port: 'trigger' },
    { id: 'trend-e8', source: 'trend-draw', source_port: 'trigger', target: 'trend-entry', target_port: 'trigger' },
    { id: 'trend-e9', source: 'trend-entry', source_port: 'true', target: 'trend-buy', target_port: 'trigger' },
    { id: 'trend-e10', source: 'trend-entry', source_port: 'false', target: 'trend-no-entry', target_port: 'trigger' },
    { id: 'trend-e11', source: 'trend-buy', source_port: 'signal', target: 'trend-port', target_port: 'signal' },
    { id: 'trend-e12', source: 'trend-port', source_port: 'trades', target: 'trend-costs', target_port: 'trades' },
    { id: 'trend-e13', source: 'trend-costs', source_port: 'trades', target: 'trend-rec', target_port: 'trades' }
  ],
    'factors',
  ),
  buildExampleKeycard(
    'momentum-quality',
    `Momentum Quality`,
    `Combines 12-month momentum with a quality filter: momentum is scaled by inverse volatility, preferring smoother trends.`,
    ['momentum', 'quality', 'alpha158'],
  [
    { id: 'momqual-ctx', type: 'context', config: { text: 'Momentum quality. Store: us, universe: top500, benchmark: SPY. Buy names where 12-month momentum is high relative to 60-day volatility.' }, notes: '' },
    { id: 'momqual-var', type: 'variable', config: { name: 'quality_smoothing', value: '60' }, notes: '' },
    { id: 'momqual-draw', type: 'chart_drawing', config: { type: 'level', price: 0 }, notes: '' },
    { id: 'momqual-sched', type: 'run_per_candle', config: { timeframe: '1d' }, notes: '' },
    { id: 'momqual-mkt', type: 'branch', config: { condition: 'close > EMA($close,50)' }, notes: '' },
    { id: 'momqual-prev', type: 'previous_day_bullish', config: { lookback: 1 }, notes: '' },
    { id: 'momqual-qmom', type: 'trade_rule', config: { condition: '(Ref($close,21)/(Ref($close,252)+1e-12) - 1)/(Std($change,60)+1e-12) > 0' }, notes: '' },
    { id: 'momqual-spread', type: 'check_spread', config: { max_spread_bps: 10 }, notes: '' },
    { id: 'momqual-news', type: 'news_filter', config: { source: 'general', sentiment: 'positive' }, notes: '' },
    { id: 'momqual-entry', type: 'branch', config: { condition: 'close > open' }, notes: '' },
    { id: 'momqual-buy', type: 'buy_now', config: { side: 'long', size: '100%' }, notes: '' },
    { id: 'momqual-port', type: 'portfolio', config: { strategy: 'TopkDropoutStrategy', topk: 40, n_drop: 5 }, notes: '' },
    { id: 'momqual-costs', type: 'costs', config: { open_cost: 0.0005, close_cost: 0.0015, min_cost: 5, account: 100000000 }, notes: '' },
    { id: 'momqual-rec', type: 'records', config: {  }, notes: '' },
    { id: 'momqual-no-mkt', type: 'no_trade_for_day', config: { reason: 'market filter failed' }, notes: '' },
    { id: 'momqual-no-entry', type: 'no_trade_for_day', config: { reason: 'entry condition failed' }, notes: '' }
  ],
  [
    { id: 'momqual-e1', source: 'momqual-sched', source_port: 'trigger', target: 'momqual-mkt', target_port: 'trigger' },
    { id: 'momqual-e2', source: 'momqual-mkt', source_port: 'true', target: 'momqual-prev', target_port: 'trigger' },
    { id: 'momqual-e3', source: 'momqual-mkt', source_port: 'false', target: 'momqual-no-mkt', target_port: 'trigger' },
    { id: 'momqual-e4', source: 'momqual-prev', source_port: 'trigger', target: 'momqual-qmom', target_port: 'trigger' },
    { id: 'momqual-e5', source: 'momqual-qmom', source_port: 'trigger', target: 'momqual-spread', target_port: 'trigger' },
    { id: 'momqual-e6', source: 'momqual-spread', source_port: 'trigger', target: 'momqual-entry', target_port: 'trigger' },
    { id: 'momqual-e7', source: 'momqual-news', source_port: 'trigger', target: 'momqual-entry', target_port: 'trigger' },
    { id: 'momqual-e8', source: 'momqual-draw', source_port: 'trigger', target: 'momqual-entry', target_port: 'trigger' },
    { id: 'momqual-e9', source: 'momqual-entry', source_port: 'true', target: 'momqual-buy', target_port: 'trigger' },
    { id: 'momqual-e10', source: 'momqual-entry', source_port: 'false', target: 'momqual-no-entry', target_port: 'trigger' },
    { id: 'momqual-e11', source: 'momqual-buy', source_port: 'signal', target: 'momqual-port', target_port: 'signal' },
    { id: 'momqual-e12', source: 'momqual-port', source_port: 'trades', target: 'momqual-costs', target_port: 'trades' },
    { id: 'momqual-e13', source: 'momqual-costs', source_port: 'trades', target: 'momqual-rec', target_port: 'trades' }
  ],
    'factors',
  ),
  buildExampleKeycard(
    'volume-breakout',
    `Volume Breakout`,
    `Volume-confirmed breakout. Adds a volume z-score to the price breakout so the model can distinguish real breaks from quiet ones.`,
    ['volume', 'breakout', 'alpha158'],
  [
    { id: 'volume-ctx', type: 'context', config: { text: 'Volume breakout. Store: us, universe: top500, benchmark: SPY. Require a price breakout above the 20-day high with a volume z-score above 2.' }, notes: '' },
    { id: 'volume-var', type: 'variable', config: { name: 'volume_z_window', value: '20' }, notes: '' },
    { id: 'volume-draw', type: 'chart_drawing', config: { type: 'zone', price: 0 }, notes: '' },
    { id: 'volume-sched', type: 'run_per_candle', config: { timeframe: '1d' }, notes: '' },
    { id: 'volume-mkt', type: 'branch', config: { condition: 'close > EMA($close,50)' }, notes: '' },
    { id: 'volume-prev', type: 'previous_day_bullish', config: { lookback: 1 }, notes: '' },
    { id: 'volume-breakout', type: 'trade_rule', config: { condition: '$close/(Max($high,20)+1e-12) - 1 > 0' }, notes: '' },
    { id: 'volume-volz', type: 'trade_rule', config: { condition: '($volume - Mean($volume,20))/(Std($volume,20)+1e-12) > 2' }, notes: '' },
    { id: 'volume-spread', type: 'check_spread', config: { max_spread_bps: 10 }, notes: '' },
    { id: 'volume-entry', type: 'branch', config: { condition: 'close > open' }, notes: '' },
    { id: 'volume-buy', type: 'buy_now', config: { side: 'long', size: '100%' }, notes: '' },
    { id: 'volume-port', type: 'portfolio', config: { strategy: 'TopkDropoutStrategy', topk: 30, n_drop: 5 }, notes: '' },
    { id: 'volume-costs', type: 'costs', config: { open_cost: 0.0005, close_cost: 0.0015, min_cost: 5, account: 100000000 }, notes: '' },
    { id: 'volume-rec', type: 'records', config: {  }, notes: '' },
    { id: 'volume-no-mkt', type: 'no_trade_for_day', config: { reason: 'market filter failed' }, notes: '' },
    { id: 'volume-no-entry', type: 'no_trade_for_day', config: { reason: 'entry condition failed' }, notes: '' }
  ],
  [
    { id: 'volume-e1', source: 'volume-sched', source_port: 'trigger', target: 'volume-mkt', target_port: 'trigger' },
    { id: 'volume-e2', source: 'volume-mkt', source_port: 'true', target: 'volume-prev', target_port: 'trigger' },
    { id: 'volume-e3', source: 'volume-mkt', source_port: 'false', target: 'volume-no-mkt', target_port: 'trigger' },
    { id: 'volume-e4', source: 'volume-prev', source_port: 'trigger', target: 'volume-breakout', target_port: 'trigger' },
    { id: 'volume-e5', source: 'volume-breakout', source_port: 'trigger', target: 'volume-volz', target_port: 'trigger' },
    { id: 'volume-e6', source: 'volume-volz', source_port: 'trigger', target: 'volume-spread', target_port: 'trigger' },
    { id: 'volume-e7', source: 'volume-spread', source_port: 'trigger', target: 'volume-entry', target_port: 'trigger' },
    { id: 'volume-e8', source: 'volume-draw', source_port: 'trigger', target: 'volume-entry', target_port: 'trigger' },
    { id: 'volume-e9', source: 'volume-entry', source_port: 'true', target: 'volume-buy', target_port: 'trigger' },
    { id: 'volume-e10', source: 'volume-entry', source_port: 'false', target: 'volume-no-entry', target_port: 'trigger' },
    { id: 'volume-e11', source: 'volume-buy', source_port: 'signal', target: 'volume-port', target_port: 'signal' },
    { id: 'volume-e12', source: 'volume-port', source_port: 'trades', target: 'volume-costs', target_port: 'trades' },
    { id: 'volume-e13', source: 'volume-costs', source_port: 'trades', target: 'volume-rec', target_port: 'trades' }
  ],
    'factors',
  ),

  // Shape
  buildExampleKeycard(
    'risk-parity-light',
    `Risk Parity Light`,
    `A volatility-aware portfolio shape. The signal is an estimate of realised volatility; the model learns to avoid the riskiest names.`,
    ['risk-parity', 'volatility', 'weighting'],
  [
    { id: 'risk-ctx', type: 'context', config: { text: 'Risk parity light. Store: us, universe: top500, benchmark: SPY. Only take long exposure when 20-day realised volatility is below 15%.' }, notes: '' },
    { id: 'risk-var', type: 'variable', config: { name: 'target_vol', value: '0.15' }, notes: '' },
    { id: 'risk-draw', type: 'chart_drawing', config: { type: 'zone', price: 0 }, notes: '' },
    { id: 'risk-sched', type: 'run_per_candle', config: { timeframe: '1d' }, notes: '' },
    { id: 'risk-mkt', type: 'branch', config: { condition: 'close > EMA($close,50)' }, notes: '' },
    { id: 'risk-prev', type: 'previous_day_bullish', config: { lookback: 1 }, notes: '' },
    { id: 'risk-volcap', type: 'trade_rule', config: { condition: 'Std($change,20) < 0.15' }, notes: '' },
    { id: 'risk-spread', type: 'check_spread', config: { max_spread_bps: 10 }, notes: '' },
    { id: 'risk-news', type: 'news_filter', config: { source: 'macro', sentiment: 'any' }, notes: '' },
    { id: 'risk-entry', type: 'branch', config: { condition: 'close > open' }, notes: '' },
    { id: 'risk-buy', type: 'buy_now', config: { side: 'long', size: '100%' }, notes: '' },
    { id: 'risk-port', type: 'portfolio', config: { strategy: 'TopkDropoutStrategy', topk: 30, n_drop: 5 }, notes: '' },
    { id: 'risk-costs', type: 'costs', config: { open_cost: 0.0005, close_cost: 0.0015, min_cost: 5, account: 100000000 }, notes: '' },
    { id: 'risk-rec', type: 'records', config: {  }, notes: '' },
    { id: 'risk-no-mkt', type: 'no_trade_for_day', config: { reason: 'market filter failed' }, notes: '' },
    { id: 'risk-no-entry', type: 'no_trade_for_day', config: { reason: 'entry condition failed' }, notes: '' }
  ],
  [
    { id: 'risk-e1', source: 'risk-sched', source_port: 'trigger', target: 'risk-mkt', target_port: 'trigger' },
    { id: 'risk-e2', source: 'risk-mkt', source_port: 'true', target: 'risk-prev', target_port: 'trigger' },
    { id: 'risk-e3', source: 'risk-mkt', source_port: 'false', target: 'risk-no-mkt', target_port: 'trigger' },
    { id: 'risk-e4', source: 'risk-prev', source_port: 'trigger', target: 'risk-volcap', target_port: 'trigger' },
    { id: 'risk-e5', source: 'risk-volcap', source_port: 'trigger', target: 'risk-spread', target_port: 'trigger' },
    { id: 'risk-e6', source: 'risk-spread', source_port: 'trigger', target: 'risk-entry', target_port: 'trigger' },
    { id: 'risk-e7', source: 'risk-news', source_port: 'trigger', target: 'risk-entry', target_port: 'trigger' },
    { id: 'risk-e8', source: 'risk-draw', source_port: 'trigger', target: 'risk-entry', target_port: 'trigger' },
    { id: 'risk-e9', source: 'risk-entry', source_port: 'true', target: 'risk-buy', target_port: 'trigger' },
    { id: 'risk-e10', source: 'risk-entry', source_port: 'false', target: 'risk-no-entry', target_port: 'trigger' },
    { id: 'risk-e11', source: 'risk-buy', source_port: 'signal', target: 'risk-port', target_port: 'signal' },
    { id: 'risk-e12', source: 'risk-port', source_port: 'trades', target: 'risk-costs', target_port: 'trades' },
    { id: 'risk-e13', source: 'risk-costs', source_port: 'trades', target: 'risk-rec', target_port: 'trades' }
  ],
    'shape',
  ),

  ...aionDefs.map((def) => buildAionKeycard(def)),
  ...EXAMPLE_TEMPLATES,
]


export const STATIC_TEMPLATE_IDS = new Set(STATIC_KEYCARD_TEMPLATES.map((k) => k.id))
