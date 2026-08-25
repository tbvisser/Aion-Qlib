import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Check,
  ChevronRight,
  ExternalLink,
  FileUp,
  Loader2,
  Lock,
  RotateCcw,
  ScanLine,
  Terminal,
  TrendingUp,
} from 'lucide-react'

import { PageHeader } from '@/components/layout/PageHeader'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { MicroLabel } from '@/components/ui/micro-label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Notice } from '@/components/ui/notice'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useShadowAccounts } from '@/hooks/useShadowAccounts'
import { api, type VibeShadowResult } from '@/lib/api'
import { cn } from '@/lib/utils'

const ACCEPT = '.csv,.xls,.xlsx'
const ACCEPTED_TYPES = new Set(['text/csv', 'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'])

// ── Helpers ──────────────────────────────────────────────────────────────────

function fileIsAccepted(f: File) {
  return ACCEPTED_TYPES.has(f.type) || /\.(csv|xls|xlsx)$/i.test(f.name)
}

/** Walk VibeShadowResult for the first array that looks like row data. */
function findRowArray(result: VibeShadowResult): unknown[] | null {
  const candidates = ['markets', 'results', 'per_market', 'breakdown', 'rows'] as const
  for (const key of candidates) {
    const v = result[key]
    if (Array.isArray(v) && v.length > 0) return v
  }
  return null
}

/** Walk VibeShadowResult for signals/matches. */
function findSignalArray(result: VibeShadowResult): unknown[] | null {
  const candidates = ['signals', 'matches', 'symbols', 'hits'] as const
  for (const key of candidates) {
    const v = result[key]
    if (Array.isArray(v)) return v
  }
  return null
}

function toStr(v: unknown): string {
  if (v == null) return '—'
  if (typeof v === 'number') return v.toFixed(Math.abs(v) < 10 ? 3 : 2)
  return String(v)
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StepBadge({
  n,
  status,
}: {
  n: number
  status: 'done' | 'active' | 'locked'
}) {
  return (
    <span
      className={cn(
        'flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-label font-mono transition-colors',
        status === 'done'
          ? 'border-primary bg-primary text-primary-foreground'
          : status === 'active'
            ? 'border-primary bg-primary/10 text-primary'
            : 'border-border/30 bg-transparent text-border/40',
      )}
    >
      {status === 'done' ? <Check className="h-3 w-3" /> : n}
    </span>
  )
}

/** Stepper section wrapper. Locked sections show only a one-line hint. */
function StepSection({
  n,
  title,
  status,
  lockMessage,
  children,
}: {
  n: number
  title: string
  status: 'done' | 'active' | 'locked'
  lockMessage?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex gap-4">
      <div className="flex flex-col items-center">
        <StepBadge n={n} status={status} />
        {/* connector line — hidden for last step */}
        <div className="mt-2 flex-1 border-l border-dashed border-border/25" />
      </div>

      <div className={cn('min-w-0 flex-1 pb-8', status === 'locked' && 'pointer-events-none opacity-40')}>
        <div className="flex items-center gap-2 pb-3">
          <h2 className="text-sm font-medium leading-none">{title}</h2>
          {status === 'locked' && <Lock className="h-3 w-3 text-border/40" />}
        </div>
        {status === 'locked' && lockMessage ? (
          <p className="text-xs text-muted-foreground">{lockMessage}</p>
        ) : (
          children
        )}
      </div>
    </div>
  )
}

/** Drag-and-drop upload zone. */
function DropZone({
  onFile,
  busy,
}: {
  onFile: (f: File) => void
  busy: boolean
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  const handleFiles = useCallback(
    (files: FileList | null) => {
      if (!files) return
      const f = files[0]
      if (f && fileIsAccepted(f)) onFile(f)
    },
    [onFile],
  )

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label="Upload trade journal — drag a file here or click to browse"
      className={cn(
        'flex min-h-[140px] cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30',
        dragging
          ? 'border-primary/60 bg-primary/5'
          : 'border-border/40 bg-muted/20 hover:border-border/60 hover:bg-muted/30',
        busy && 'pointer-events-none opacity-60',
      )}
      onClick={() => inputRef.current?.click()}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click() }}
      onDragEnter={(e) => { e.preventDefault(); setDragging(true) }}
      onDragLeave={(e) => { e.preventDefault(); setDragging(false) }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        handleFiles(e.dataTransfer.files)
      }}
    >
      {busy ? (
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      ) : (
        <FileUp
          className={cn(
            'h-6 w-6 transition-colors',
            dragging ? 'text-primary' : 'text-muted-foreground/50',
          )}
        />
      )}
      <div className="text-center">
        <p className="text-sm text-muted-foreground">
          {busy ? 'Uploading…' : 'Drop your broker trade journal here'}
        </p>
        <p className="mt-0.5 font-mono text-micro uppercase tracking-wider text-muted-foreground/50">
          CSV · XLS · XLSX
        </p>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        className="sr-only"
        onChange={(e) => handleFiles(e.target.files)}
      />
    </div>
  )
}

