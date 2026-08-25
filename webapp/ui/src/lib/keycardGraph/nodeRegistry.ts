/**
 * Static fallback metadata for keycard node types.
 *
 * The palette normally fetches this from `/api/keycards/node-types`, but the
 * builder should still be usable — and the cards should still look right — when
 * the backend is unreachable or the migration has not run yet.
 *
 * This registry mixes the original quant pipeline nodes with Aion-style
 * trading-rule blocks so the builder feels like a workflow tool, not a config
 * form.
 */
import type { KeycardNodeCategory, KeycardPort, KeycardPortType } from '@/lib/api'
import { KEYCARD_HUES } from './palette'

export type NodeCategory =
  | 'Data'
  | 'Schedule'
  | 'Rules'
  | 'Execution'
  | 'Management'
  | 'Variables'
  | 'Chart Drawings'
  | 'Features'
  | 'Model'
  | 'Portfolio'
  | 'Output'

export type NodePhase = 'data' | 'shape' | 'fit' | 'execute'

export interface NodeTypeInfo {
  id: string
  category: NodeCategory
  phase: NodePhase
  label: string
  eyebrow: string
  icon: string
  description: string
  ports: KeycardPort[]
  config_schema: Record<string, unknown>
}

export interface NodeCategoryInfo {
  id: NodeCategory
  label: string
  icon: string
  /**
   * A hue reference from `palette.ts` (`var(--kc-*)`), not a paintable
   * colour — wrap it in `solid()` or `wash()` at the point of use.
   */
  color: string
}

export const NODE_CATEGORY_INFO: Record<NodeCategory, NodeCategoryInfo> = {
  Data: { id: 'Data', label: 'Data', icon: 'database', color: KEYCARD_HUES.blue },
  Schedule: { id: 'Schedule', label: 'When to trade', icon: 'calendar-clock', color: KEYCARD_HUES.emerald },
  Rules: { id: 'Rules', label: 'Trading rules', icon: 'filter', color: KEYCARD_HUES.violet },
  Execution: { id: 'Execution', label: 'Trading execution', icon: 'trending-up', color: KEYCARD_HUES.orange },
  Management: { id: 'Management', label: 'Trading management', icon: 'list-filter', color: KEYCARD_HUES.rose },
  Variables: { id: 'Variables', label: 'Variables', icon: 'sigma', color: KEYCARD_HUES.amber },
  'Chart Drawings': { id: 'Chart Drawings', label: 'Chart drawings', icon: 'candlestick-chart', color: KEYCARD_HUES.cyan },
  Features: { id: 'Features', label: 'Features', icon: 'sigma', color: KEYCARD_HUES.violet },
  Model: { id: 'Model', label: 'Model', icon: 'cpu', color: KEYCARD_HUES.emerald },
  Portfolio: { id: 'Portfolio', label: 'Portfolio', icon: 'briefcase', color: KEYCARD_HUES.amber },
  Output: { id: 'Output', label: 'Output', icon: 'file-text', color: KEYCARD_HUES.slate },
}

