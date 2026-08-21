/**
 * Typed client for the qlib API.
 *
 * Requests go to a same-origin `/api` path — Vite proxies that to the FastAPI
 * service in dev (see vite.config.ts), and in the container nginx does the
 * same. Nothing here needs to know the API's port, and no API keys ever reach
 * the browser: EODHD and OpenRouter are called server-side only.
 *
 * Every request carries the Supabase access token (see `lib/authFetch.ts`).
 * `request` is the single choke point for that, which is why it is worth having
 * one: the API rejects anonymous callers, so a fetch made anywhere else in the
 * app would 401.
 */
import { authHeaders } from '@/lib/authFetch'

/**
 * FastAPI's array-form validation detail, as sentences that name the field.
 *
 * A Pydantic refusal arrives as `[{loc: ["body", "topk"], msg: "..."}]`, which
 * the structured-refusal branch in `request` does not recognise — so before
 * this existed, clearing a numeric field surfaced as a bare "422 Unprocessable
 * Entity" with no word about which field to fix.
 *
 * Returns null when the shape is not FastAPI's, so the caller keeps the
 * status line instead of inventing a message.
 */
export function validationMessage(detail: unknown): string | null {
  if (!Array.isArray(detail)) return null
  const sentences = detail
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null
      const { loc, msg } = entry as { loc?: unknown; msg?: unknown }
      if (typeof msg !== 'string' || !msg) return null
      // Pydantic wraps custom validators: "Value error, <the actual sentence>".
      const text = msg.replace(/^Value error, /, '')
      const field = (Array.isArray(loc) ? loc : [])
        .filter((part) => part !== 'body')
        .map(String)
        .join('.')
      return field ? `${field}: ${text}` : text
    })
    .filter((s): s is string => Boolean(s))
  return sentences.length ? sentences.join(' ') : null
}

/** A failed request, carrying the backend's structured detail rather than discarding it. */
export class ApiError extends Error {
  readonly status: number
  readonly detail?: unknown

