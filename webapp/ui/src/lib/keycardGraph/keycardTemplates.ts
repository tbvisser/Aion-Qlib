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
 * The gallery mixes classic 7-stage quant pipelines (data store -> universe ->
 * feature handler -> model -> portfolio -> costs -> records) with Aion-style
 * rule workflows (Schedule -> Rules -> buy_now -> portfolio -> costs ->
 * records).
 */
import type { Keycard, KeycardSpec, KeycardWindows } from '@/lib/api'

const DEFAULT_WINDOWS: KeycardWindows = {
  train_start: '2010-01-04',
  train_end: '2019-12-31',
  valid_start: '2020-01-01',
  valid_end: '2021-12-31',
  test_start: '2022-01-01',
  test_end: '2026-08-07',
}

const LEFT = 200
const TOP = 100
const SPACING = 180

interface FeatureColumn {
  name: string
  expression: string
}

interface TemplateDef {
  id: string
  name: string
  description: string
  tags: string[]
  family: string
  store: string
  universe: string
  benchmark: string
  model: string
  handler: string
  featureMode: 'extend' | 'replace'
  features: FeatureColumn[]
  topk: number
  nDrop: number
  windows?: Partial<KeycardWindows>
}

const defs: TemplateDef[] = [
  {
    id: 'sp500-breakout',
    name: 'SP500 Breakout',
    description:
      'Momentum breakout on the broad US large-cap universe, framed as an S&P 500 breakout strategy. The model is given the distance to the 20-day high as an extra signal.',
    tags: ['sp500', 'breakout', 'momentum'],
    family: 'universe',
    store: 'us',
    universe: 'top500',
    benchmark: 'SPY',
    model: 'lightgbm',
    handler: 'Alpha158',
    featureMode: 'extend',
    features: [
      { name: 'BREAKOUT_20', expression: '$close/(Max($high,20)+1e-12) - 1' },
    ],
    topk: 20,
    nDrop: 5,
  },
  {
    id: 'crypto-breakout',
    name: 'Crypto Breakout',
    description:
      'A tight momentum book on the top 100 crypto names. Runs on the 365-day calendar and benchmarks against BTC-USD.',
    tags: ['crypto', 'breakout', 'momentum'],
    family: 'universe',
    store: 'crypto_365',
    universe: 'crypto_top100',
    benchmark: 'BTC-USD',
    model: 'lightgbm',
    handler: 'Alpha158',
    featureMode: 'extend',
    features: [
      { name: 'CRYPTO_BREAKOUT_20', expression: '$close/(Max($high,20)+1e-12) - 1' },
    ],
    topk: 10,
    nDrop: 2,
  },
  {
    id: 'inside-bar-breakout',
    name: 'Inside Bar Breakout',
    description:
      'Price-action template: today\'s range contracts inside yesterday\'s, then breaks out. The signal is the ratio of today\'s range to yesterday\'s.',
    tags: ['price-action', 'breakout', 'alpha158'],
    family: 'factors',
    store: 'us',
    universe: 'top500',
    benchmark: 'SPY',
    model: 'lightgbm',
    handler: 'Alpha158',
    featureMode: 'extend',
    features: [
      {
        name: 'INSIDE_RANGE_RATIO',
        expression: '($high - $low)/(Ref($high,1) - Ref($low,1) + 1e-12)',
      },
      { name: 'BREAKOUT_5', expression: '$close/(Max($high,5)+1e-12) - 1' },
    ],
    topk: 30,
    nDrop: 5,
  },
  {
    id: 'golden-cross',
    name: 'Golden Cross',
    description:
      'Trend-following template built around the classic 50/200 EMA cross. The normalized spread is added to Alpha158.',
    tags: ['trend', 'moving-average', 'alpha158'],
    family: 'factors',
    store: 'us',
    universe: 'top500',
    benchmark: 'SPY',
    model: 'lightgbm',
    handler: 'Alpha158',
    featureMode: 'extend',
    features: [
      {
        name: 'GOLDEN_CROSS',
        expression: '(EMA($close,50) - EMA($close,200))/($close+1e-12)',
      },
    ],
    topk: 30,
    nDrop: 5,
  },
  {
    id: 'mean-reversion-rsi',
    name: 'Mean Reversion RSI',
    description:
      'Oscillator mean-reversion. Adds RSI and Bollinger %B to the handler so the model can learn when stretched prices revert.',
    tags: ['mean-reversion', 'rsi', 'oscillators'],
    family: 'factors',
    store: 'us',
    universe: 'top500',
    benchmark: 'SPY',
    model: 'lightgbm',
    handler: 'Alpha158',
    featureMode: 'extend',
    features: [
      {
        name: 'RSI_14_WILDER',
        expression:
          '100 - 100/(1 + EMA(Greater($close-Ref($close,1),0),0.0714285714)/(EMA(Greater(Ref($close,1)-$close,0),0.0714285714)+1e-12))',
      },
      {
        name: 'BB_PCTB_20',
        expression:
          '($close - (Mean($close,20)-2*Std($close,20)))/(4*Std($close,20)+1e-12)',
      },
    ],
    topk: 30,
    nDrop: 5,
  },
  {
    id: 'quality-minus-junk',
    name: 'Quality Minus Junk',
    description:
      'Quality proxy using low return volatility as a stand-in for stable fundamentals. The model prefers smoother names.',
    tags: ['quality', 'low-volatility', 'alpha158'],
    family: 'factors',
    store: 'us',
    universe: 'top500',
    benchmark: 'SPY',
    model: 'lightgbm',
    handler: 'Alpha158',
    featureMode: 'extend',
    features: [
      {
        name: 'QUALITY_VOL_60',
        expression: '-1 * Std($change,60)',
      },
    ],
    topk: 50,
    nDrop: 5,
  },
  {
    id: 'value-momentum',
    name: 'Value Momentum',
    description:
      'Combines a value proxy (distance from the 52-week high) with 12-month momentum. Cheap and strong names are favoured.',
    tags: ['value', 'momentum', 'alpha158'],
    family: 'factors',
    store: 'us',
    universe: 'top500',
    benchmark: 'SPY',
    model: 'lightgbm',
    handler: 'Alpha158',
    featureMode: 'extend',
    features: [
      {
        name: 'VALUE_52W',
        expression: '$close/(Max($high,252)+1e-12) - 1',
      },
      {
        name: 'MOM_12_1',
        expression: 'Ref($close,21)/(Ref($close,252)+1e-12) - 1',
      },
    ],
    topk: 40,
    nDrop: 5,
  },
  {
    id: 'low-volatility',
    name: 'Low Volatility',
    description:
      'Explicit low-volatility signal. Adds normalized ATR and 20-day return volatility so the model can learn the anomaly directly.',
    tags: ['low-vol', 'risk', 'alpha158'],
    family: 'factors',
    store: 'us',
    universe: 'top500',
    benchmark: 'SPY',
    model: 'lightgbm',
    handler: 'Alpha158',
    featureMode: 'extend',
    features: [
      {
        name: 'ATR_14_NORM',
        expression:
          'EMA((Greater($high,Ref($close,1)) - Less($low,Ref($close,1))),0.0714285714)/($close+1e-12)',
      },
      {
        name: 'VOL_20',
        expression: 'Std($change,20)',
      },
    ],
    topk: 50,
    nDrop: 5,
  },
  {
    id: 'index-breakout',
    name: 'Index Breakout',
    description:
      'Momentum breakout on a curated set of index proxies. The cross-section is small, so read it as a timing signal on broad exposures rather than stock selection.',
    tags: ['index', 'breakout', 'momentum'],
    family: 'universe',
    store: 'us',
    universe: 'index_top50',
    benchmark: 'SPY',
    model: 'lightgbm',
    handler: 'Alpha158',
    featureMode: 'extend',
    features: [
      { name: 'BREAKOUT_20', expression: '$close/(Max($high,20)+1e-12) - 1' },
    ],
    topk: 10,
    nDrop: 2,
  },
  {
    id: 'etf-momentum',
    name: 'ETF Momentum',
    description:
      'Cross-asset momentum on the top 100 ETFs. Correlations are high, so read this as exposure rotation rather than stock selection.',
    tags: ['etf', 'momentum', 'rotation'],
    family: 'universe',
    store: 'us',
    universe: 'etf_top100',
    benchmark: 'SPY',
    model: 'xgboost',
    handler: 'Alpha158',
    featureMode: 'extend',
    features: [
      { name: 'MOM_12_1', expression: 'Ref($close,21)/(Ref($close,252)+1e-12) - 1' },
      { name: 'MOM_3_1', expression: 'Ref($close,21)/(Ref($close,63)+1e-12) - 1' },
    ],
    topk: 15,
    nDrop: 3,
  },
  {
    id: 'short-term-momentum',
    name: 'Short Term Momentum',
    description:
      'Very short-horizon momentum using 5-day and 10-day returns. Higher turnover by design; pair it with cost-conscious settings.',
    tags: ['short-term', 'momentum', '5-day'],
    family: 'factors',
    store: 'us',
    universe: 'top500',
    benchmark: 'SPY',
    model: 'lightgbm',
    handler: 'Alpha158',
    featureMode: 'extend',
    features: [
      { name: 'MOM_5D', expression: '$close/(Ref($close,5)+1e-12) - 1' },
      { name: 'MOM_10D', expression: '$close/(Ref($close,10)+1e-12) - 1' },
    ],
    topk: 30,
    nDrop: 10,
  },
  {
    id: 'trend-following',
    name: 'Trend Following',
    description:
      'Multi-horizon trend signal. Adds 1-month, 3-month, 6-month and 12-month momentum to let the model weigh horizons.',
    tags: ['trend', 'multi-horizon', 'alpha158'],
    family: 'factors',
    store: 'us',
    universe: 'top500',
    benchmark: 'SPY',
    model: 'lightgbm',
    handler: 'Alpha158',
    featureMode: 'extend',
    features: [
      { name: 'MOM_1M', expression: '$close/(Ref($close,21)+1e-12) - 1' },
      { name: 'MOM_3M', expression: '$close/(Ref($close,63)+1e-12) - 1' },
      { name: 'MOM_6M', expression: '$close/(Ref($close,126)+1e-12) - 1' },
      { name: 'MOM_12M', expression: '$close/(Ref($close,252)+1e-12) - 1' },
    ],
    topk: 40,
    nDrop: 5,
  },
  {
    id: 'risk-parity-light',
    name: 'Risk Parity Light',
    description:
      'A volatility-aware portfolio shape. The signal is an estimate of realised volatility; the model learns to avoid the riskiest names.',
    tags: ['risk-parity', 'volatility', 'weighting'],
    family: 'shape',
    store: 'us',
    universe: 'top500',
    benchmark: 'SPY',
    model: 'lightgbm',
    handler: 'Alpha158',
    featureMode: 'extend',
    features: [
      {
        name: 'REALISED_VOL_20',
        expression: 'Std($change,20)',
      },
    ],
    topk: 30,
    nDrop: 5,
  },
  {
    id: 'momentum-quality',
    name: 'Momentum Quality',
    description:
      'Combines 12-month momentum with a quality filter: momentum is scaled by inverse volatility, preferring smoother trends.',
    tags: ['momentum', 'quality', 'alpha158'],
    family: 'factors',
    store: 'us',
    universe: 'top500',
    benchmark: 'SPY',
    model: 'lightgbm',
    handler: 'Alpha158',
    featureMode: 'extend',
    features: [
      { name: 'MOM_12_1', expression: 'Ref($close,21)/(Ref($close,252)+1e-12) - 1' },
      {
        name: 'MOM_VOL_ADJ',
        expression: '(Ref($close,21)/(Ref($close,252)+1e-12) - 1)/(Std($change,60)+1e-12)',
      },
    ],
    topk: 40,
    nDrop: 5,
  },
  {
    id: 'volume-breakout',
    name: 'Volume Breakout',
    description:
      'Volume-confirmed breakout. Adds a volume z-score to the price breakout so the model can distinguish real breaks from quiet ones.',
    tags: ['volume', 'breakout', 'alpha158'],
    family: 'factors',
    store: 'us',
    universe: 'top500',
    benchmark: 'SPY',
    model: 'lightgbm',
    handler: 'Alpha158',
    featureMode: 'extend',
    features: [
      { name: 'BREAKOUT_20', expression: '$close/(Max($high,20)+1e-12) - 1' },
      {
        name: 'VOL_Z_20',
        expression: '($volume - Mean($volume,20))/(Std($volume,20)+1e-12)',
      },
    ],
    topk: 30,
    nDrop: 5,
  },
]