const PORTS: Record<string, KeycardPort[]> = {
  // Quant pipeline
  data_store: [{ id: 'data', label: 'Data', type: 'data', direction: 'out', required: true }],
  universe: [
    { id: 'data', label: 'Data', type: 'data', direction: 'in', required: true },
    { id: 'data', label: 'Data', type: 'data', direction: 'out', required: true },
  ],
  handler: [
    { id: 'data', label: 'Data', type: 'data', direction: 'in', required: true },
    { id: 'features', label: 'Features', type: 'features', direction: 'out', required: true },
  ],
  model: [
    { id: 'features', label: 'Features', type: 'features', direction: 'in', required: true },
    { id: 'signal', label: 'Signal', type: 'signal', direction: 'out', required: true },
  ],
  portfolio: [
    { id: 'signal', label: 'Signal', type: 'signal', direction: 'in', required: true },
    { id: 'trades', label: 'Trades', type: 'trades', direction: 'out', required: true },
  ],
  costs: [
    { id: 'trades', label: 'Trades', type: 'trades', direction: 'in', required: false },
    { id: 'trades', label: 'Trades', type: 'trades', direction: 'out', required: true },
  ],
  records: [{ id: 'trades', label: 'Trades', type: 'trades', direction: 'in', required: true }],

  // Aion-style trading blocks
  run_per_candle: [{ id: 'trigger', label: 'Trigger', type: 'trigger', direction: 'out', required: true }],
  run_at_time: [{ id: 'trigger', label: 'Trigger', type: 'trigger', direction: 'out', required: true }],
  run_in_session: [{ id: 'trigger', label: 'Trigger', type: 'trigger', direction: 'out', required: true }],
  trade_rule: [
    { id: 'trigger', label: 'Trigger', type: 'trigger', direction: 'in', required: true, multiple: true },
    { id: 'trigger', label: 'Trigger', type: 'trigger', direction: 'out', required: true },
  ],
  check_spread: [
    { id: 'trigger', label: 'Trigger', type: 'trigger', direction: 'in', required: true, multiple: true },
    { id: 'trigger', label: 'Trigger', type: 'trigger', direction: 'out', required: true },
  ],
  previous_day_bullish: [
    { id: 'trigger', label: 'Trigger', type: 'trigger', direction: 'in', required: true, multiple: true },
    { id: 'trigger', label: 'Trigger', type: 'trigger', direction: 'out', required: true },
  ],
  candle_close_above_opening_range: [
    { id: 'trigger', label: 'Trigger', type: 'trigger', direction: 'in', required: true, multiple: true },
    { id: 'trigger', label: 'Trigger', type: 'trigger', direction: 'out', required: true },
  ],
  price_above_previous_day_close: [
    { id: 'trigger', label: 'Trigger', type: 'trigger', direction: 'in', required: true, multiple: true },
    { id: 'trigger', label: 'Trigger', type: 'trigger', direction: 'out', required: true },
  ],
  no_trade_for_day: [
    { id: 'trigger', label: 'Trigger', type: 'trigger', direction: 'in', required: true, multiple: true },
    { id: 'trigger', label: 'Trigger', type: 'trigger', direction: 'out', required: true },
  ],
  news_filter: [
    { id: 'trigger', label: 'Trigger', type: 'trigger', direction: 'in', required: true, multiple: true },
    { id: 'trigger', label: 'Trigger', type: 'trigger', direction: 'out', required: true },
  ],
  buy_now: [
    { id: 'trigger', label: 'Trigger', type: 'trigger', direction: 'in', required: true, multiple: true },
    { id: 'signal', label: 'Signal', type: 'signal', direction: 'out', required: true },
  ],
  trade_counter: [
    { id: 'trade', label: 'Trade', type: 'trade', direction: 'in', required: true },
    { id: 'trade', label: 'Trade', type: 'trade', direction: 'out', required: true },
  ],
  reset_trade_counter: [
    { id: 'trade', label: 'Trade', type: 'trade', direction: 'in', required: false },
    { id: 'trade', label: 'Trade', type: 'trade', direction: 'out', required: true },
  ],
  variable: [
    { id: 'trigger', label: 'Trigger', type: 'trigger', direction: 'in', required: false },
    { id: 'value', label: 'Value', type: 'value', direction: 'out', required: true },
  ],
  chart_drawing: [
    { id: 'trigger', label: 'Trigger', type: 'trigger', direction: 'in', required: false },
    { id: 'trigger', label: 'Trigger', type: 'trigger', direction: 'out', required: true },
  ],
  context: [],
  branch: [
    { id: 'trigger', label: 'Trigger', type: 'trigger', direction: 'in', required: true, multiple: true },
    { id: 'true', label: 'True', type: 'trigger', direction: 'out', required: true },
    { id: 'false', label: 'False', type: 'trigger', direction: 'out', required: true },
  ],
}