  constructor(status: number, message: string, detail?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.detail = detail
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(`/api${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(await authHeaders()),
      ...(init?.headers ?? {}),
    },
  })

  if (!resp.ok) {
    let detail: unknown
    let message = `${resp.status} ${resp.statusText}`
    try {
      const body = await resp.json()
      detail = body?.detail ?? body
      if (typeof detail === 'string') {
        message = detail
      } else if (Array.isArray(detail)) {
        // FastAPI's own request-validation shape, one entry per bad field.
        message = validationMessage(detail) ?? message
      } else if (detail && typeof detail === 'object') {
        // Structured refusals — a lookahead expression, a draft that failed
        // validation — carry {message, errors[]}. Falling through to
        // "422 Unprocessable Entity" would throw away the only useful part of
        // the response, which is the sentence explaining what to change.
        const d = detail as { message?: string; errors?: { message?: string }[] }
        const reasons = (d.errors ?? []).map((e) => e.message).filter(Boolean)
        message = [d.message, ...reasons].filter(Boolean).join(' ') || message
      }
    } catch {
      // Non-JSON error body — keep the status line as the message.
    }
    throw new ApiError(resp.status, message, detail)
  }

  if (resp.status === 204) return undefined as T
  return resp.json() as Promise<T>
}

export interface QlibStatus {
  ready: boolean
  provider_uri: string | null
  region: string | null
  error: string | null
  qlib_version?: string
  start_date?: string
  end_date?: string
  trading_days?: number
  universes?: string[]
  instrument_count?: number
  is_fallback?: boolean
}

export interface Health {
  status: 'ok' | 'degraded'
  qlib: QlibStatus
  services: { eodhd: boolean; openrouter: boolean }
}

export interface Bar {
  time: string
  open: number | null
  high: number | null
  low: number | null
  close: number | null
  volume: number | null
  factor: number | null
  change: number | null
}

export interface BarsResponse {
  symbol: string
  adjusted: boolean
  count: number
  bars: Bar[]
}

export type AssetClassKey = 'equity' | 'etf' | 'crypto' | 'fx' | 'index'

export interface Instrument {
  symbol: string
  name: string
  asset_class: AssetClassKey
  exchange: string
  /** 'qlib' assets are backtestable; 'market' assets are chart-only. */
  store: 'qlib' | 'market'
}

export interface InstrumentsResponse {
  universe: string | null
  /** Matches before truncation to `limit` — the list may be shorter. */
  total: number
  instruments: Instrument[]
}

export interface AssetClassesResponse {
  classes: { asset_class: AssetClassKey; count: number }[]
  total: number
}

export interface UniversesResponse {
  universes: string[]
  default: string | null
}

export interface FeatureRow {
  instrument: string
  date: string
  values: (number | null)[]
}

export interface FeaturesResponse {
  count: number
  columns: string[]
  rows: FeatureRow[]
}

export interface FeatureQuery {
  instruments: string[] | string
  fields: string[]
  start?: string
  end?: string
}

export interface IngestProgress {
  stage: string
  message: string
  done: number
  total: number
  symbols_ok?: number
  failed_count?: number
  failed_sample?: string[]
}

export interface IngestSummary {
  qlib_dir: string
  symbols_requested: number
  symbols_written: number
  symbols_failed: number
  failed_sample: string[]
  universe: string
  universe_members: number
  non_trading_days_pruned: number
  ranked_as_of: string
  start: string
  end: string | null
}

export interface RefreshRequest {
  universe_size?: number
  start?: string
  end?: string | null
  max_workers?: number
  mode?: 'all' | 'update'
}

export interface IngestJob {
  job_id: string
  status: 'running' | 'done' | 'error'
  started_at: string
  finished_at: string | null
  params: Required<RefreshRequest>
  progress: IngestProgress
  summary: IngestSummary | null
  error: string | null
  /** The store was built, but this API process is still serving another one. */
  restart_required: boolean
}

export interface DataStatus {
  has_eodhd_key: boolean
  /** The store currently mounted — what every chart in the UI is reading. */
  provider_uri: string | null
  region: string | null
  is_fallback: boolean
  /** Where a refresh writes; differs from `provider_uri` on a fallback boot. */
  target_provider_uri: string
  target_exists: boolean
  last_ingest: ({ finished_at: string } & Partial<IngestSummary>) | null
  running_job: IngestJob | null
}

const qs = (params: Record<string, string | number | boolean | undefined>) => {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value))
  }
  const s = search.toString()
  return s ? `?${s}` : ''
}

export const api = {
  health: () => request<Health>('/health'),

  universes: () => request<UniversesResponse>('/universes'),

  dataStatus: () => request<DataStatus>('/data/status'),

  startRefresh: (body: RefreshRequest = {}) =>
    request<{ status: string; job_id: string }>('/data/refresh', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  refreshJob: (jobId: string) => request<IngestJob>(`/data/refresh/${encodeURIComponent(jobId)}`),

  /**
   * Instrument search, or the exact membership of a universe.
   *
   * Pass `store` alongside `universe` to read that store's own instrument file.
   * Without it the lookup goes through qlib and resolves against whichever
   * store the API process mounted — so asking about `crypto_top100` while `us`
   * is mounted returns the US store's copy, presented as the answer.
   */
  instruments: (
    params: {
      universe?: string; store?: string; search?: string
      asset_class?: string; limit?: number
    } = {},
  ) => request<InstrumentsResponse>(`/instruments${qs(params)}`),

  /** Every universe in one store, with its size and a few of its names. */
  storeUniverses: (key: string, sample?: number) =>
    request<StoreUniversesResponse>(
      `/data-stores/${encodeURIComponent(key)}/universes${qs({ sample })}`),

  assetClasses: () => request<AssetClassesResponse>('/asset-classes'),

  dataStores: () => request<{ stores: DataStore[] }>('/data-stores'),

  bars: (symbol: string, params: { start?: string; end?: string; adjusted?: boolean } = {}) =>
    request<BarsResponse>(`/bars/${encodeURIComponent(symbol)}${qs(params)}`),

  features: (query: FeatureQuery) =>
    request<FeaturesResponse>('/features', { method: 'POST', body: JSON.stringify(query) }),

  factorCatalog: (store?: string) => request<FactorCatalog>(`/factors${qs({ store })}`),

  templates: () => request<TemplatesResponse>('/templates'),

  template: (id: string) =>
    request<TemplateEntry>(`/templates/${encodeURIComponent(id)}`),

  operators: () => request<OperatorsResponse>('/operators'),

  indicators: (store?: string) =>
    request<IndicatorsResponse>(`/indicators${qs({ store })}`),

  evaluateFactor: (body: EvaluateFactorRequest) =>
    request<FactorEvaluation>('/factors/evaluate', { method: 'POST', body: JSON.stringify(body) }),

  /**
   * Is this expression safe to run? Costs no data access, so it can be called
   * while an expression is still being drawn rather than when Run is pressed.
   */
  validateExpression: (body: { expression: string; role?: 'feature' | 'label'; store?: string }) =>
    request<ExpressionValidation>('/factors/validate', {
      method: 'POST', body: JSON.stringify(body),
    }),

  models: () => request<ModelsResponse>('/models'),

  previewStrategy: (spec: StrategySpec) =>
    request<StrategyPreview>('/strategies/preview', {
      method: 'POST',
      body: JSON.stringify(spec),
    }),

  /**
   * Parse a strategy file into a spec, server-side.
   *
   * The UI ships no YAML parser, and `StrategySpec` is the authority on what a
   * strategy is — a second, looser reading of the format here would accept
   * files the engine then refuses.
   */
  importStrategy: (text: string) =>
    request<StrategyImport>('/strategies/import', {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),

  listStrategies: () => request<{ strategies: StoredStrategy[] }>('/strategies'),

  getStrategy: (id: string) => request<StoredStrategy>(`/strategies/${id}`),

  saveStrategy: (spec: StrategySpec, id?: string) =>
    request<StoredStrategy>(id ? `/strategies/${id}` : '/strategies', {
      method: id ? 'PUT' : 'POST',
      body: JSON.stringify(spec),
    }),

  /** Share a strategy with the workspace, or take it back. */
  setStrategyVisibility: (id: string, visibility: 'private' | 'org') =>
    request<StoredStrategy>(`/strategies/${id}/visibility`, {
      method: 'PUT',
      body: JSON.stringify({ visibility }),
    }),

  deleteStrategy: (id: string) => request<void>(`/strategies/${id}`, { method: 'DELETE' }),

  startRun: (spec: StrategySpec, strategyId?: string) =>
    request<Run>('/runs', { method: 'POST', body: JSON.stringify({ spec, strategy_id: strategyId }) }),

  /**
   * Every run, newest first.
   *
   * The server caps at 100 when `limit` is absent, and says nothing about it —
   * a strategy iterated on for an afternoon reaches that quietly, and the
   * backtest index then stops showing the early attempts it is there to
   * compare against. `qs` drops `undefined`, so the no-argument call is the
   * same request it always was.
   */
  listRuns: (limit?: number) => request<{ runs: Run[] }>(`/runs${qs({ limit })}`),

  getRun: (id: string) => request<Run>(`/runs/${id}`),

  cancelRun: (id: string) => request<{ ok: boolean }>(`/runs/${id}/cancel`, { method: 'POST' }),

  /**
   * Remove a finished run.
   *
   * 409 while it is queued or running — cancel it first. The run's MLflow
   * experiment and artifacts are left on disk; only the run directory goes.
   */
  deleteRun: (id: string) => request<void>(`/runs/${id}`, { method: 'DELETE' }),

  runReport: (id: string) => request<RunReport>(`/runs/${id}/report`),

  runPredictions: (id: string) =>
    request<{ date: string; top: { instrument: string; score: number | null }[] }>(
      `/runs/${id}/predictions`,
    ),
  // ── Macro ───────────────────────────────────────────────────────────────

  macroSeries: () => request<MacroSeriesResponse>('/macro/series'),

  macroSeriesData: (
    key: string,
    params: { start?: string; end?: string; resample?: MacroResample } = {},
  ) => request<MacroSeriesData>(`/macro/series/${encodeURIComponent(key)}${qs(params)}`),

  macroSnapshot: () => request<MacroSnapshot>('/macro/snapshot'),

  macroCurve: (params: { date?: string; compare?: string } = {}) =>
    request<MacroCurveResponse>(`/macro/curve${qs(params)}`),

  macroCalendar: (
    params: { from?: string; to?: string; country?: string; type?: string; limit?: number } = {},
  ) => request<MacroCalendar>(`/macro/calendar${qs(params)}`),

  macroCalendarTypes: (country = 'US') =>
    request<MacroEventTypes>(`/macro/calendar/types${qs({ country })}`),

  macroCalendarHistory: (params: { event_key: string; country?: string; limit?: number }) =>
    request<MacroReleaseHistory>(`/macro/calendar/history${qs(params)}`),

  macroIndicators: (country = 'USA') =>
    request<CountryIndicators>(`/macro/indicators${qs({ country })}`),

  /** The whole linkage panel in one call. */
  macroLinkage: (
    kind: MacroSubjectKind,
    id: string,
    params: { curve?: string; cov?: 'hac' | 'ols'; max_lag?: number; country?: string } = {},
  ) => request<MacroLinkage>(`/macro/linkage${qs({ kind, id, ...params })}`),

  startMacroRefresh: (body: { what?: 'all' | 'calendar' | 'indicators'; start?: string } = {}) =>
    request<{ status: string; job_id: string }>('/macro/refresh', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  macroRefreshJob: (jobId: string) =>
    request<MacroRefreshJob>(`/macro/refresh/${encodeURIComponent(jobId)}`),

  // ── Portfolios ──────────────────────────────────────────────────────────

  listPortfolios: () =>
    request<{ portfolios: Portfolio[]; summaries: PortfolioSummary[] }>('/portfolios'),

  getPortfolio: (id: string) => request<Portfolio>(`/portfolios/${encodeURIComponent(id)}`),

  // Mirrors saveStrategy: PUT when we already have an id, POST otherwise.
  savePortfolio: (spec: PortfolioSpec, id?: string) =>
    request<Portfolio>(id ? `/portfolios/${id}` : '/portfolios', {
      method: id ? 'PUT' : 'POST',
      body: JSON.stringify(spec),
    }),

  validatePortfolio: (spec: PortfolioSpec) =>
    request<PortfolioValidation>('/portfolios/validate', {
      method: 'POST',
      body: JSON.stringify(spec),
    }),

  deletePortfolio: (id: string) => request<void>(`/portfolios/${id}`, { method: 'DELETE' }),

  portfolioNav: (id: string, params: { start?: string; end?: string } = {}) =>
    request<PortfolioNav>(`/portfolios/${encodeURIComponent(id)}/nav${qs(params)}`),

  portfolioRebalances: (id: string, params: { limit?: number } = {}) =>
    request<PortfolioRebalances>(
      `/portfolios/${encodeURIComponent(id)}/rebalances${qs(params)}`,
    ),

  portfolioStrategies: (id: string) =>
    request<{ portfolio_id: string; strategies: LinkedStrategy[] }>(
      `/portfolios/${encodeURIComponent(id)}/strategies`,
    ),

  // ── Projects ────────────────────────────────────────────────────────────
  listProjects: () => request<{ projects: Project[] }>('/projects'),

  getProject: (id: string) => request<Project>(`/projects/${encodeURIComponent(id)}`),

  saveProject: (spec: ProjectSpec, id?: string) =>
    request<Project>(id ? `/projects/${encodeURIComponent(id)}` : '/projects', {
      method: id ? 'PUT' : 'POST',
      body: JSON.stringify(spec),
    }),

  deleteProject: (id: string) =>
    request<void>(`/projects/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // ── Regime ──────────────────────────────────────────────────────────────

  macroRegime: (params: { inflation?: 'headline' | 'core' } = {}) =>
    request<MacroRegimeResponse>(`/macro/regime${qs(params)}`),

  macroRegimeHistory: (months = 24) =>
    request<MacroRegimeHistory>(`/macro/regime/history${qs({ months })}`),

  macroPlaybook: (lens: PlaybookLens = 'quadrant') =>
    request<MacroPlaybookResponse>(`/macro/regime/playbook${qs({ lens })}`),

  macroLenses: () => request<MacroLensList>('/macro/regime/lenses'),

  // ── Agenda ──────────────────────────────────────────────────────────────

  agendaOutlook: (params: { scope: 'day' | 'week' | 'month'; date: string; force?: boolean }) =>
    request<AgendaOutlook>(`/agenda/outlook${qs(params)}`),

  // ── Activity ────────────────────────────────────────────────────────────

  /** Every long-running thing at once: runs, ingests and macro refreshes. */
  activity: (limit = 50) => request<ActivityFeed>(`/activity${qs({ limit })}`),

  // ── Vibe-Trading sidecar ────────────────────────────────────────────────
  // All of these go through the whitelist proxy (webapp/api/routers/vibe.py);
  // the browser never talks to the sidecar or holds its token. Tool results
  // arrive as vibe's own envelope: { ok/status, data/result, ... }.

  vibeHealth: () => request<VibeHealth>('/vibe/health'),
  /** Generic allowlisted MCP tool call; typed wrappers below are preferred. */
  vibeMcpCall: <T = unknown>(tool: string, args: Record<string, unknown>) =>
    request<{ tool: string; result: T }>('/vibe/mcp/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool, arguments: args }),
    }),
  vibeAlphaList: (filters: { zoo?: string; theme?: string; universe?: string; limit?: number } = {}) =>
    api.vibeMcpCall<VibeAlphaZooEnvelope<VibeAlphaList>>('alpha_zoo', {
      action: 'list_alphas',
      limit: 500,
      ...filters,
    }),
  vibeAlphaGet: (alphaId: string) =>
    api.vibeMcpCall<VibeAlphaZooEnvelope<VibeAlpha>>('alpha_zoo', {
      action: 'get_alpha',
      alpha_id: alphaId,
    }),
  /**
   * The REST `/alpha/{id}`, which carries the zoo module's **source** as well
   * as its meta. The MCP `alpha_zoo get_alpha` above returns meta only, and
   * reading what an alpha actually computes is the whole point of opening one.
   */
  vibeAlphaSource: (alphaId: string) =>
    request<VibeAlphaDetail>(`/vibe/alpha/${encodeURIComponent(alphaId)}`),
  vibeSymbolSearch: (query: string) =>
    api.vibeMcpCall<VibeDataEnvelope<VibeSymbolSearch>>('search_symbol', { query }),
  vibeStockProfile: (ticker: string, sections?: string[]) =>
    api.vibeMcpCall<VibeDataEnvelope<Record<string, unknown>>>('get_stock_profile', {
      ticker,
      ...(sections ? { sections } : {}),
    }),
  vibeFinancials: (code: string, statement: 'balance' | 'income' | 'cashflow' | 'indicators' = 'indicators', period: 'annual' | 'quarter' = 'annual') =>
    api.vibeMcpCall<VibeDataEnvelope<Record<string, unknown>>>('get_financial_statements', {
      code, statement, period,
    }),
  // Broker views are read-only by construction: the proxy's tool allowlist has
  // no order-placing tool, so nothing this client can express places an order.
  vibeBrokerConnections: () =>
    api.vibeMcpCall<VibeBrokerConnections>('trading_connections', {}),
  vibeBrokerSelect: (profileId: string) =>
    api.vibeMcpCall<VibeBrokerResult>('trading_select_connection', { profile_id: profileId }),
  vibeBrokerAccount: () =>
    api.vibeMcpCall<VibeBrokerResult>('trading_account', {}),
  vibeBrokerPositions: () =>
    api.vibeMcpCall<VibeBrokerResult>('trading_positions', {}),
  vibeBrokerOrders: () =>
    api.vibeMcpCall<VibeBrokerResult>('trading_orders', {}),
  vibeBrokerHistory: () =>
    api.vibeMcpCall<VibeBrokerResult>('trading_history', {}),
  // Shadow accounts are journal-driven: upload a broker trade export, let the
  // sidecar mine its profitable roundtrips into 3-5 if-then rules, then scan
  // forward. Reports render inside vibe and are served by path (see
  // vibeShadowReportUrl) so the HTML never round-trips through JSON.
  vibeJournalUpload: async (file: File) => {
    const resp = await fetch(
      `/api/vibe/journal?filename=${encodeURIComponent(file.name)}`,
      { method: 'POST', body: file },
    )
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}))
      throw new ApiError(resp.status,
        typeof body?.detail === 'string' ? body.detail : `${resp.status} upload failed`)
    }
    return resp.json() as Promise<VibeJournalUpload>
  },
  vibeJournalAnalyze: (journalPath: string) =>
    api.vibeMcpCall<VibeShadowResult>('analyze_trade_journal', { journal_path: journalPath }),
  vibeShadowExtract: (journalPath: string, opts: { min_support?: number; max_rules?: number } = {}) =>
    api.vibeMcpCall<VibeShadowResult>('extract_shadow_strategy', {
      journal_path: journalPath, ...opts,
    }),
  vibeShadowBacktest: (shadowId: string, opts: { window_start?: string; window_end?: string; markets?: string[]; journal_path?: string } = {}) =>
    api.vibeMcpCall<VibeShadowResult>('run_shadow_backtest', { shadow_id: shadowId, ...opts }),
  vibeShadowScan: (shadowId: string, opts: { date?: string; per_market?: number } = {}) =>
    api.vibeMcpCall<VibeShadowResult>('scan_shadow_signals', { shadow_id: shadowId, ...opts }),
  vibeShadowRender: (shadowId: string) =>
    api.vibeMcpCall<VibeShadowResult>('render_shadow_report', { shadow_id: shadowId }),
  /** Same-origin URL for the rendered report (proxied GET, allowlisted). */
  vibeShadowReportUrl: (shadowId: string, format: 'html' | 'pdf' = 'html') =>
    `/api/vibe/shadow-reports/${encodeURIComponent(shadowId)}?format=${format}`,

  // --- catalog ------------------------------------------------------------
  // The Database page's one search surface. See webapp/api/catalog/.

  catalogSummary: () => request<CatalogSummary>('/catalog/summary'),

  catalogSearch: (params: CatalogQuery = {}) =>
    request<CatalogPage>(`/catalog/search${qs({ ...params })}`),

  catalogFacets: (kind?: CatalogKind) =>
    request<CatalogFacets>(`/catalog/facets${qs({ kind })}`),

  /** `uid` is `<kind>:<source>:<local_id>` — colons are path-legal, so no encode. */
  catalogEntity: (uid: string) => request<CatalogEntityDetail>(`/catalog/entity/${uid}`),

  catalogReindex: (body: { only?: string[]; include_remote?: boolean } = {}) =>
    request<{ status: string; job_id: string }>('/catalog/reindex', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  catalogReindexJob: (jobId: string) =>
    request<CatalogReindexJob>(`/catalog/reindex/${encodeURIComponent(jobId)}`),

  catalogLink: (body: { src_uid: string; dst_uid: string; rel: CatalogUserRel; note?: string }) =>
    request<{ status: string }>('/catalog/links', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  catalogUnlink: (params: { src_uid: string; dst_uid: string; rel: string }) =>
    request<{ status: string }>(`/catalog/links${qs({ ...params })}`, { method: 'DELETE' }),

  // --- registry -----------------------------------------------------------
  // Agents & Skills. Deliberately the same route names and envelopes as the
  // catalog above, because one browser component renders both pages — see
  // webapp/api/routers/registry.py.

  registrySummary: () => request<RegistrySummary>('/registry/summary'),

  registrySearch: (params: CatalogQuery = {}) =>
    request<RegistryPage>(`/registry/search${qs({ ...params })}`),

  registryFacets: (kind?: RosterKind) =>
    request<CatalogFacets>(`/registry/facets${qs({ kind })}`),

  registryEntity: (uid: string) => request<RegistryEntity>(`/registry/entity/${uid}`),

  /** Drops the TTL cache and returns the fresh summary in the same call. */
  registryRefresh: () =>
    request<RegistrySummary>('/registry/refresh', { method: 'POST' }),

  // --- workspace: who you are, who you work with -------------------------

  me: () => request<Me>('/me'),

  createOrg: (name: string, slug?: string) =>
    request<Organization>('/orgs', {
      method: 'POST',
      body: JSON.stringify({ name, slug }),
    }),

  /** Remembers the choice for the next session; the header carries it now. */
  setDefaultOrg: (orgId: string) =>
    request<{ ok: boolean }>('/me/default-org', {
      method: 'PUT',
      body: JSON.stringify({ org_id: orgId }),
    }),

  orgMembers: (orgId: string) =>
    request<{ members: OrgMember[] }>(`/orgs/${orgId}/members`),

  orgInvites: (orgId: string) =>
    request<{ invites: OrgInvite[] }>(`/orgs/${orgId}/invites`),

  createInvite: (orgId: string, email: string, role: OrgRole = 'member') =>
    request<OrgInvite>(`/orgs/${orgId}/invites`, {
      method: 'POST',
      body: JSON.stringify({ email, role }),
    }),

  acceptInvite: (token: string) =>
    request<{ org_id: string }>('/invites/accept', {
      method: 'POST',
      body: JSON.stringify({ token }),
    }),

  removeMember: (orgId: string, userId: string) =>
    request<void>(`/orgs/${orgId}/members/${userId}`, { method: 'DELETE' }),

  // --- per-user state that used to live in localStorage ------------------

  getPrefs: () => request<{ prefs: Record<string, unknown> }>('/prefs'),

  /** Merged server-side, so two tabs saving different keys do not clobber. */
  savePrefs: (prefs: Record<string, unknown>) =>
    request<{ prefs: Record<string, unknown> }>('/prefs', {
      method: 'PUT',
      body: JSON.stringify({ prefs }),
    }),

  getAgendaSeen: () => request<{ seen: Record<string, string> }>('/agenda/seen'),

  markAgendaSeen: (key: string) =>
    request<{ key: string; seen_at: string }>('/agenda/seen', {
      method: 'PUT',
      body: JSON.stringify({ key }),
    }),

  shadowAccounts: () => request<{ accounts: ShadowAccount[] }>('/shadow-accounts'),

  saveShadowAccount: (account: Partial<ShadowAccount> & { label: string }) =>
    request<ShadowAccount>('/shadow-accounts', {
      method: 'POST',
      body: JSON.stringify(account),
    }),

  deleteShadowAccount: (id: string) =>
    request<void>(`/shadow-accounts/${id}`, { method: 'DELETE' }),

  // --- scheduled tasks ------------------------------------------------------

  listScheduledTasks: () => request<{ tasks: ScheduledTask[] }>('/scheduled/tasks'),

  getScheduledTask: (id: string) => request<ScheduledTask>(`/scheduled/tasks/${id}`),

  saveScheduledTask: (task: ScheduledTaskInput, id?: string) =>
    request<ScheduledTask>(id ? `/scheduled/tasks/${id}` : '/scheduled/tasks', {
      method: id ? 'PUT' : 'POST',
      body: JSON.stringify(task),
    }),

  deleteScheduledTask: (id: string) =>
    request<void>(`/scheduled/tasks/${id}`, { method: 'DELETE' }),

  toggleScheduledTask: (id: string, enabled: boolean) =>
    request<ScheduledTask>(`/scheduled/tasks/${id}/toggle`, {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    }),

  downloadOutlookReport: async (reportId: string) => {
    const resp = await fetch(`/api/outlook-reports/${encodeURIComponent(reportId)}/download`, {
      headers: await authHeaders(),
    })
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}))
      throw new ApiError(resp.status, body?.detail || `${resp.status} Download failed`, body)
    }
    return resp.blob()
  },

  downloadDemoOutlookReport: async () => {
    const resp = await fetch('/api/outlook-reports/demo/download', {
      headers: await authHeaders(),
    })
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}))
      throw new ApiError(resp.status, body?.detail || `${resp.status} Download failed`, body)
    }
    return resp.blob()
  },

  // ── Keycard workflow builder ─────────────────────────────────────────────

  listKeycards: (filters: KeycardListFilters = {}) =>
    request<{ keycards: Keycard[] }>(`/keycards${qs(filters)}`),

  getKeycard: (id: string) => request<Keycard>(`/keycards/${encodeURIComponent(id)}`),

  createKeycard: (spec: KeycardSpec) =>
    request<Keycard>('/keycards', { method: 'POST', body: JSON.stringify(spec) }),

  updateKeycard: (id: string, spec: KeycardSpec) =>
    request<Keycard>(`/keycards/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(spec),
    }),

  deleteKeycard: (id: string) =>
    request<void>(`/keycards/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  forkKeycard: (id: string) =>
    request<Keycard>(`/keycards/${encodeURIComponent(id)}/fork`, { method: 'POST' }),

  listNodeTypes: () => request<{ node_types: KeycardNodeCategory[] }>('/keycards/node-types'),

  compileKeycard: (spec: KeycardSpec) =>
    request<KeycardCompileResult>('/keycards/compile', {
      method: 'POST',
      body: JSON.stringify(spec),
    }),

  startKeycardRun: (id: string) =>
    request<Run>(`/keycards/${encodeURIComponent(id)}/runs`, { method: 'POST' }),

  importKeycard: (payload: string | KeycardSpec) =>
    request<KeycardImportResult>('/keycards/import', {
      method: 'POST',
      body: typeof payload === 'string' ? JSON.stringify({ text: payload }) : JSON.stringify(payload),
    }),
}

