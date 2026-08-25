import { useEffect, useState } from 'react'
import { ArrowUpRight, Play, X } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { MicroLabel } from '@/components/ui/micro-label'
import { Notice } from '@/components/ui/notice'
import { Segmented } from '@/components/ui/segmented'
import { IcChart, IcMetrics } from '@/components/factors/IcResult'
import { HORIZONS, icVerdict } from '@/components/factors/icVerdict'
import {
  api, type CatalogEntityDetail, type FactorEvaluation, type VibeAlphaDetail,
} from '@/lib/api'
import { familyLabel, parseUid, sourceLabel } from '@/lib/catalog'
import { useHealth } from '@/hooks/useHealth'
import { SourceBadge } from './CatalogBrowser'

/**
 * One alpha, opened from the table.
 *
 * The measurement half is the existing Databank evaluator, unchanged in
 * substance — same `POST /api/factors/evaluate`, same `icVerdict` thresholds,
 * same tiles and chart. What is new is that it now sits beside the row it is
 * measuring, so "what is this factor" and "does it predict anything" are one
 * gesture rather than a page and a copy-paste.
 *
 * The links section is the part that did not exist anywhere. A curated factor
 * carries the zoo id it was adapted from in its caveat prose, and a strategy
 * copies expressions inline rather than referencing them — so "which strategies
 * use this" and "where did this come from" were unanswerable. Both are edges in
 * the catalog now, and both render here even when the other end is not in the
 * index: a document lives in Supabase and will never be harvested, and a link to
 * it must still show.
 */