/** Render a single shadow rule. Rules can be a string or a loose object. */
function RuleCard({ rule, index }: { rule: unknown; index: number }) {
  if (typeof rule === 'string') {
    return (
      <div className="rounded-lg border border-border/40 bg-muted/20 px-4 py-3">
        <MicroLabel className="mr-2">
          rule {index + 1}
        </MicroLabel>
        <p className="mt-1 font-mono text-xs leading-relaxed text-foreground/90">{rule}</p>
      </div>
    )
  }
  if (rule && typeof rule === 'object') {
    const obj = rule as Record<string, unknown>
    // Prefer if/then shape; fall back to all keys
    const ifClause = obj['if'] ?? obj['condition'] ?? obj['entry'] ?? null
    const thenClause = obj['then'] ?? obj['action'] ?? obj['signal'] ?? null
    if (ifClause !== null || thenClause !== null) {
      return (
        <div className="rounded-lg border border-border/40 bg-muted/20 px-4 py-3 font-mono text-xs leading-relaxed">
          <MicroLabel className="mr-2">
            rule {index + 1}
          </MicroLabel>
          <div className="mt-1.5 space-y-1">
            {ifClause !== null && (
              <div>
                <span className="text-primary/70">IF</span>{' '}
                <span className="text-foreground/90">{String(ifClause)}</span>
              </div>
            )}
            {thenClause !== null && (
              <div>
                <span className="text-primary/70">THEN</span>{' '}
                <span className="text-foreground/90">{String(thenClause)}</span>
              </div>
            )}
          </div>
        </div>
      )
    }
    // Fallback: key-value pairs
    return (
      <div className="rounded-lg border border-border/40 bg-muted/20 px-4 py-3">
        <MicroLabel>
          rule {index + 1}
        </MicroLabel>
        <dl className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1 font-mono text-label">
          {Object.entries(obj).map(([k, v]) => (
            <div key={k}>
              <dt className="text-muted-foreground/70">{k}</dt>
              <dd className="text-foreground/90">{toStr(v)}</dd>
            </div>
          ))}
        </dl>
      </div>
    )
  }
  return null
}