export type OrgRole = 'owner' | 'admin' | 'member'

export interface Organization {
  id: string
  name: string
  slug: string
  role: OrgRole
}

/** The signed-in account and every organisation it can act in. */
export interface Me {
  user_id: string
  email: string | null
  org_id: string
  org_role: OrgRole
  is_org_admin: boolean
  organizations: Organization[]
}

export interface OrgMember {
  user_id: string
  role: OrgRole
  joined_at: string
  is_you: boolean
}

export interface OrgInvite {
  id: string
  email: string
  role: OrgRole
  /** There is no mail sender here — the admin passes this on themselves. */
  token: string
  expires_at: string
  accepted_at?: string | null
}

export interface ShadowAccount {
  id: string
  label: string
  journal_path: string | null
  shadow_id: string | null
  created_at: string
}

// --- registry types -------------------------------------------------------

/** The roster's four collections. A subset of `CatalogKind`, same grammar. */
export type RosterKind = 'swarm' | 'agent' | 'skill' | 'tool'

/**
 * A roster row. Structurally the catalog's row — same keys, same uid grammar —
 * because the shared browser must not have to branch on which page it is on.
 * `expression` and `metric` are always null here; they are kept so the two
 * types stay assignable to one another.
 */
export type RegistryEntity = CatalogEntity