const SCHEMAS: Record<string, Record<string, unknown>> = {
  // Quant pipeline
  data_store: {
    type: 'object',
    additionalProperties: false,
    properties: { store: { type: 'string', enum: ['us', 'crypto_365'], default: 'us' } },
    required: ['store'],
  },
  universe: {
    type: 'object',
    additionalProperties: false,
    properties: {
      universe: { type: 'string', default: 'top500' },
      benchmark: { type: 'string', default: 'SPY' },
    },
    required: ['universe', 'benchmark'],
  },
  handler: {
    type: 'object',
    additionalProperties: false,
    properties: {
      handler: { type: 'string', enum: ['Alpha158', 'Alpha360'], default: 'Alpha158' },
      feature_mode: { type: 'string', enum: ['extend', 'replace'], default: 'extend' },
      features: { type: 'array', items: { type: 'object' } },
    },
    required: ['handler'],
  },
  model: {
    type: 'object',
    additionalProperties: false,
    properties: {
      model: {
        type: 'string',
        enum: ['lightgbm', 'xgboost', 'catboost', 'linear', 'double_ensemble'],
        default: 'lightgbm',
      },
    },
    required: ['model'],
  },
  portfolio: {
    type: 'object',
    additionalProperties: false,
    properties: {
      strategy: { type: 'string', enum: ['TopkDropoutStrategy'], default: 'TopkDropoutStrategy' },
      topk: { type: 'number', default: 50 },
      n_drop: { type: 'number', default: 5 },
    },
    required: ['strategy', 'topk', 'n_drop'],
  },
  costs: {
    type: 'object',
    additionalProperties: false,
    properties: {
      open_cost: { type: 'number', default: 0.0005 },
      close_cost: { type: 'number', default: 0.0015 },
      min_cost: { type: 'number', default: 5 },
      account: { type: 'number', default: 100000000 },
      limit_threshold: { type: 'number' },
    },
    required: ['open_cost', 'close_cost', 'min_cost', 'account'],
  },
  records: {
    type: 'object',
    additionalProperties: false,
    properties: {},
  },

  // Aion-style trading blocks
  run_per_candle: {
    type: 'object',
    additionalProperties: false,
    properties: {
      timeframe: { type: 'string', enum: ['1m', '5m', '15m', '1h', '1d'], default: '1d' },
    },
    required: ['timeframe'],
  },
  run_at_time: {
    type: 'object',
    additionalProperties: false,
    properties: {
      time: { type: 'string', default: '09:30' },
      timezone: { type: 'string', default: 'America/New_York' },
    },
    required: ['time'],
  },
  run_in_session: {
    type: 'object',
    additionalProperties: false,
    properties: {
      session: { type: 'string', enum: ['pre', 'regular', 'post'], default: 'regular' },
    },
    required: ['session'],
  },
  trade_rule: {
    type: 'object',
    additionalProperties: false,
    properties: {
      condition: { type: 'string', default: 'close > open' },
    },
    required: ['condition'],
  },
  check_spread: {
    type: 'object',
    additionalProperties: false,
    properties: {
      max_spread_bps: { type: 'number', default: 10 },
    },
    required: ['max_spread_bps'],
  },
  previous_day_bullish: {
    type: 'object',
    additionalProperties: false,
    properties: {
      lookback: { type: 'number', default: 1 },
    },
    required: ['lookback'],
  },
  candle_close_above_opening_range: {
    type: 'object',
    additionalProperties: false,
    properties: {
      minutes: { type: 'number', default: 30 },
    },
    required: ['minutes'],
  },
  price_above_previous_day_close: {
    type: 'object',
    additionalProperties: false,
    properties: {
      confirm: { type: 'boolean', default: false },
    },
    required: ['confirm'],
  },
  no_trade_for_day: {
    type: 'object',
    additionalProperties: false,
    properties: {
      reason: { type: 'string', default: 'stop-loss hit' },
    },
    required: ['reason'],
  },
  news_filter: {
    type: 'object',
    additionalProperties: false,
    properties: {
      source: { type: 'string', enum: ['general', 'earnings', 'fed', 'macro'], default: 'general' },
      sentiment: { type: 'string', enum: ['any', 'positive', 'negative'], default: 'any' },
    },
    required: ['source'],
  },
  buy_now: {
    type: 'object',
    additionalProperties: false,
    properties: {
      side: { type: 'string', enum: ['long', 'short'], default: 'long' },
      size: { type: 'string', default: '100%' },
    },
    required: ['side', 'size'],
  },
  trade_counter: {
    type: 'object',
    additionalProperties: false,
    properties: {
      max_trades: { type: 'number', default: 3 },
    },
    required: ['max_trades'],
  },
  reset_trade_counter: {
    type: 'object',
    additionalProperties: false,
    properties: {
      max_trades: { type: 'number', default: 3 },
    },
    required: ['max_trades'],
  },
  variable: {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: 'string', default: 'var1' },
      value: { type: 'string', default: '0' },
    },
    required: ['name', 'value'],
  },
  chart_drawing: {
    type: 'object',
    additionalProperties: false,
    properties: {
      type: { type: 'string', enum: ['level', 'trend', 'zone'], default: 'level' },
      price: { type: 'number', default: 0 },
    },
    required: ['type', 'price'],
  },
  context: {
    type: 'object',
    additionalProperties: false,
    properties: {
      text: { type: 'string', default: '', description: 'Describe what you want this strategy to achieve so the AI can factor it into the backtest.' },
    },
    required: ['text'],
  },
  branch: {
    type: 'object',
    additionalProperties: false,
    properties: {
      condition: { type: 'string', default: 'close > open', description: 'Boolean expression that decides which branch to take.' },
    },
    required: ['condition'],
  },
}