function buildKeycard(def: TemplateDef): Keycard {
  const windows = { ...DEFAULT_WINDOWS, ...def.windows }
  const nodes: KeycardSpec['nodes'] = [
    { id: 'store-1', type: 'data_store', position: { x: LEFT, y: TOP }, config: { store: def.store }, notes: '' },
    {
      id: 'universe-1',
      type: 'universe',
      position: { x: LEFT, y: TOP + SPACING },
      config: { universe: def.universe, benchmark: def.benchmark },
      notes: '',
    },
    {
      id: 'handler-1',
      type: 'handler',
      position: { x: LEFT, y: TOP + SPACING * 2 },
      config: {
        handler: def.handler,
        feature_mode: def.featureMode,
        features: def.features,
      },
      notes: '',
    },
    {
      id: 'model-1',
      type: 'model',
      position: { x: LEFT, y: TOP + SPACING * 3 },
      config: { model: def.model },
      notes: '',
    },
    {
      id: 'portfolio-1',
      type: 'portfolio',
      position: { x: LEFT, y: TOP + SPACING * 4 },
      config: { strategy: 'TopkDropoutStrategy', topk: def.topk, n_drop: def.nDrop },
      notes: '',
    },
    {
      id: 'costs-1',
      type: 'costs',
      position: { x: LEFT, y: TOP + SPACING * 5 },
      config: { open_cost: 0.0005, close_cost: 0.0015, min_cost: 5, account: 100_000_000 },
      notes: '',
    },
    { id: 'records-1', type: 'records', position: { x: LEFT, y: TOP + SPACING * 6 }, config: {}, notes: '' },
  ]

  const edges: KeycardSpec['edges'] = [
    { id: 'e1', source: 'store-1', source_port: 'data', target: 'universe-1', target_port: 'data' },
    { id: 'e2', source: 'universe-1', source_port: 'data', target: 'handler-1', target_port: 'data' },
    { id: 'e3', source: 'handler-1', source_port: 'features', target: 'model-1', target_port: 'features' },
    { id: 'e4', source: 'model-1', source_port: 'signal', target: 'portfolio-1', target_port: 'signal' },
    { id: 'e5', source: 'portfolio-1', source_port: 'trades', target: 'costs-1', target_port: 'trades' },
    { id: 'e6', source: 'costs-1', source_port: 'trades', target: 'records-1', target_port: 'trades' },
  ]

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
      position: { x: LEFT, y: TOP + SPACING * (i + 1) },
      config: rule.config,
      notes: '',
    })),
    {
      id: buyId,
      type: 'buy_now',
      position: { x: LEFT, y: TOP + SPACING * (def.rules.length + 1) },
      config: def.buy.config,
      notes: '',
    },
    {
      id: portfolioId,
      type: 'portfolio',
      position: { x: LEFT, y: TOP + SPACING * (def.rules.length + 2) },
      config: { strategy: 'TopkDropoutStrategy', topk: def.portfolio.topk, n_drop: def.portfolio.nDrop },
      notes: '',
    },
    {
      id: costsId,
      type: 'costs',
      position: { x: LEFT, y: TOP + SPACING * (def.rules.length + 3) },
      config: { open_cost: 0.0005, close_cost: 0.0015, min_cost: 5, account: 100_000_000 },
      notes: '',
    },
    {
      id: recordsId,
      type: 'records',
      position: { x: LEFT, y: TOP + SPACING * (def.rules.length + 4) },
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

export const STATIC_KEYCARD_TEMPLATES: Keycard[] = [
  ...defs.map((def) => buildKeycard(def)),
  ...aionDefs.map((def) => buildAionKeycard(def)),
]

export const STATIC_TEMPLATE_IDS = new Set(STATIC_KEYCARD_TEMPLATES.map((k) => k.id))