export type RegistryPage = CatalogPage

export interface RegistryProvider {
  name: string
  label: string
  kind: RosterKind
  source: CatalogSource
  /** Crosses the network — the ones that can be degraded. */
  remote: boolean
  count: number
  fetched_at: string | null
  /** Set when the last fetch failed. */
  error: string | null
  /**
   * True when the rows on screen predate the failed attempt — the collection
   * is showing older data rather than nothing. False with an error set means
   * the very first fetch failed and there is genuinely nothing.
   */
  stale: boolean
}

export interface RegistrySummary {
  total: number
  collections: CatalogCollection[]
  providers: RegistryProvider[]
  degraded: string[]
  /** How long a provider's rows are served before a re-fetch. */
  ttl_seconds: number
  kinds: { kind: RosterKind; label: string }[]
  sources: CatalogSource[]
}

// --- catalog types --------------------------------------------------------

/**
 * One taxonomy across both pages, mirroring `KINDS` in
 * `webapp/api/catalog/schema.py`. The Database's ten are indexed in SQLite; the
 * roster's four are federated live. They share this union — and the uid grammar
 * behind it — because one browser component renders both, and a second
 * taxonomy would be a second place for a kind name to drift.
 */
export type CatalogKind =
  | 'alpha' | 'indicator' | 'operator' | 'strategy' | 'template'
  | 'backtest' | 'portfolio' | 'instrument' | 'universe' | 'macro_series'
  | RosterKind

/** `rag` is the vendored Aion-RAG backend: harnesses, sub-agents, its tools. */
export type CatalogSource = 'qlib' | 'curated' | 'vibe' | 'aion' | 'eodhd' | 'rag'

/** Rels a person may set. Everything else is derived and wiped on reindex. */
export type CatalogUserRel = 'documented_by' | 'supersedes' | 'related_to'

export type CatalogSort =
  | 'relevance' | 'name' | '-name' | 'metric' | '-metric' | 'updated' | '-updated'

/**
 * One catalog row. `payload` is kind-specific and deliberately untyped here —
 * an alpha's caveat, a backtest's metrics and an instrument's exchange have
 * nothing in common, and promoting any of them to a field would mean editing
 * this file every time a harvester grows a key.
 */
export interface CatalogEntity {
  uid: string
  kind: CatalogKind
  source: CatalogSource
  local_id: string
  name: string
  title: string | null
  summary: string | null
  family: string | null
  tags: string[]
  expression: string | null
  /** The one number this collection sorts by. Null for most kinds. */
  metric: number | null
  updated_at: string | null
  payload: Record<string, unknown>
}

export interface CatalogLink {
  rel: string
  note: string | null
  uid: string
  /** Null when the other end is not in the index — a Supabase document, or a
   *  row a later harvest dropped. The link still renders, unresolved. */
  kind: CatalogKind | null
  name: string | null
  title: string | null
  source: CatalogSource | null
}

export interface CatalogEntityDetail extends CatalogEntity {
  links: { out: CatalogLink[]; in: CatalogLink[] }
}

export interface CatalogQuery {
  q?: string
  kind?: CatalogKind
  source?: CatalogSource
  family?: string
  tag?: string
  sort?: CatalogSort
  limit?: number
  offset?: number
}

export interface CatalogPage {
  results: CatalogEntity[]
  total: number
  limit: number
  offset: number
  returned: number
}

export interface CatalogFacetValue {
  value: string
  count: number
}

export interface CatalogFacets {
  kind: CatalogKind | null
  source: CatalogFacetValue[]
  family: CatalogFacetValue[]
  tags: CatalogFacetValue[]
}

export interface CatalogCollection {
  kind: CatalogKind
  count: number
  sources: Partial<Record<CatalogSource, number>>
}

export interface CatalogHarvestRecord {
  harvester: string
  source: CatalogSource
  started_at: string
  finished_at: string | null
  count: number
  /** Set when the last run failed. The collection is showing the previous
   *  harvest's rows, which is better than empty and worse than fresh. */
  error: string | null
}

export interface CatalogHarvester {
  name: string
  label: string
  kind: CatalogKind
  source: CatalogSource
  /** Crosses the network. A reindex can skip these for a fast local rebuild. */
  remote: boolean
  ever_run: boolean
}

export interface CatalogSummary {
  total: number
  links: number
  /** False on a fresh clone: no rows and no harvest yet. Not an error — the
   *  answer is "press reindex". */
  indexed: boolean
  collections: CatalogCollection[]
  harvests: CatalogHarvestRecord[]
  harvesters: CatalogHarvester[]
  degraded: string[]
  kinds: { kind: CatalogKind; label: string }[]
  sources: CatalogSource[]
  running_job: CatalogReindexJob | null
}

export interface CatalogReindexJob {
  job_id: string
  status: 'running' | 'done' | 'error'
  started_at: string
  finished_at: string | null
  progress: { harvester: string | null; state: string; done: number; total: number }
  report: {
    harvesters: { name: string; kind: string; source: string; count: number; error: string | null }[]
    indexed: number
    links: number
    failed: string[]
    finished_at: string
  } | null
  error: string | null
}

export type ActivityKind = 'run' | 'ingest' | 'macro_refresh'

export interface ActivityProgress {
  stage: string | null
  message: string | null
  done: number | null
  total: number | null
}

/**
 * One item of the aggregate feed. The unified status vocabulary is exactly
 * `RunStatus` — the backend maps ingest/macro job statuses onto it
 * (done → succeeded, error → failed) so the UI renders one vocabulary.
 */
export interface ActivityItem {
  /** `run:<id>` | `ingest:<id>` | `macro:<id>` — unique across sources. */
  id: string
  source_id: string
  kind: ActivityKind
  title: string
  status: RunStatus
  /** Jobs carry no created_at; started_at is stamped at enqueue instead. */
  created_at: string | null
  started_at: string | null
  finished_at: string | null
  phase: string | null
  /** Present for ingest/macro jobs; runs report progress via `phase`. */
  progress: ActivityProgress | null
  error: string | null
  error_hint?: string | null
  restart_required?: boolean | null
}

export interface ActivityFeed {
  items: ActivityItem[]
  generated_at: string
}

export interface AgendaOutlook {
  summary: string
  generated_at: string
  expires_at: string
  cached: boolean
}

export interface ModelsResponse {
  models: { id: string; label: string; class: string }[]
  handlers: string[]
}

export interface DataStore {
  key: 'us' | 'crypto_365'
  label: string
  provider_uri: string
  region: string
  note: string
  exists: boolean
  calendar_days: number
  universes: string[]
  /**
   * The first date this store can answer for.
   *
   * `/health` reports a range too, but only for the *mounted* store — no help
   * for drawing a window against a store you selected and never mounted.
   * null when the store is not built, or when an older server omits it.
   */
  calendar_start: string | null
  /**
   * The last date a backtest may safely end on.
   *
   * Not the store's final bar — qlib reads `calendar[i + 1]` on the last step,
   * so ending there raises an IndexError. null when the store is not built.
   */
  calendar_end: string | null
  /**
   * This store's curated benchmark symbols, from `instruments/benchmarks.txt`.
   *
   * Suggestions, not the constraint: the backend validates a benchmark against
   * the store's `all.txt` (strategy_gen/draft.py:424). Empty for crypto_365,
   * which ships no benchmarks file.
   */
  benchmarks: string[]
  /** Only the mounted store answers Factor Lab / feature queries. */
  mounted: boolean
}

/**
 * What the target store can and cannot compute for a spec.
 *
 * Deliberately separate from `warnings`, which the builder turns into blockers
 * that disable Run. None of this should ever block: a store missing a handler
 * column still produces a *correct* run, because the generated config drops the
 * column before training. This is what the reader is told instead of finding
 * out from a failed run.
 */