/**
 * Map lowercase or otherwise mismatched category ids to the canonical title-case
 * keys used by the frontend colour registry.
 */
export const CANONICAL_CATEGORY = new Map<string, NodeCategory>(
  Object.values(NODE_CATEGORY_INFO).map((c) => [c.id.toLowerCase(), c.id]),
)

export function normaliseCategory(raw: string | undefined): NodeCategory | undefined {
  if (!raw) return undefined
  return CANONICAL_CATEGORY.get(raw.toLowerCase()) ?? (raw as NodeCategory)
}

/**
 * Check whether a node's config satisfies all `config_schema.required` fields.
 *
 * A required field is considered missing when it is undefined, null, an empty
 * string, or an empty array. Numbers (including 0) and booleans are accepted.
 */
export function isNodeConfigComplete(
  node: { type: string; config: Record<string, unknown> },
  meta: { config_schema?: Record<string, unknown> } | undefined,
): boolean {
  const schema = (meta?.config_schema ?? {}) as {
    properties?: Record<string, { type?: string; enum?: unknown[] }>
    required?: string[]
  }
  const required = schema.required ?? []
  if (required.length === 0) return true

  for (const key of required) {
    const value = node.config[key]
    const prop = schema.properties?.[key]
    const propType = prop?.type

    if (value === undefined || value === null) return false

    if (propType === 'array') {
      if (!Array.isArray(value) || value.length === 0) return false
      continue
    }

    if (typeof value === 'string' && value === '') return false
  }

  return true
}