/** Defensive backtest results table — handles the loose VibeShadowResult shape. */
function BacktestResults({ result }: { result: VibeShadowResult }) {
  if (result.status === 'error') {
    return (
      <Notice tone="clay">
        <p>{result.error ?? 'The backtest returned an error.'}</p>
      </Notice>
    )
  }

  const rows = findRowArray(result)

  if (!rows) {
    // Show top-level scalar fields
    const scalars = Object.entries(result).filter(
      ([k, v]) => k !== 'status' && v !== null && v !== undefined && typeof v !== 'object',
    )
    if (scalars.length === 0) {
      return (
        <p className="font-mono text-xs text-muted-foreground">
          Backtest complete — no breakdown available in this result.
        </p>
      )
    }
    return (
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 font-mono text-xs sm:grid-cols-3">
        {scalars.map(([k, v]) => (
          <div key={k}>
            <dt className="text-micro uppercase tracking-wider text-muted-foreground">{k}</dt>
            <dd className={cn(typeof v === 'number' && v < 0 ? 'text-clay' : '')}>{toStr(v)}</dd>
          </div>
        ))}
      </dl>
    )
  }

  const firstRow = rows[0] as Record<string, unknown>
  const keys = Object.keys(firstRow)

  return (
    <Table className="font-mono text-xs">
      <TableHead>
        <tr>
          {keys.map((k) => (
            <TableHeader key={k} className="py-1.5 pr-5 first:pl-0">
              {k}
            </TableHeader>
          ))}
        </tr>
      </TableHead>
      <TableBody>
        {rows.map((row, i) => {
          const r = row as Record<string, unknown>
          return (
            <TableRow key={i}>
              {keys.map((k) => {
                const v = r[k]
                const isNeg = typeof v === 'number' && v < 0
                return (
                  <TableCell key={k} className={cn('py-1.5 pr-5 first:pl-0', isNeg && 'text-clay')}>
                    {toStr(v)}
                  </TableCell>
                )
              })}
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}

/** Defensive scan results list. */
function ScanResults({ result }: { result: VibeShadowResult }) {
  if (result.status === 'error') {
    return (
      <Notice tone="clay">
        <p>{result.error ?? 'The scan returned an error.'}</p>
      </Notice>
    )
  }

  const items = findSignalArray(result)

  if (!items || items.length === 0) {
    return (
      <p className="font-mono text-xs text-muted-foreground">
        No symbols matched the entry cadence for this scan date.
      </p>
    )
  }

  return (
    <ul className="space-y-1.5">
      {items.map((item, i) => {
        if (typeof item === 'string') {
          return (
            <li key={i} className="flex items-center gap-2 font-mono text-xs">
              <ChevronRight className="h-3 w-3 shrink-0 text-primary/60" />
              {item}
            </li>
          )
        }
        if (item && typeof item === 'object') {
          const obj = item as Record<string, unknown>
          const symbol = String(obj['symbol'] ?? obj['ticker'] ?? `item-${i}`)
          const name = obj['name'] as string | undefined
          const reason = (obj['reason'] ?? obj['match'] ?? obj['signal']) as string | undefined
          const score = obj['score'] as number | undefined
          return (
            <li
              key={i}
              className="flex items-start gap-2 border-b border-border/20 py-1.5 last:border-0"
            >
              <ChevronRight className="mt-0.5 h-3 w-3 shrink-0 text-primary/60" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs font-medium">{symbol}</span>
                  {name && (
                    <span className="truncate text-label text-muted-foreground">{name}</span>
                  )}
                  {score != null && (
                    <Badge variant="primary" className="ml-auto shrink-0">
                      {score.toFixed(2)}
                    </Badge>
                  )}
                </div>
                {reason && (
                  <p className="mt-0.5 font-mono text-micro text-muted-foreground">{reason}</p>
                )}
              </div>
            </li>
          )
        }
        return null
      })}
    </ul>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function ShadowAccountsPage() {
  const {
    upload, analyze, extract, backtest, scan, render, reset,
    journalPath, filename, shadowId, rules,
    backtestResult, scanResult, reportUrl,
    busy, error,
  } = useShadowAccounts()

  const [health, setHealth] = useState<'ok' | 'unreachable' | null>(null)

  // Extract controls
  const [minSupport, setMinSupport] = useState('')
  const [maxRules, setMaxRules] = useState('')

  // Backtest controls
  const [windowStart, setWindowStart] = useState('')
  const [windowEnd, setWindowEnd] = useState('')
  const [markets, setMarkets] = useState('')

  // Scan controls
  const [scanDate, setScanDate] = useState('')

  // Auto-analyze once per unique journalPath (no UI step needed).
  const analyzedPathRef = useRef<string | null>(null)
  useEffect(() => {
    if (!journalPath || journalPath === analyzedPathRef.current || busy) return
    analyzedPathRef.current = journalPath
    void analyze()
  }, [journalPath, busy, analyze])

  // Vibe sidecar health check on mount.
  useEffect(() => {
    void api.vibeHealth().then((h) => setHealth(h.status)).catch(() => setHealth('unreachable'))
  }, [])

  // Derive stage gating from hook state.
  const stage2locked = !journalPath
  const stage3locked = !shadowId
  const stage4locked = !shadowId

  // Visual status for step badge.
  const s1status = journalPath ? 'done' : 'active'
  const s2status = shadowId ? 'done' : !stage2locked ? 'active' : 'locked'
  const s3status = backtestResult || scanResult ? 'done' : !stage3locked ? 'active' : 'locked'
  const s4status = reportUrl ? 'done' : !stage4locked ? 'active' : 'locked'

  const handleExtract = () => {
    void extract({
      min_support: minSupport ? Number(minSupport) : undefined,
      max_rules: maxRules ? Number(maxRules) : undefined,
    })
  }

  const handleBacktest = () => {
    const marketList = markets
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean)
    void backtest({
      window_start: windowStart || undefined,
      window_end: windowEnd || undefined,
      markets: marketList.length > 0 ? marketList : undefined,
    })
  }

  const handleScan = () => {
    void scan({ date: scanDate || undefined })
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Shadow Accounts"
        description="Journal-driven strategy mimicry — mine your past trades into a rule set, then scan forward."
        actions={
          (journalPath || shadowId) ? (
            <Button variant="ghost" size="sm" onClick={reset}>
              <RotateCcw className="mr-1 h-3.5 w-3.5" />
              Reset profile
            </Button>
          ) : undefined
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto max-w-3xl space-y-5">

          {/* Intro */}
          <p className="text-sm text-muted-foreground">
            A shadow account mirrors your actual trading style without risking capital. Upload a
            broker trade-journal export and the sidecar mines your profitable roundtrips into
            3–5 human-readable if-then rules. You can then back-test that rule set across
            historical windows, scan today's market for entry matches, and render a full
            annotated report — all paper-only. Divergence between what the rules say and what
            you actually traded is where the learning lives.
          </p>

          {/* Offline notice */}
          {health === 'unreachable' && (
            <Notice tone="clay">
              <p className="font-medium">Vibe sidecar offline</p>
              <p className="mt-1 font-mono text-label">
                infra\stack.ps1 up
              </p>
            </Notice>
          )}

          {/* Error notice — rendered at page level so it's always visible */}
          {error && (
            <Notice tone="destructive">
              <p>{error}</p>
            </Notice>
          )}

          {/* Stepper */}
          <div className="relative">
            {/* ① Upload journal ─────────────────────────────────────── */}
            <StepSection n={1} title="Upload journal" status={s1status}>
              {journalPath ? (
                <div className="space-y-3">
                  <div className="flex items-start gap-3 rounded-lg border border-border/40 bg-muted/20 p-3">
                    <Terminal className="mt-0.5 h-4 w-4 shrink-0 text-primary/70" />
                    <div className="min-w-0">
                      <p className="truncate text-xs font-medium">
                        {filename ?? journalPath.split('/').pop() ?? journalPath}
                      </p>
                      <p className="mt-0.5 truncate font-mono text-micro text-muted-foreground">
                        {journalPath}
                      </p>
                      {busy === 'analyze' && (
                        <p className="mt-1 flex items-center gap-1.5 font-mono text-micro text-muted-foreground">
                          <Loader2 className="h-3 w-3 animate-spin" />
                          Analyzing journal…
                        </p>
                      )}
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-xs"
                    onClick={() => {
                      // Let user replace with a different file
                      const input = document.createElement('input')
                      input.type = 'file'
                      input.accept = ACCEPT
                      input.onchange = () => {
                        const f = input.files?.[0]
                        if (f && fileIsAccepted(f)) void upload(f)
                      }
                      input.click()
                    }}
                  >
                    Replace file
                  </Button>
                </div>
              ) : (
                <DropZone onFile={(f) => void upload(f)} busy={busy === 'upload'} />
              )}
            </StepSection>

            {/* ② Extracted rules ─────────────────────────────────────── */}
            <StepSection
              n={2}
              title="Extracted rules"
              status={s2status}
              lockMessage="Upload a journal file to unlock this step."
            >
              <div className="space-y-4">
                {/* Controls row */}
                <div className="flex flex-wrap items-end gap-3">
                  <div className="space-y-1">
                    <Label className="font-mono text-micro uppercase tracking-wider text-muted-foreground">
                      Min support
                    </Label>
                    <Input
                      type="number"
                      placeholder="0.05"
                      value={minSupport}
                      onChange={(e) => setMinSupport(e.target.value)}
                      className="h-8 w-24 font-mono text-xs"
                      min={0}
                      max={1}
                      step={0.01}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="font-mono text-micro uppercase tracking-wider text-muted-foreground">
                      Max rules
                    </Label>
                    <Input
                      type="number"
                      placeholder="5"
                      value={maxRules}
                      onChange={(e) => setMaxRules(e.target.value)}
                      className="h-8 w-20 font-mono text-xs"
                      min={1}
                      max={20}
                    />
                  </div>
                  <Button
                    size="sm"
                    onClick={handleExtract}
                    disabled={busy === 'extract' || !journalPath}
                    className="mb-0"
                  >
                    {busy === 'extract' ? (
                      <>
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                        Extracting…
                      </>
                    ) : (
                      'Extract rules'
                    )}
                  </Button>
                  {busy === 'extract' && (
                    <p className="self-end font-mono text-micro text-muted-foreground">
                      this can take a minute
                    </p>
                  )}
                </div>

                {/* Shadow ID chip */}
                {shadowId && (
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="font-mono">
                      shadow {shadowId}
                    </Badge>
                    <span className="font-mono text-micro text-muted-foreground">
                      profile saved · refresh-safe
                    </span>
                  </div>
                )}

                {/* Rules cards */}
                {rules.length > 0 ? (
                  <div className="space-y-2">
                    {rules.map((rule, i) => (
                      <RuleCard key={i} rule={rule} index={i} />
                    ))}
                  </div>
                ) : shadowId ? (
                  <p className="font-mono text-xs text-muted-foreground">
                    No rules in result — try lowering min support or re-extracting.
                  </p>
                ) : null}
              </div>
            </StepSection>

            {/* ③ Forward tracking ─────────────────────────────────────── */}
            <StepSection
              n={3}
              title="Forward tracking"
              status={s3status}
              lockMessage="Extract a shadow profile to unlock back-testing and scanning."
            >
              <div className="space-y-6">
                {/* Backtest sub-section */}
                <Card>
                  <CardHeader className="pb-3 pt-4">
                    <CardTitle className="flex items-center gap-1.5 text-sm font-medium">
                      <TrendingUp className="h-3.5 w-3.5 text-muted-foreground" />
                      Backtest
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="flex flex-wrap items-end gap-3">
                      <div className="space-y-1">
                        <Label className="font-mono text-micro uppercase tracking-wider text-muted-foreground">
                          Window start
                        </Label>
                        <Input
                          type="date"
                          value={windowStart}
                          onChange={(e) => setWindowStart(e.target.value)}
                          className="h-8 w-36 font-mono text-xs"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="font-mono text-micro uppercase tracking-wider text-muted-foreground">
                          Window end
                        </Label>
                        <Input
                          type="date"
                          value={windowEnd}
                          onChange={(e) => setWindowEnd(e.target.value)}
                          className="h-8 w-36 font-mono text-xs"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="font-mono text-micro uppercase tracking-wider text-muted-foreground">
                          Markets (comma-sep)
                        </Label>
                        <Input
                          type="text"
                          placeholder="US, EU, HK"
                          value={markets}
                          onChange={(e) => setMarkets(e.target.value)}
                          className="h-8 w-40 font-mono text-xs"
                        />
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={handleBacktest}
                        disabled={busy === 'backtest' || !shadowId}
                      >
                        {busy === 'backtest' ? (
                          <>
                            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                            Running…
                          </>
                        ) : (
                          'Run backtest'
                        )}
                      </Button>
                      {busy === 'backtest' && (
                        <p className="self-end font-mono text-micro text-muted-foreground">
                          this can take a minute
                        </p>
                      )}
                    </div>
                    {backtestResult && <BacktestResults result={backtestResult} />}
                  </CardContent>
                </Card>

                {/* Scan sub-section */}
                <Card>
                  <CardHeader className="pb-3 pt-4">
                    <CardTitle className="flex items-center gap-1.5 text-sm font-medium">
                      <ScanLine className="h-3.5 w-3.5 text-muted-foreground" />
                      Scan today
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="flex flex-wrap items-end gap-3">
                      <div className="space-y-1">
                        <Label className="font-mono text-micro uppercase tracking-wider text-muted-foreground">
                          Scan date (default: today)
                        </Label>
                        <Input
                          type="date"
                          value={scanDate}
                          onChange={(e) => setScanDate(e.target.value)}
                          className="h-8 w-36 font-mono text-xs"
                        />
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={handleScan}
                        disabled={busy === 'scan' || !shadowId}
                      >
                        {busy === 'scan' ? (
                          <>
                            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                            Scanning…
                          </>
                        ) : (
                          'Scan market'
                        )}
                      </Button>
                    </div>
                    {scanResult && <ScanResults result={scanResult} />}
                    <p className="font-mono text-micro text-muted-foreground/70">
                      Research only — not a trade recommendation.
                    </p>
                  </CardContent>
                </Card>
              </div>
            </StepSection>

            {/* ④ Report ───────────────────────────────────────────────── */}
            <StepSection
              n={4}
              title="Report"
              status={s4status}
              lockMessage="Extract a shadow profile to unlock the report renderer."
            >
              <div className="space-y-4">
                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    onClick={() => void render()}
                    disabled={busy === 'render' || !shadowId}
                  >
                    {busy === 'render' ? (
                      <>
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                        Rendering report…
                      </>
                    ) : reportUrl ? (
                      'Re-render report'
                    ) : (
                      'Render report'
                    )}
                  </Button>
                  {busy === 'render' && (
                    <p className="font-mono text-micro text-muted-foreground">
                      this can take a minute
                    </p>
                  )}
                  {reportUrl && (
                    <a
                      href={reportUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 font-mono text-xs text-primary hover:underline"
                    >
                      Open in new tab <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                </div>

                {reportUrl && (
                  <div className="overflow-hidden rounded-xl border border-border/50">
                    <iframe
                      src={reportUrl}
                      title="Shadow account report"
                      className="h-[640px] w-full bg-white"
                      sandbox="allow-scripts allow-same-origin"
                    />
                  </div>
                )}
              </div>
            </StepSection>
          </div>
        </div>
      </div>
    </div>
  )
}