export interface StrategyCoverage {
  store: string
  /** false when the store could not be read at all — "no answer", not "no columns". */
  checked: boolean
  handler: string
  model: string
  /** Handler columns this store cannot compute, so they would be all-NaN. */
  dead_columns: string[]
  /** Whether the generated config drops them before training. It does, when there are any. */
  dropped: boolean
  /** Columns that compute but are not what their name promises, keyed by field. */
  proxy_columns: Record<string, string>
  /** Present for some instruments and not others; those names drop out of the cross-section. */
  partial_columns: string[]
  /**
   * The same two problems, found in the spec's *own* factor expressions rather
   * than in the handler's built-in columns.
   *
   * Optional because a server older than these keys is not a server reporting
   * "your factors are clean" — it is one that never looked, and the difference
   * has to survive the wire. Everything above answers for the handler alone.
   */
  feature_proxy_fields?: Record<string, string>
  feature_partial_fields?: string[]
}

/**
 * What a strategy predicts, and over what range the store can answer.
 *
 * The label is read out of qlib rather than written down here: it is
 * handler-dependent, and `Ref($close,-2)/Ref($close,-1)-1` is *not* a two-day
 * return — it is the return from tomorrow's close to the next close. Two days
 * of look-ahead, one session of exposure. `horizon_days` and `holding_days`
 * keep those apart so the UI does not collapse them into a confident wrong
 * sentence.
 */
export interface StrategyExplain {
  label: {
    expression: string
    name: string | null
    horizon_days: number | null
    holding_days: number | null
  } | null
  calendar_start: string | null
  /** The last day a backtest may safely end on, not the store's final bar. */
  calendar_end: string | null
  /** Where the run will really stop, once the clamp applies. */
  effective_test_end: string
}

export interface StoreUniverse {
  name: string
  count: number
  sample: string[]
}

export interface StoreUniversesResponse {
  store: string
  universes: StoreUniverse[]
}

/**
 * One thing wrong with a spec, typed.
 *
 * `severity` rides along rather than being inferred from the wording. The
 * builder used to decide whether a warning blocked a run by matching message
 * prefixes, which meant rewording a sentence could silently change whether a
 * strategy counted as runnable.
 *
 * `path` names the `StrategySpec` field the message is about, and may carry
 * detail past it — `features[2].name`. The *field* is the leading segment,
 * which is what `fieldOf` returns and what stage routing keys on.
 */
export interface SpecDefect {
  code: string
  message: string
  path: string
  severity: 'blocking' | 'advisory'
}

/** A one-click way out of an incompatible choice: set one other field. */
export interface OptionFix {
  path: string
  value: unknown
  label: string
}

/**
 * One value a field may take, and whether it may take it *given the rest of
 * the spec*. A disabled option is still sent: filtering incompatible values
 * out would hide the shape of the system and turn an early pick into a dead
 * end, where greying one out with its reason teaches the constraint.
 */
export interface FieldOption {
  value: string
  label: string
  enabled: boolean
  reason: string | null
  fix: OptionFix | null
}

export interface FieldOptions {
  options: FieldOption[]
  /** Numeric limits, read off the Pydantic field rather than retyped here. */
  bounds: { min?: number; max?: number | string; exclusive_min?: number; exclusive_max?: number } | null
  /** Prose for the whole field, when the option list alone would mislead. */
  note: string | null
}

export interface StrategyPreview {
  /** The exact text handed to qrun. */
  yaml: string
  /**
   * Window and feature-set problems, untyped and flat.
   *
   * What the wire carried before `defects`. Kept because more than one reader
   * still takes it, but it cannot express severity and it does not mention an
   * unknown universe or benchmark — prefer `defects` for anything new.
   */
  warnings: string[]
  /** Advisory. Optional so an older server degrades to hiding the banner. */
  coverage?: StrategyCoverage
  /** Optional for the same reason. */
  explain?: StrategyExplain
  /** Optional so an older server degrades to the `warnings` behaviour. */
  defects?: SpecDefect[]
  /** Optional for the same reason: absent means "offer everything". */
  options?: Record<string, FieldOptions>
}

/**
 * A parsed strategy file, and everything the builder must say about it.
 *
 * Nothing here has been saved or repaired. `spec` is the file as it was, so a
 * conflicting field can be marked in place rather than rewritten behind the
 * reader's back.
 */
export interface StrategyImport {
  spec: StrategySpec
  /** Keys that are not part of a strategy at all. */
  unknown_fields: string[]
  /** Fields that would not hold their value, dropped to the default and named. */
  rejected: { path: string; message: string; value: unknown }[]
  defects: SpecDefect[]
  options: Record<string, FieldOptions>
}

export interface FeatureColumn {
  /** Becomes a pandas column name. Must not repeat a handler column's name. */
  name: string
  expression: string
}

export type FeatureMode = 'extend' | 'replace'

export interface StrategySpec {
  name: string
  model: string
  handler: string
  /** Which qlib store to backtest against — a store is one trading calendar. */
  data_store: 'us' | 'crypto_365'
  universe: string
  benchmark: string
  train_start: string
  train_end: string
  valid_start: string
  valid_end: string
  test_start: string
  test_end: string
  topk: number
  n_drop: number
  open_cost: number
  close_cost: number
  min_cost: number
  account: number
  limit_threshold: number | null
  /**
   * Custom factor columns computed in front of the model.
   *
   * null means the handler's own feature set, untouched — and it must stay
   * distinguishable from `[]`, which the backend normalises to null so that
   * deleting the last card is the same strategy rather than a different config.
   */
  features: FeatureColumn[] | null
  /** Whether `features` are added to the handler's own, or replace them. */
  feature_mode: FeatureMode
}

export interface StoredStrategy extends StrategySpec {
  id: string
  created_at: string
  updated_at: string
  /** Owner. Compare against the signed-in user to decide whether to offer
   *  edit and delete — the same check the RAG document and folder menus make. */
  user_id: string
  /** 'org' means colleagues in the same workspace can read it. They still
   *  cannot change it: the server enforces that, this only shapes the UI. */
  visibility: 'private' | 'org'
}

/** One thing wrong with a draft, in the draft's own coordinates. */
export interface DraftDefect {
  code: string
  message: string
  path?: string | null
}

/** A field the server filled in, and why — a template states only what it is about. */
export interface AssumedParam {
  path: string
  value: unknown
  why: string
}

/**
 * A curated starting point, lowered against this machine.
 *
 * `spec` is absent when `runnable` is false: the template could not be lowered
 * here, and `blocked_by` says why. Such a template is still returned rather than
 * omitted, so the gallery can explain the gap instead of hiding it.
 */
export interface TemplateEntry {
  id: string
  title: string
  family: string
  tags: string[]
  rationale: string
  good_for: string[]
  bad_for: string[]
  runnable: boolean
  blocked_by: DraftDefect[]
  spec?: StrategySpec
  assumed?: AssumedParam[]
  warnings?: string[]
}

export interface TemplatesResponse {
  templates: TemplateEntry[]
  families: { key: string; label: string }[]
}

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export interface Run {
  id: string
  name: string
  kind: string
  status: RunStatus
  phase: string
  created_at: string
  started_at: string | null
  finished_at: string | null
  exit_code: number | null
  /** The tail of the log — a traceback, for when the hint is not enough. */
  error: string | null
  /**
   * A plain sentence for a failure the backend recognises, or null.
   *
   * `runner._DIAGNOSES` maps the handful of knowable causes — an all-NaN
   * column, a missing dependency, running past the calendar — to something
   * readable. Show this; keep `error` behind a disclosure.
   */
  error_hint?: string | null
  experiment_name: string
  strategy_id?: string | null
  /**
   * What the run was, recorded at launch.
   *
   * Optional throughout because this dict has been widened over time and old
   * runs simply lack the newer keys. That is why comparison renders a missing
   * value as an em dash rather than dropping the row: "we did not record this"
   * and "it was the same" are different claims.
   */
  model?: string
  handler?: string
  /**
   * Whether the custom factors extended the handler's features or replaced them.
   *
   * Load-bearing alongside `handler`: under "replace" the handler's own feature
   * set was never loaded, so naming it on its own misreports what the run saw.
   * Absent on runs started before this was recorded — see `featureSetOf`.
   */
  feature_mode?: 'extend' | 'replace'
  feature_count?: number
  universe?: string
  benchmark?: string
  data_store?: string
  topk?: number
  n_drop?: number
  open_cost?: number
  close_cost?: number
  /**
   * The run's headline figures, so a list can print them without one
   * `/report` call per row.
   *
   * This is the `excess_return_with_cost` row of the full risk table, under
   * the same keys `runMetrics.ts#excessOf` reads off a report — pass it to
   * `summaryRow()` to get the same `MetricRow` a report would have produced.
   * Absent on a run that has not finished, and on runs that finished before
   * the snapshot existed.
   */
  summary?: Record<string, number | null>
}

export interface CurvePoint {
  date: string
  value: number | null
}

/**
 * Whether the portfolio numbers can be read as a result at all.
 *
 * Decided by the backend (`api/results._sanity`) rather than per component, so
 * the ledger, the report and the compare modal cannot disagree about one run.
 */
export interface RunSanity {
  implausible: boolean
  reasons: string[]
}

export interface RunReport {
  recorder_id: string | null
  experiment_name: string
  metrics: Record<string, number | null>
  risk: Record<string, Record<string, number | null>>
  curves: Partial<Record<'strategy' | 'benchmark' | 'net_of_cost' | 'excess' | 'drawdown', CurvePoint[]>>
  indicators?: Record<string, number | null>
  period?: { start: string; end: string; days: number }
  /** Absent on runs whose report predates the check. */
  sanity?: RunSanity
  /** True when MLflow was unreadable and the run's own snapshot was used. */
  from_snapshot?: boolean
  run: Run
}