export const NODE_TYPE_INFO: Record<string, NodeTypeInfo> = {
  // Quant pipeline
  data_store: {
    id: 'data_store',
    category: 'Data',
    phase: 'data',
    label: 'Data Store',
    eyebrow: 'Data store',
    icon: 'database',
    description: 'Where the prices come from.',
    ports: PORTS.data_store,
    config_schema: SCHEMAS.data_store,
  },
  universe: {
    id: 'universe',
    category: 'Data',
    phase: 'data',
    label: 'Universe',
    eyebrow: 'Universe',
    icon: 'globe',
    description: 'Which names, against what benchmark.',
    ports: PORTS.universe,
    config_schema: SCHEMAS.universe,
  },
  handler: {
    id: 'handler',
    category: 'Features',
    phase: 'shape',
    label: 'Feature Handler',
    eyebrow: 'Features',
    icon: 'sigma',
    description: 'What the model sees.',
    ports: PORTS.handler,
    config_schema: SCHEMAS.handler,
  },
  model: {
    id: 'model',
    category: 'Model',
    phase: 'fit',
    label: 'Learner',
    eyebrow: 'Learner',
    icon: 'cpu',
    description: 'What fits the signal.',
    ports: PORTS.model,
    config_schema: SCHEMAS.model,
  },
  portfolio: {
    id: 'portfolio',
    category: 'Portfolio',
    phase: 'execute',
    label: 'Portfolio',
    eyebrow: 'Portfolio',
    icon: 'briefcase',
    description: 'How the signal is traded.',
    ports: PORTS.portfolio,
    config_schema: SCHEMAS.portfolio,
  },
  costs: {
    id: 'costs',
    category: 'Execution',
    phase: 'execute',
    label: 'Costs',
    eyebrow: 'Costs',
    icon: 'receipt',
    description: 'What trading takes off the top.',
    ports: PORTS.costs,
    config_schema: SCHEMAS.costs,
  },
  records: {
    id: 'records',
    category: 'Output',
    phase: 'execute',
    label: 'Records',
    eyebrow: 'Output',
    icon: 'file-text',
    description: 'Metrics and records from the backtest.',
    ports: PORTS.records,
    config_schema: SCHEMAS.records,
  },

  // Aion-style trading blocks
  run_per_candle: {
    id: 'run_per_candle',
    category: 'Schedule',
    phase: 'execute',
    label: 'Run per candle',
    eyebrow: 'Schedule',
    icon: 'calendar-clock',
    description: 'Trigger the workflow once per candle.',
    ports: PORTS.run_per_candle,
    config_schema: SCHEMAS.run_per_candle,
  },
  run_at_time: {
    id: 'run_at_time',
    category: 'Schedule',
    phase: 'execute',
    label: 'Run at time',
    eyebrow: 'Schedule',
    icon: 'calendar-range',
    description: 'Trigger the workflow at a specific time.',
    ports: PORTS.run_at_time,
    config_schema: SCHEMAS.run_at_time,
  },
  run_in_session: {
    id: 'run_in_session',
    category: 'Schedule',
    phase: 'execute',
    label: 'Run in session',
    eyebrow: 'Schedule',
    icon: 'calendar-clock',
    description: 'Trigger while a session is active.',
    ports: PORTS.run_in_session,
    config_schema: SCHEMAS.run_in_session,
  },
  trade_rule: {
    id: 'trade_rule',
    category: 'Rules',
    phase: 'execute',
    label: 'Trade rule',
    eyebrow: 'Rule',
    icon: 'filter',
    description: 'A custom boolean condition.',
    ports: PORTS.trade_rule,
    config_schema: SCHEMAS.trade_rule,
  },
  check_spread: {
    id: 'check_spread',
    category: 'Rules',
    phase: 'execute',
    label: 'Check spread',
    eyebrow: 'Rule',
    icon: 'filter',
    description: 'Only pass if the spread is within a limit.',
    ports: PORTS.check_spread,
    config_schema: SCHEMAS.check_spread,
  },
  previous_day_bullish: {
    id: 'previous_day_bullish',
    category: 'Rules',
    phase: 'execute',
    label: 'Previous Day Bullish',
    eyebrow: 'Rule',
    icon: 'trending-up',
    description: 'Requires the previous day to close bullish.',
    ports: PORTS.previous_day_bullish,
    config_schema: SCHEMAS.previous_day_bullish,
  },
  candle_close_above_opening_range: {
    id: 'candle_close_above_opening_range',
    category: 'Rules',
    phase: 'execute',
    label: 'Candle Close above Opening Range',
    eyebrow: 'Rule',
    icon: 'candlestick-chart',
    description: 'Price closed above the opening range.',
    ports: PORTS.candle_close_above_opening_range,
    config_schema: SCHEMAS.candle_close_above_opening_range,
  },
  price_above_previous_day_close: {
    id: 'price_above_previous_day_close',
    category: 'Rules',
    phase: 'execute',
    label: 'Price above previous day close',
    eyebrow: 'Rule',
    icon: 'trending-up',
    description: 'Current price is above the prior close.',
    ports: PORTS.price_above_previous_day_close,
    config_schema: SCHEMAS.price_above_previous_day_close,
  },
  no_trade_for_day: {
    id: 'no_trade_for_day',
    category: 'Rules',
    phase: 'execute',
    label: 'No Trade for the day',
    eyebrow: 'Rule',
    icon: 'filter',
    description: 'Blocks trades for the rest of the day.',
    ports: PORTS.no_trade_for_day,
    config_schema: SCHEMAS.no_trade_for_day,
  },
  news_filter: {
    id: 'news_filter',
    category: 'Rules',
    phase: 'execute',
    label: 'News Filter',
    eyebrow: 'Rule',
    icon: 'newspaper',
    description: 'Filter based on news sentiment or source.',
    ports: PORTS.news_filter,
    config_schema: SCHEMAS.news_filter,
  },
  buy_now: {
    id: 'buy_now',
    category: 'Execution',
    phase: 'execute',
    label: 'Buy now',
    eyebrow: 'Execution',
    icon: 'trending-up',
    description: 'Execute a trade.',
    ports: PORTS.buy_now,
    config_schema: SCHEMAS.buy_now,
  },
  trade_counter: {
    id: 'trade_counter',
    category: 'Management',
    phase: 'execute',
    label: 'Trade counter',
    eyebrow: 'Management',
    icon: 'list-filter',
    description: 'Counts trades and stops after a limit.',
    ports: PORTS.trade_counter,
    config_schema: SCHEMAS.trade_counter,
  },
  reset_trade_counter: {
    id: 'reset_trade_counter',
    category: 'Management',
    phase: 'execute',
    label: 'Reset trade counter',
    eyebrow: 'Management',
    icon: 'rotate-ccw',
    description: 'Resets the daily trade counter.',
    ports: PORTS.reset_trade_counter,
    config_schema: SCHEMAS.reset_trade_counter,
  },
  variable: {
    id: 'variable',
    category: 'Variables',
    phase: 'execute',
    label: 'Variable',
    eyebrow: 'Variable',
    icon: 'sigma',
    description: 'A named value available to other blocks.',
    ports: PORTS.variable,
    config_schema: SCHEMAS.variable,
  },
  chart_drawing: {
    id: 'chart_drawing',
    category: 'Chart Drawings',
    phase: 'execute',
    label: 'Chart drawing',
    eyebrow: 'Drawing',
    icon: 'candlestick-chart',
    description: 'A level, trend line, or zone on the chart.',
    ports: PORTS.chart_drawing,
    config_schema: SCHEMAS.chart_drawing,
  },
  context: {
    id: 'context',
    category: 'Management',
    phase: 'execute',
    label: 'Context',
    eyebrow: 'Objective',
    icon: 'message-square',
    description: "Type what you want to achieve so the AI can factor it in.",
    ports: PORTS.context,
    config_schema: SCHEMAS.context,
  },
  branch: {
    id: 'branch',
    category: 'Rules',
    phase: 'execute',
    label: 'Branch',
    eyebrow: 'Split',
    icon: 'git-branch',
    description: 'Split the workflow into true and false branches.',
    ports: PORTS.branch,
    config_schema: SCHEMAS.branch,
  },
}