export function AlphaDetail({ uid, onClose }: { uid: string; onClose: () => void }) {
  const { health } = useHealth(0)
  const [entity, setEntity] = useState<CatalogEntityDetail | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [horizon, setHorizon] = useState(5)
  const [start, setStart] = useState('2022-01-01')
  const [result, setResult] = useState<FactorEvaluation | null>(null)
  const [running, setRunning] = useState(false)
  const [evalError, setEvalError] = useState<string | null>(null)

  const universe = health?.qlib.universes?.includes('top500') ? 'top500' : 'all'

  useEffect(() => {
    let cancelled = false
    setEntity(null)
    setLoadError(null)
    // A new alpha's measurement is not this alpha's. Clearing rather than
    // leaving the previous result on screen: an IC labelled with the wrong
    // factor is a claim, not a stale view.
    setResult(null)
    setEvalError(null)
    api.catalogEntity(uid)
      .then((r) => { if (!cancelled) setEntity(r) })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : 'Could not load')
      })
    return () => { cancelled = true }
  }, [uid])

  const evaluate = async () => {
    if (!entity?.expression) return
    setRunning(true)
    setEvalError(null)
    try {
      setResult(await api.evaluateFactor({
        expression: entity.expression, universe, start, horizon,
      }))
    } catch (e) {
      setEvalError(e instanceof Error ? e.message : 'Evaluation failed')
      setResult(null)
    } finally {
      setRunning(false)
    }
  }

  if (loadError) {
    return (
      <aside className="w-[420px] shrink-0 overflow-y-auto border-l border-border/50 p-4">
        <Notice tone="destructive">{loadError}</Notice>
      </aside>
    )
  }

  if (!entity) {
    return (
      <aside className="w-[420px] shrink-0 border-l border-border/50 p-4 text-caption text-muted-foreground">
        Loading…
      </aside>
    )
  }

  const payload = entity.payload as Record<string, unknown>
  const caveat = typeof payload.caveat === 'string' ? payload.caveat : null
  const about = typeof payload.about === 'string' ? payload.about : null
  const derivedFrom = typeof payload.derived_from === 'string' ? payload.derived_from : null
  const backDays = typeof payload.back_days === 'number' ? payload.back_days : null
  const fields = Array.isArray(payload.fields) ? (payload.fields as string[]) : []
  const verdict = result ? icVerdict(result) : null
  const runsOnVibe = payload.runs_on === 'vibe'

  return (
    <aside className="flex w-[420px] shrink-0 flex-col overflow-y-auto border-l border-border/50">
      <div className="flex items-start justify-between gap-2 border-b border-border/50 p-4">
        <div className="min-w-0">
          <div className="truncate text-sm">{entity.name}</div>
          <div className="mt-1 flex flex-wrap items-center gap-1">
            <SourceBadge source={entity.source} />
            <Badge variant="outline" font="sans" className="font-normal">{familyLabel(entity)}</Badge>
            {entity.tags.slice(0, 4).map((tag) => (
              <Badge key={tag} font="sans" className="font-normal">{tag}</Badge>
            ))}
          </div>
        </div>
        <Button variant="ghost" size="sm" className="h-6 w-6 shrink-0 p-0" onClick={onClose}>
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="space-y-4 p-4">
        {entity.summary && <p className="text-caption text-muted-foreground">{entity.summary}</p>}
        {about && <p className="text-caption text-muted-foreground">{about}</p>}

        {entity.expression && (
          <div className="space-y-1">
            <MicroLabel as="div">
              Expression
            </MicroLabel>
            <code className="block break-all rounded border border-border/50 p-2 font-sans text-label">
              {entity.expression}
            </code>
          </div>
        )}

        <dl className="grid grid-cols-2 gap-2 text-label">
          {fields.length > 0 && (
            <div>
              <MicroLabel as="dt">
                Reads
              </MicroLabel>
              <dd>{fields.map((f) => `$${f}`).join(', ')}</dd>
            </div>
          )}
          {backDays != null && (
            <div>
              <MicroLabel as="dt">
                Warm-up
              </MicroLabel>
              {/* The number that separates two factors nothing else does:
                  qlib's rolling uses min_periods=1, so a 60-day std returns a
                  confident value from two observations. */}
              <dd>{backDays} trading days</dd>
            </div>
          )}
        </dl>

        {caveat && <Notice tone="clay" className="text-label">{caveat}</Notice>}

        {derivedFrom && (
          <div className="text-label text-muted-foreground">
            Adapted from{' '}
            <span>{parseUid(derivedFrom)?.localId ?? derivedFrom}</span>
            {' in the '}{sourceLabel(parseUid(derivedFrom)?.source ?? 'vibe')}.
          </div>
        )}

        {runsOnVibe && <VibeSource alphaId={entity.local_id} payload={payload} />}

        <Links entity={entity} />

        {entity.expression && (
          <div className="space-y-3 border-t border-border/50 pt-4">
            <MicroLabel as="div">
              Measure it
            </MicroLabel>
            <div className="flex flex-wrap items-end gap-2">
              <label className="space-y-1">
                <MicroLabel className="block">
                  From
                </MicroLabel>
                <input
                  type="date"
                  value={start}
                  onChange={(e) => setStart(e.target.value)}
                  className="h-7 rounded border border-border/50 bg-background px-2 text-label"
                />
              </label>
              <Segmented
                size="sm"
                value={String(horizon)}
                options={HORIZONS.map((h) => ({ value: String(h), label: `${h}d` }))}
                onChange={(v) => setHorizon(Number(v))}
              />
              <Button size="sm" className="h-7" disabled={running} onClick={evaluate}>
                <Play className="mr-1 h-3 w-3" />
                {running ? 'Measuring…' : 'Evaluate'}
              </Button>
            </div>
            <p className="text-micro text-muted-foreground/70">
              Cross-sectional IC against {horizon}-day forward returns on {universe}.
            </p>

            {evalError && <Notice tone="destructive">{evalError}</Notice>}
            {result && (
              <div className="space-y-3">
                <IcMetrics result={result} compact font="sans" />
                {verdict && <p className="text-label text-muted-foreground">{verdict}</p>}
                <IcChart result={result} height={140} font="sans" />
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  )
}

/**
 * A zoo alpha's formula and source, fetched from the sidecar on open.
 *
 * Not indexed with the row: `GET /alpha/list` gives 462 alphas in one request
 * and the per-alpha endpoint adds the formula, the notes and ~3 KB of Python.
 * Harvesting that for all of them would turn a three-second reindex into a
 * minute of round-trips, so the cost is paid here, for the one alpha you opened.
 *
 * Degrades to nothing on failure. The sidecar being down is why the whole
 * collection can be stale, and the row above still says everything the index
 * knows — a red box over a working row would be the wrong emphasis.
 */
function VibeSource({
  alphaId, payload,
}: {
  alphaId: string
  payload: Record<string, unknown>
}) {
  const [detail, setDetail] = useState<VibeAlphaDetail | null>(null)
  const [showSource, setShowSource] = useState(false)

  useEffect(() => {
    let cancelled = false
    setDetail(null)
    setShowSource(false)
    api.vibeAlphaSource(alphaId)
      .then((r) => { if (!cancelled) setDetail(r) })
      .catch(() => { if (!cancelled) setDetail(null) })
    return () => { cancelled = true }
  }, [alphaId])

  const warmup = typeof payload.min_warmup_bars === 'number' ? payload.min_warmup_bars : null
  const decay = typeof payload.decay_horizon === 'number' ? payload.decay_horizon : null
  const notes = detail?.alpha?.meta?.notes

  return (
    <div className="space-y-2 border-t border-border/50 pt-4">
      <MicroLabel as="div">
        From the zoo
      </MicroLabel>
      {/* The sentence that stops someone hunting for an Evaluate button: these
          are pandas functions on a price panel, not qlib expressions, so the
          IC evaluator on this page cannot run them. */}
      <p className="text-label text-muted-foreground">
        This alpha is Python that runs on the Vibe sidecar's own bench, not a qlib
        expression — so it cannot be measured with the evaluator here.
      </p>

      <dl className="grid grid-cols-2 gap-2 text-label">
        {warmup != null && (
          <div>
            <MicroLabel as="dt">
              Warm-up
            </MicroLabel>
            <dd>{warmup} bars</dd>
          </div>
        )}
        {decay != null && (
          <div>
            <MicroLabel as="dt">
              Decay horizon
            </MicroLabel>
            <dd>{decay} days</dd>
          </div>
        )}
      </dl>

      {detail?.alpha?.meta?.formula_latex && (
        <div className="space-y-1">
          <MicroLabel as="div">
            Formula
          </MicroLabel>
          <code className="block break-all rounded border border-border/50 p-2 font-sans text-micro text-muted-foreground">
            {detail.alpha.meta.formula_latex}
          </code>
        </div>
      )}

      {notes && <p className="text-label text-muted-foreground">{notes}</p>}

      {detail?.source_code && (
        <div className="space-y-1">
          <button
            type="button"
            onClick={() => setShowSource((v) => !v)}
            className="text-micro font-medium uppercase tracking-wider text-muted-foreground/70 hover:text-foreground"
          >
            {showSource ? 'Hide source' : 'Show source'}
          </button>
          {showSource && (
            <pre className="max-h-64 overflow-auto rounded border border-border/50 p-2 font-sans text-micro leading-relaxed">
              {detail.source_code}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}

const REL_LABELS: Record<string, string> = {
  strategy_uses_alpha: 'Used by strategy',
  template_uses_alpha: 'Used by template',
  adapted_from: 'Adapted from',
  documented_by: 'Documented by',
  supersedes: 'Supersedes',
  related_to: 'Related to',
}

function Links({ entity }: { entity: CatalogEntityDetail }) {
  const all = [...entity.links.in, ...entity.links.out]
  if (!all.length) return null

  return (
    <div className="space-y-1">
      <MicroLabel as="div">
        Connected
      </MicroLabel>
      {all.map((link) => (
        <div
          key={`${link.rel}:${link.uid}`}
          className="flex items-baseline justify-between gap-2 text-label"
        >
          <span className="truncate">
            {/* Falls back to the raw uid rather than blanking: a link whose
                other end is a Supabase document, or a row a later harvest
                dropped, still has to say what it points at. */}
            {link.title ?? link.name ?? <span>{link.uid}</span>}
          </span>
          <span className="shrink-0 text-micro text-muted-foreground/70">
            {REL_LABELS[link.rel] ?? link.rel}
            <ArrowUpRight className="ml-0.5 inline h-2.5 w-2.5" />
          </span>
        </div>
      ))}
    </div>
  )
}