export const DEFAULT_STRATEGY: StrategySpec = {
  name: 'New strategy',
  model: 'lightgbm',
  handler: 'Alpha158',
  data_store: 'us',
  universe: 'top500',
  benchmark: 'SPY',
  train_start: '2010-01-04',
  train_end: '2019-12-31',
  valid_start: '2020-01-01',
  valid_end: '2021-12-31',
  test_start: '2022-01-01',
  /**
   * A placeholder until the store answers.
   *
   * The real value is the store's `calendar_end` — the builder overwrites this
   * as soon as `GET /data-stores` lands. Left here so the shape is complete
   * before the first fetch; it must not be treated as the default a user runs
   * with, because a literal goes stale the next time an ingest extends the
   * calendar and the backend would then silently end the run early.
   */
  test_end: '2026-08-07',
  topk: 50,
  n_drop: 5,
  open_cost: 0.0005,
  close_cost: 0.0015,
  min_cost: 5,
  account: 100000000,
  limit_threshold: null,
  features: null,
  feature_mode: 'extend',
}

/** One entry in the curated factor library, judged against a store. */
export interface CatalogFactor {
  name: string
  expression: string
  family: string
  summary: string
  /** The lookback the name refers to, when it has one. */
  window: number | null
  tags: string[]
  fields: string[]
  /**
   * Trading days of history before this factor means anything.
   *
   * Worth showing because qlib's rolling uses `min_periods=1`: a 60-day
   * volatility returns a confident number from two observations, while a
   * 252-day lag is honestly blank for a year. Nothing else distinguishes them.
   */
  back_days: number | null
  /** null when no store was available to check against — unknown, not true. */
  runnable: boolean | null
  /** A gotcha you would otherwise discover from a wrong number. */
  caveat?: string
  /** Why it cannot run against this store. */
  note?: string
}

/**
 * A curated-library family, in the order the backend served it.
 *
 * `curated.py` treats that order as authoritative — it decides how the library
 * reads to someone meeting it for the first time — so the palette consumes this
 * rather than inventing an order or capitalising the raw key.
 */
export interface FactorFamily {
  key: string
  label: string
  description: string
  count: number
}

export interface FactorCatalog {
  factors: CatalogFactor[]
  families: FactorFamily[]
  store: {
    provider_uri: string | null
    checked: boolean
    missing_columns: string[]
    partial_columns: string[]
    /**
     * Columns that exist but are not what their name promises, keyed by field.
     *
     * Distinct from `missing_columns`: those break an expression, these change
     * what it measures. `$vwap` is typical price on both stores — written at
     * ingest because no source here carries an intraday volume-weighted price.
     */
    proxy_columns: Record<string, string>
  }
  operators: string[]
  fields: string[]
}

/**
 * The served operator vocabulary, introspected from qlib's own OpsList.
 *
 * Typed as the canvas's own `OperatorRegistry` at the call site rather than
 * duplicated here — `mergeRegistry` replaces whole entries, so the two shapes
 * have to be the same shape, not merely compatible.
 */
export interface OperatorsResponse {
  operators: Record<string, unknown>
  refused: { name: string; summary: string; reason: string }[]
}

export interface Indicator {
  name: string
  expression: string
  family: 'kbar' | 'price' | 'volume' | 'rolling'
  group: string
  description: string
  window: number | null
  fields: string[]
  /**
   * This exact expression is one of the 158 columns Alpha158 trains on.
   *
   * The other 26 are part of the same generated vocabulary — valid, measurable,
   * usable on the canvas — but no strategy sees them unless you add them.
   */
  in_handler: boolean
  /** null when no store was available to check against — unknown, not true. */
  runnable: boolean | null
  /** Why it cannot run here, or why it carries no information. */
  note?: string
  /**
   * Fields this indicator reads that exist but are not what their name
   * promises — `$vwap` is typical price on both stores here. Distinct from a
   * missing column: the indicator *runs*, and the open question is what it
   * measures. Served by `library_payload` and previously unmodelled here.
   */
  proxy_fields?: string[]
}

export interface IndicatorsResponse {
  indicators: Indicator[]
  families: { key: string; label: string; count: number; in_handler: number }[]
  windows: { price: number[]; rolling: number[] }
  handler: { name: string; columns: number; note: string }
  store: {
    provider_uri: string | null
    checked: boolean
    missing_columns: string[]
    partial_columns: string[]
    /**
     * Columns that exist but are not what their name promises, keyed by field.
     *
     * Distinct from `missing_columns`: those break an expression, these change
     * what it measures. `$vwap` is typical price on both stores — written at
     * ingest because no source here carries an intraday volume-weighted price.
     */
    proxy_columns: Record<string, string>
  }
}

export interface ExpressionDefect {
  /** `lookahead`, `invalid`, `negative_window`, `unbounded_history`, … */
  code: string
  message: string
  path: string | null
}

export interface ExpressionValidation {
  ok: boolean
  defects: ExpressionDefect[]
  /** Days of future the expression reads. Non-zero is lookahead in a feature. */
  reads_ahead_days?: number
  /** null when the expression needs unbounded history. */
  longest_back_rolling?: number | null
  rendered?: string
}

export interface EvaluateFactorRequest {
  expression: string
  universe?: string
  start?: string
  end?: string
  horizon?: number
}

export interface IcStats {
  mean: number | null
  std: number | null
  ir: number | null
  positive_rate: number | null
}

export interface FactorEvaluation {
  expression: string
  universe: string
  horizon: number
  observations: number
  days: number
  ic: IcStats
  rank_ic: IcStats
  series: { date: string; ic: number | null }[]
  cumulative_ic: number | null
}

// ──────────────────────────────────────────────────────────────────────────
// Macro
// ──────────────────────────────────────────────────────────────────────────

export type MacroGroup =
  | 'rates' | 'inflation' | 'growth' | 'volatility' | 'dollar' | 'commodities' | 'credit'

/** What a level means. Drives formatting, and which transform produced `change`. */
export type MacroUnit = 'percent' | 'index' | 'log_ratio'
/** Basis points for a differenced yield; a log return for everything else. */
export type MacroChangeUnit = 'bps' | 'log'
export type MacroResample = 'daily' | 'weekly' | 'monthly'
export type MacroSubjectKind = 'strategy' | 'run' | 'portfolio'

export interface MacroSeries {
  key: string
  label: string
  group: MacroGroup
  unit: MacroUnit
  change_unit: MacroChangeUnit
  source: string
  /** Computed from other series (the 10Y-2Y slope) rather than read from disk. */
  derived: boolean
  in_basket: boolean
  /** False for annual data, which is charted but never regressed. */
  daily_ok: boolean
  note: string
  /**
   * False when nothing is on disk. The series is still listed — a shorter list
   * would read as "this desk does not track the dollar", which is a different
   * and wrong statement.
   */
  available: boolean
  reason: string | null
  first?: string
  last?: string
  n?: number
  /** Set when a fallback ticker is standing in (TNX for US10Y, scaled). */
  substituted_from?: string | null
}

export interface MacroSeriesResponse {
  groups: { group: MacroGroup; label: string; series: MacroSeries[] }[]
  basket: string[]
  count: number
  available: number
}

export interface MacroPoint {
  date: string
  value: number | null
  change?: number | null
}

export interface MacroSeriesData {
  key: string
  label: string
  group: MacroGroup
  unit: MacroUnit
  change_unit: MacroChangeUnit
  derived: boolean
  note: string
  resample: MacroResample
  coverage: { available: boolean; reason: string | null; first?: string; last?: string }
  substituted_from: string | null
  points: MacroPoint[]
}

export interface MacroSnapshotRow {
  key: string
  label: string
  group: MacroGroup
  unit: MacroUnit
  change_unit: MacroChangeUnit
  available: boolean
  reason: string | null
  as_of: string | null
  level: number | null
  change_1d: number | null
  change_1w: number | null
  change_1m: number | null
  change_1y: number | null
  /**
   * The level against its own trailing history. Null — never 0 — when there is
   * too little history to score, so the tile can stay untinted rather than
   * reading as "normal".
   */
  zscore: number | null
  spark: (number | null)[]
}

export interface MacroSnapshot {
  as_of: string | null
  rows: MacroSnapshotRow[]
  available: boolean
  reason?: string
  groups: { group: MacroGroup; label: string }[]
}

export interface CurveTenor {
  tenor: string
  months: number
  yield: number | null
}

export interface MacroCurve {
  date: string
  /** The trading day actually drawn; differs when `date` was a holiday. */
  resolved_date: string
  tenors: CurveTenor[]
}

export interface MacroCurveResponse {
  current: MacroCurve
  compare: MacroCurve | null
  compare_label: string | null
}

export interface MacroRelease {
  date: string
  time: string | null
  country: string | null
  type: string | null
  event_key: string | null
  period: string | null
  /** 'mom' / 'yoy' / null — the same release prints under several bases. */
  comparison: string | null
  actual: number | null
  estimate: number | null
  previous: number | null
  /** actual - estimate, null when either is missing. Never derived from `previous`. */
  surprise: number | null
  /** actual - previous, as normalised by the ingest; null when unfiled. */
  change: number | null
  change_percentage: number | null
  /** Derived server-side from the desk's headline list; EODHD has no importance. */
  importance?: 'headline' | 'standard' | 'low'
  is_forecast: boolean
}

/** Trailing prints of one indicator — the release-detail history chart feed. */
export interface MacroReleaseHistory {
  available: boolean
  reason?: string | null
  event_key: string
  country: string | null
  points: MacroRelease[]
}

/** Cache freshness, carried on every cached-macro response. */
export interface MacroCacheStatus {
  available: boolean
  reason?: string
  fetched_at: string | null
  age_seconds: number | null
  stale: boolean
}

export interface MacroCalendar extends MacroCacheStatus {
  from?: string
  to?: string
  /** The cache's own coverage — `from`/`to` echo the query window instead. */
  cache_from?: string | null
  cache_to?: string | null
  country?: string | null
  countries?: string[]
  rows?: number
  past: MacroRelease[]
  upcoming: MacroRelease[]
}