export const FALLBACK_NODE_CATEGORIES: KeycardNodeCategory[] = [
  { id: 'Schedule', label: 'When to trade', items: [NODE_TYPE_INFO.run_per_candle, NODE_TYPE_INFO.run_at_time, NODE_TYPE_INFO.run_in_session] },
  { id: 'Rules', label: 'Trading rules', items: [
    NODE_TYPE_INFO.trade_rule,
    NODE_TYPE_INFO.check_spread,
    NODE_TYPE_INFO.previous_day_bullish,
    NODE_TYPE_INFO.candle_close_above_opening_range,
    NODE_TYPE_INFO.price_above_previous_day_close,
    NODE_TYPE_INFO.no_trade_for_day,
    NODE_TYPE_INFO.news_filter,
    NODE_TYPE_INFO.branch,
  ] },
  { id: 'Execution', label: 'Trading execution', items: [NODE_TYPE_INFO.buy_now] },
  { id: 'Management', label: 'Trading management', items: [NODE_TYPE_INFO.trade_counter, NODE_TYPE_INFO.reset_trade_counter, NODE_TYPE_INFO.context] },
  { id: 'Variables', label: 'Variables', items: [NODE_TYPE_INFO.variable] },
  { id: 'Chart Drawings', label: 'Chart drawings', items: [NODE_TYPE_INFO.chart_drawing] },
  { id: 'Data', label: 'Data', items: [NODE_TYPE_INFO.data_store, NODE_TYPE_INFO.universe] },
  { id: 'Features', label: 'Features', items: [NODE_TYPE_INFO.handler] },
  { id: 'Model', label: 'Model', items: [NODE_TYPE_INFO.model] },
  { id: 'Portfolio', label: 'Portfolio', items: [NODE_TYPE_INFO.portfolio] },
  { id: 'Output', label: 'Output', items: [NODE_TYPE_INFO.records] },
].map((cat) => ({
  ...cat,
  items: cat.items.map((info) => ({
    id: info.id,
    category: info.category,
    label: info.label,
    icon: info.icon,
    description: info.description,
    ports: info.ports,
    config_schema: info.config_schema,
  })),
}))

export function nodeInfo(type: string): NodeTypeInfo | undefined {
  return NODE_TYPE_INFO[type]
}

/**
 * Return every node type that can begin a workflow — i.e. it has no required
 * input ports. Used by the canvas starter node to offer the first block.
 */
export function getRootNodeTypes(): NodeTypeInfo[] {
  return Object.values(NODE_TYPE_INFO).filter((info) =>
    info.ports.every((p) => p.direction !== 'in' || p.required === false),
  )
}

/**
 * Return every node type that can accept a connection from a source port of the
 * given type. Used by the canvas "+" menu to offer compatible downstream blocks.
 */
export function getValidChildren(sourcePortType: KeycardPortType): NodeTypeInfo[] {
  return Object.values(NODE_TYPE_INFO).filter((info) =>
    info.ports.some((p) => p.direction === 'in' && p.type === sourcePortType),
  )
}

/**
 * Pick the first input port on a target node type that is compatible with a
 * source port of the given type.
 */
export function getCompatibleInputPort(
  targetType: string,
  sourcePortType: KeycardPortType,
): KeycardPort | undefined {
  const info = nodeInfo(targetType)
  return info?.ports.find((p) => p.direction === 'in' && p.type === sourcePortType)
}