export interface MacroEventTypes {
  available: boolean
  reason?: string
  country?: string | null
  types: { country: string; type: string; event_key: string; n: number }[]
}

export interface CountryIndicator {
  key: string
  label: string
  group: string
  unit: string
  frequency: string
  country: string
  /** Annual data — the year is part of the value and is never dropped. */
  latest_year: number | null
  latest: number | null
  previous: number | null
  history: { year: number; value: number | null }[]
}

export interface CountryIndicators extends MacroCacheStatus {
  country: string
  series?: number
  indicators: CountryIndicator[]
}

export interface MacroDriver {
  key: string
  label: string
  group: MacroGroup
  change_unit: MacroChangeUnit
  pearson: number | null
  spearman: number | null
  p_value: number | null
  p_value_adj: number | null
  /** Daily return in bps per one-standard-deviation macro move. */
  beta_per_sd: number | null
  n: number
  lag: number
  available: boolean
  reason: string | null
}

export interface MacroBeta {
  key: string
  label: string
  group: string
  beta: number
  std_error: number
  t_stat: number
  p_value: number | null
  /** Variance inflation. Above 5 the beta is largely explained by its peers. */
  vif: number | null
}

export interface MacroFactorModel {
  alpha: MacroBeta
  rows: MacroBeta[]
  r_squared: number
  adj_r_squared: number
  n: number
  k: number
  cov: 'hac' | 'ols'
  hac_lags: number
  dropped: { key: string; reason: string }[]
  warnings: string[]
}

export interface MacroRegimeBucket {
  regime: string
  label: string
  rates: 'rising' | 'falling'
  vol: 'high' | 'low'
  days: number
  share: number
  mean_daily_return: number | null
  ann_return: number | null
  ann_vol: number | null
  sharpe: number | null
  hit_rate: number | null
  /** Set when the bucket is too thin to report statistics for. */
  reason: string | null
}

export interface MacroRegimeReport {
  buckets: MacroRegimeBucket[]
  unclassified: number
  runs: { start: string; end: string; label: string }[]
  rates_key: string
  vol_key: string
  momentum: number
  lookback: number
  warnings: string[]
}

export interface MacroEventRow {
  event_key: string
  type: string
  country: string
  n: number
  /** Cumulative abnormal return over the release day and the next session. */
  car_0_1: number | null
  t: number | null
  p: number | null
  hit_rate: number | null
}

export interface MacroLinkage {
  subject: { kind: MacroSubjectKind; id: string; name: string; run_id: string | null }
  window: { start: string; end: string; days: number }
  run_id: string | null
  curve: string
  drivers: MacroDriver[]
  betas: MacroFactorModel | null
  regimes: MacroRegimeReport | null
  events: MacroEventRow[]
  /** Per-panel refusals — one analytic can fail while the others succeed. */
  notes: Record<string, string>
}

export interface MacroRefreshJob {
  job_id: string
  status: 'running' | 'done' | 'error'
  started_at: string
  finished_at: string | null
  progress: { stage: string; message: string; done: number; total: number }
  summary: { calendar_rows: number; indicator_rows: number; warnings: string[] } | null
  error: string | null
}

// ──────────────────────────────────────────────────────────────────────────
// Portfolios
// ──────────────────────────────────────────────────────────────────────────

export type BaseCurrency = 'USD' | 'EUR' | 'GBP' | 'JPY' | 'CHF'
export type Rebalance = 'none' | 'monthly' | 'quarterly' | 'annual'

export interface PortfolioHolding {
  symbol: string
  asset_class: AssetClassKey
  /** Target weight as a fraction of NAV. */
  weight: number
}

export interface PortfolioSpec {
  name: string
  base_ccy: BaseCurrency
  benchmark: string
  holdings: PortfolioHolding[]
  strategy_ids: string[]
  inception: string
  rebalance: Rebalance
  cost_bps: number
  notes: string
}

export interface Portfolio extends PortfolioSpec {
  id: string
  created_at: string
  updated_at: string
}

/**
 * A named container for work that lives in other stores.
 *
 * Membership is by id and is never validated server-side (see
 * `webapp/api/projects.py`): a project holding a since-deleted strategy shows
 * one fewer member rather than failing to load. Thread and document ids point
 * into Supabase, which this client cannot reach — the RAG client resolves those.
 */
export interface ProjectSpec {
  name: string
  description: string
  strategy_ids: string[]
  portfolio_ids: string[]
  thread_ids: string[]
  document_ids: string[]
}

export interface Project extends ProjectSpec {
  id: string
  created_at: string
  updated_at: string
}

export interface PortfolioSummary {
  id: string
  name: string
  base_ccy: BaseCurrency
  benchmark: string
  n_holdings: number
  rebalance: Rebalance
  inception: string
  strategy_ids: string[]
  created_at: string
  updated_at: string
}

export interface PortfolioContribution {
  symbol: string
  asset_class: string | null
  name: string | null
  source: 'qlib' | 'market' | null
  weight: number | null
  total_return: number | null
  contribution: number | null
}

export interface AllocationSlice {
  asset_class: string
  label: string
  weight: number | null
}

export interface PortfolioNav {
  portfolio_id: string | null
  base_ccy: BaseCurrency
  benchmark: string | null
  rebalance: Rebalance
  period: { start: string; end: string; days: number }
  curves: {
    /** NAV_t / NAV_0 - 1 — the same unit as a run report's `strategy` curve. */
    nav: CurvePoint[]
    gross: CurvePoint[]
    benchmark: CurvePoint[]
    excess: CurvePoint[]
    drawdown: CurvePoint[]
  }
  metrics: {
    total_return: number | null
    annualised_return: number | null
    annualised_vol: number | null
    sharpe: number | null
    max_drawdown: number | null
    annual_turnover: number | null
    cost_drag: number | null
    hit_rate: number | null
  }
  contribution: PortfolioContribution[]
  allocation: AllocationSlice[]
  /** Every rebalance as a dated event; turnover/cost are fractions, not currency. */
  rebalances: RebalanceEvent[]
  /**
   * Holdings with no bars over the window. The curve is still real, but it is
   * not the portfolio the user described — saying so is the whole point.
   */
  unpriced: { symbol: string; reason: string }[]
  warnings: string[]
}

export interface RebalanceEvent {
  date: string
  /** Fraction of the book traded (one-way). */
  turnover: number | null
  /** Return-units drag charged that session. */
  cost: number | null
}

export interface PortfolioRebalances {
  portfolio_id: string
  name: string
  rebalance: Rebalance
  rebalances: RebalanceEvent[]
  /** Present when the book could not be priced — soft, never a 409. */
  reason?: string
}

export interface PortfolioValidation {
  resolved: { symbol: string; source: string; first: string; last: string; n: number }[]
  unpriced: { symbol: string; reason: string }[]
  warnings: string[]
  errors: string[]
}

export interface LinkedStrategy {
  strategy_id: string
  name: string | null
  /** True when the id points at a strategy that no longer exists. */
  missing: boolean
  model: string | null
  handler: string | null
  universe: string | null
  latest_run: { id: string; status: RunStatus; created_at: string } | null
  run_count: number
}

export const DEFAULT_PORTFOLIO: PortfolioSpec = {
  name: 'New portfolio',
  base_ccy: 'USD',
  benchmark: 'SPY',
  holdings: [],
  strategy_ids: [],
  inception: '2021-01-04',
  rebalance: 'monthly',
  cost_bps: 10,
  notes: '',
}

// ──────────────────────────────────────────────────────────────────────────
// Regime
// ──────────────────────────────────────────────────────────────────────────

export type QuadrantState =
  | 'reflation' | 'goldilocks' | 'stagflation'
  | 'disinflationary_slowdown' | 'transitional' | 'unknown'

export type PlaybookLens = 'quadrant' | 'rate_cycle' | 'risk' | 'market'

export interface RegimeAxis {
  direction: 'rising' | 'falling' | 'flat' | 'unknown'
  delta_6m: number | null
  delta_3m: number | null
  latest: number | null
  latest_date: string | null
  source_key: string | null
}

export interface RegimeQuadrant {
  label: string | null
  state: QuadrantState | string
  growth: RegimeAxis
  inflation: RegimeAxis
  /** Mean growth-typed surprise direction, when the flat tie-break was consulted. */
  growth_tilt: number | null
  tie_break_used: boolean
  as_of: string | null
  reason: string | null
}

export interface RegimeRateCycle {
  stage: string
  state: string
  /** 'US3M' normally; 'fomc_decisions' is a stated degradation. */
  source: 'US3M' | 'fomc_decisions'
  front_end: number | null
  delta_3m: number | null
  delta_12m: number | null
  /** The Fed's published target — the range's UPPER bound. */
  policy_rate: number | null
  policy_rate_date: string | null
  /** Front end against the target MIDPOINT, not the upper bound. */
  front_end_vs_policy: number | null
  curve_spread: number | null
  inverted: boolean | null
  as_of: string | null
  reason: string | null
}

export interface RegimeRiskVote {
  name: string
  value: number | null
  vote: number
}

export interface RegimeRisk {
  label: string
  state: string
  score: number | null
  components: RegimeRiskVote[]
  missing: string[]
  as_of: string | null
  reason: string | null
}

export interface RegimeMarket {
  state: string
  label: string | null
  rates: string | null
  vol: string | null
  rates_momentum: number | null
  vol_z: number | null
  as_of: string | null
  reason: string | null
}

export interface RegimeHeadlineReading {
  code: string
  label: string
  /** Carried so the hero does not hardcode '%'. */
  unit: MacroUnit
  value: number | null
  prior: number | null
  date: string | null
}

export interface MacroRegimeResponse {
  as_of: string | null
  quadrant: RegimeQuadrant
  rate_cycle: RegimeRateCycle
  risk: RegimeRisk
  market: RegimeMarket
  headline_readings: RegimeHeadlineReading[]
  /** EODHD revises `actual` in place, so a replay is latest-vintage. */
  vintage: 'latest'
  available: boolean
  reason: string | null
  warnings: string[]
}

export interface RegimeHistoryMonth {
  /** `YYYY-MM`. The year label keys on a January suffix. */
  month: string
  quadrant: string | null
  quadrant_state: string | null
  rate_stage: string | null
  risk: string | null
  market: string | null
}

export interface MacroRegimeHistory {
  months: RegimeHistoryMonth[]
  available: boolean
  reason: string | null
}

export interface PlaybookCell {
  key: string
  label: string
  ann_return: number | null
  ann_vol: number | null
  sharpe: number | null
  hit_rate: number | null
  n: number
  /** Enough days but too few episodes — shown, but not a result. */
  thin: boolean
  reason: string | null
}

export interface PlaybookState {
  state: string
  label: string
  days: number
  /** The honest denominator: 400 days over 2 episodes is 2 observations. */
  episodes: number
  share: number
  current: boolean
  first: string | null
  last: string | null
  median_episode_days: number | null
  runs: { start: string; end: string; label: string }[]
  assets: PlaybookCell[]
}

export interface MacroPlaybookResponse {
  lens: PlaybookLens
  label: string
  caveat: string
  available: boolean
  reason: string | null
  window: { start: string; end: string; days: number } | null
  unclassified: number
  assets: { key: string; label: string }[]
  states: PlaybookState[]
  warnings: string[]
}

export interface MacroLensList {
  lenses: {
    key: PlaybookLens
    label: string
    caveat: string
    states: { state: string; label: string }[]
  }[]
}

// ── Vibe-Trading sidecar types ─────────────────────────────────────────────

export interface VibeHealth {
  status: 'ok' | 'unreachable'
  detail?: string
}

/** alpha_zoo tool envelope: { status: "ok", result: T }. */
export interface VibeAlphaZooEnvelope<T> {
  status: string
  result: T
}

/** Data tools envelope: { ok, market, source, data }. */
export interface VibeDataEnvelope<T> {
  ok: boolean
  market?: string
  source?: string
  data: T
  error?: string
}

export interface VibeAlpha {
  id: string
  zoo: string
  nickname: string
  theme: string[]
  formula_latex: string
  columns_required: string[]
  extras_required: string[]
  requires_sector: boolean
  universe: string[]
  frequency: string[]
  decay_horizon: number | null
  min_warmup_bars: number | null
  notes: string
}

export interface VibeAlphaList {
  total: number
  returned: number
  truncated: boolean
  filters: { zoo: string | null; theme: string | null; universe: string | null }
  items: VibeAlpha[]
}

/** `GET /api/vibe/alpha/{id}` — meta plus the zoo module's Python source. */
export interface VibeAlphaDetail {
  status: string
  alpha: {
    id: string
    zoo: string
    module_path: string
    meta: VibeAlpha
  }
  /** `# <source unavailable: …>` when the sidecar could not read the module. */
  source_code: string
}

export interface VibeSymbolCandidate {
  symbol: string
  name: string
  market: string
  type?: string
  source?: string
  also_from?: string[]
  cik?: string
}

export interface VibeSymbolSearch {
  query: string
  count: number
  candidates: VibeSymbolCandidate[]
}

export interface VibeBrokerProfile {
  id: string
  connector: string
  label: string
  environment: 'paper' | 'live' | string
  transport?: string
  capabilities: string[]
  readonly: boolean
  config?: Record<string, unknown>
  notes?: string
}

export interface VibeBrokerConnections {
  status: 'ok' | 'error'
  error?: string
  selected_profile: string | null
  profiles: VibeBrokerProfile[]
}

/**
 * Account/positions/orders/history share this envelope. `status: "error"`
 * with a human-readable `error` is the normal unconfigured state (for example
 * "No TWS / IB Gateway socket is listening at 127.0.0.1:7497"), not a crash.
 */
export interface VibeBrokerResult {
  status: 'ok' | 'error'
  error?: string
  [key: string]: unknown
}

export interface VibeJournalUpload {
  status: string
  /** Path on the sidecar's filesystem — feed to vibeShadowExtract. */
  file_path: string
  filename: string
}

/**
 * Shadow tools share vibe's loose envelope: `status: "ok" | "error"` plus
 * tool-specific keys (shadow_id, rules, signals, report sections…).
 */
export interface VibeShadowResult {
  status: 'ok' | 'error'
  error?: string
  shadow_id?: string
  [key: string]: unknown
}

// ── Scheduled tasks ──────────────────────────────────────────────────────────

export type TaskKind = 'macro_refresh' | 'data_refresh' | 'run_strategy' | 'outlook_report'

export type TaskOutputKind = 'macro_job' | 'ingest_job' | 'run' | 'outlook_report'

export interface MacroOutputSummary {
  kind: 'macro_job'
  status: 'done' | 'error' | string
  error: string | null
  calendar_rows: number | null
  indicator_rows: number | null
  indicators: Record<string, number> | null
  warnings_count: number
}

export interface IngestOutputSummary {
  kind: 'ingest_job'
  status: 'done' | 'error' | string
  error: string | null
  restart_required: boolean
  symbols_requested: number | null
  symbols_written: number | null
  symbols_failed: number | null
  failed_sample: string[]
  universe: string | null
  start: string | null
  end: string | null
  non_trading_days_pruned: number | null
}

export interface RunOutputSummary {
  kind: 'run'
  status: 'succeeded' | 'failed' | 'cancelled' | string
  error: string | null
  name: string | null
  model: string | null
  handler: string | null
  universe: string | null
  benchmark: string | null
  annual_return: number | null
  max_drawdown: number | null
  information_ratio: number | null
  volatility: number | null
  period_start: string | null
  period_end: string | null
}

export interface OutlookOutputSummary {
  kind: 'outlook_report'
  status: 'ok' | 'error' | string
  scope: 'day' | 'week' | 'month'
  date: string
  start: string | null
  end: string | null
  pages: number
  file_size: number
  title: string | null
}

export type TaskOutputSummary = MacroOutputSummary | IngestOutputSummary | RunOutputSummary | OutlookOutputSummary

export type TaskFrequency = 'daily' | 'weekdays' | 'weekly'

export type WeekDay = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'

export interface Schedule {
  frequency: TaskFrequency
  time: string
  day?: WeekDay
}

export interface ScheduledTaskInput {
  name: string
  kind: TaskKind
  schedule: Schedule
  params: Record<string, unknown>
  enabled?: boolean
}

export interface ScheduledTask {
  id: string
  org_id: string
  user_id: string
  visibility: 'private' | 'org'
  name: string
  kind: TaskKind
  enabled: boolean
  schedule: Schedule
  params: Record<string, unknown>
  next_run: string | null
  last_run: string | null
  last_status: 'ok' | 'skipped' | 'error' | null
  last_error: string | null
  last_output_id: string | null
  last_output_kind: TaskOutputKind | null
  last_output_summary: TaskOutputSummary | null
  created_at: string
  updated_at: string
  cadence: string
  /** Demo rows are not persisted; the UI hides destructive actions on them. */
  is_demo?: boolean
}

// ── Keycard workflow builder ───────────────────────────────────────────────

export type KeycardPortType = 'data' | 'features' | 'signal' | 'trades' | 'config' | 'trigger' | 'trade' | 'value'
export type KeycardPortDirection = 'in' | 'out'

export interface KeycardPort {
  id: string
  label: string
  type: KeycardPortType
  direction: KeycardPortDirection
  required: boolean
  multiple?: boolean
}

export interface KeycardNodeTypeMeta {
  id: string
  category: string
  label: string
  icon: string | null
  description: string
  ports: KeycardPort[]
  config_schema: Record<string, unknown>
}

export interface KeycardNodeCategory {
  id: string
  label: string
  items: KeycardNodeTypeMeta[]
}

export interface KeycardNode {
  id: string
  type: string
  position: { x: number; y: number }
  config: Record<string, unknown>
  notes: string
}

export interface KeycardEdge {
  id: string
  source: string
  source_port: string
  target: string
  target_port: string
}

export interface KeycardWindows {
  train_start: string
  train_end: string
  valid_start: string
  valid_end: string
  test_start: string
  test_end: string
}

export interface KeycardDefect {
  code: string
  message: string
  path: string
  severity: 'blocking' | 'advisory'
}

export interface KeycardSpec {
  name: string
  description: string
  tags: string[]
  is_template: boolean
  template_family: string | null
  nodes: KeycardNode[]
  edges: KeycardEdge[]
  windows: KeycardWindows
}

export interface Keycard extends KeycardSpec {
  id: string
  created_at: string
  updated_at: string
  user_id: string
  visibility: string
}

export interface KeycardCompileResult {
  yaml: string | null
  defects: KeycardDefect[]
  warnings: string[]
}

export interface KeycardImportResult {
  spec: KeycardSpec
  unknown_fields: string[]
  rejected: { path: string; message: string; value: unknown }[]
  defects: KeycardDefect[]
}

export interface KeycardListFilters extends Record<string, string | boolean | undefined> {
  is_template?: boolean
  family?: string
  tag?: string
}

export const DEFAULT_KEYCARD_WINDOWS: KeycardWindows = {
  train_start: '2010-01-04',
  train_end: '2019-12-31',
  valid_start: '2020-01-01',
  valid_end: '2021-12-31',
  test_start: '2022-01-01',
  test_end: '2026-08-07',
}

export function defaultKeycardSpec(name = 'New keycard'): KeycardSpec {
  return {
    name,
    description: '',
    tags: [],
    is_template: false,
    template_family: null,
    windows: { ...DEFAULT_KEYCARD_WINDOWS },
    nodes: [
      { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {}, notes: '' },
    ],
    edges: [],
  }
}
