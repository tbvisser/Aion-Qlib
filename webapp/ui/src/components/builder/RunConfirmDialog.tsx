/**
 * The last look before four minutes of compute.
 *
 * Four fields, and only four: which market, over which window, against what.
 * Model, handler, topk and costs are the strategy's identity and belong on the
 * canvas; these are the ones that decide whether the run was worth starting,
 * and none of them was visible at the moment of pressing Run.
 *
 * **Edits write back to the spec.** They are not run-only overrides, for three
 * reasons in descending order of force: the Config dialog promises "this exact
 * file is handed to qrun", which a hidden override makes false; `changedSince`
 * answers "what did I change between attempts?" from the metadata recorded at
 * launch, so an override would make a saved strategy disagree with its own best
 * result; and `POST /runs` validates the spec it is given, so an override needs
 * a merge step validated in two places. The write-back marks the strategy dirty
 * and the header dot says so, which is correct and visible.
 */
import { useCallback, useEffect, useState } from 'react'

import { CoverageBanner } from '@/components/builder/CoverageBanner'
import { Choice, DateInput, Field } from '@/components/builder/FormControls'
import { UniversePicker } from '@/components/builder/UniversePicker'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Notice } from '@/components/ui/notice'
import { useUniverseCount } from '@/hooks/useStoreUniverses'
import type {
  DataStore, ModelsResponse, Run, StrategyPreview, StrategySpec,
} from '@/lib/api'
import { applyStore, selectableUniverses } from '@/lib/storeSwitch'
import { isAdvisoryWarning } from '@/lib/strategyGraph/routeWarning'

export interface RunConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The spec as it stands. The dialog edits a draft and commits on Start. */
  spec: StrategySpec
  stores: DataStore[]
  models: ModelsResponse | null
  /** A run already in flight, so the dialog can say this one will queue. */
  activeRun?: Run
  /** Re-validate an edited draft — the same call the page's preview effect makes. */
  onPreview: (spec: StrategySpec) => Promise<StrategyPreview>
  /** Blockers for the unedited spec, so the dialog is honest before its first preview. */
  initialBlockers: string[]
  /** Commit the draft to the page's spec, then launch. */
  onStart: (spec: StrategySpec) => Promise<void>
  busy?: boolean
}

export function RunConfirmDialog({
  open, onOpenChange, spec, stores, models, activeRun,
  onPreview, initialBlockers, onStart, busy,
}: RunConfirmDialogProps) {
  // Seeded on open only. The page runs its own 300ms preview loop against the
  // live spec; re-seeding on every `spec` change would fight the user's typing.
  const [draft, setDraft] = useState(spec)
  const [warnings, setWarnings] = useState(initialBlockers)
  const [preview, setPreview] = useState<StrategyPreview | null>(null)
  const [checking, setChecking] = useState(false)
  /** The preview refusing the draft outright — a 422, a network failure. */
  const [previewError, setPreviewError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setDraft(spec)
    setWarnings(initialBlockers)
    setPreview(null)
    setPreviewError(null)
  }, [open])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setChecking(true)
    const t = setTimeout(() => {
      void onPreview(draft)
        .then((r) => {
          if (cancelled) return
          setPreview(r)
          setWarnings(r.warnings)
          setPreviewError(null)
        })
        // A failed preview must not be silence: the same failure at Start
        // would come back as a page-level error long after the reason was
        // knowable, and stale warnings under an enabled button say "checked,
        // fine" about a draft nobody checked.
        .catch((e) => {
          if (!cancelled) {
            setPreviewError(e instanceof Error ? e.message : 'Could not check this strategy')
          }
        })
        .finally(() => { if (!cancelled) setChecking(false) })
    }, 300)
    return () => { cancelled = true; clearTimeout(t) }
  }, [open, draft, onPreview])

  // The preview's `warnings` carries both severities in one list. Only the
  // blocking tier may hold the Start button — `validate_execution` describes a
  // run that finishes and means nothing, and the canvas already renders it as
  // advisory. Reading the whole list as blockers here disabled Start for every
  // crypto strategy without a limit_threshold, which is exactly the strategy
  // the advisory tier exists to let run.
  const blockers = warnings.filter((w) => !isAdvisoryWarning(w))
  const advisories = warnings.filter(isAdvisoryWarning)

  const store = stores.find((s) => s.key === draft.data_store)
  const count = useUniverseCount(draft.data_store, draft.universe)
  const clamped = preview?.explain?.effective_test_end
  const stopsEarly = clamped && clamped !== draft.test_end

  const patch = useCallback(
    <K extends keyof StrategySpec>(key: K, value: StrategySpec[K]) =>
      setDraft((prev) => ({ ...prev, [key]: value })),
    [],
  )

  const modelLabel = models?.models.find((m) => m.id === draft.model)?.label ?? draft.model

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="run-confirm-dialog">
        <DialogHeader>
          <DialogTitle>Test strategy</DialogTitle>
          <DialogDescription>
            {modelLabel} · {draft.handler} · holding {draft.topk}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <Field label="Store">
            {/* Through `applyStore`, so the universe, benchmark and end date
                follow exactly as they do on the canvas. Duplicating the
                cascade here is how you ship a Start button that sends
                `crypto_365` + `top500` and gets a 400 back. */}
            <Choice
              value={draft.data_store}
              onChange={(v) => setDraft((prev) => applyStore(prev, stores, v))}
              options={stores.map((s) => ({
                value: s.key,
                label: s.exists ? s.label : `${s.label} (not built)`,
              }))}
            />
          </Field>

          <Field
            label="Universe"
            hint={count === null ? undefined : `${count.toLocaleString()} names on this store`}
          >
            <UniversePicker
              value={draft.universe}
              onChange={(universe) => patch('universe', universe)}
              store={draft.data_store}
              universes={selectableUniverses(store)}
            />
          </Field>

          <Field label="Benchmark">
            <Choice
              value={draft.benchmark}
              onChange={(benchmark) => patch('benchmark', benchmark)}
              options={[...new Set([...(store?.benchmarks ?? []), draft.benchmark])]
                .filter(Boolean)
                .map((b) => ({ value: b, label: b }))}
            />
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Test from">
              <DateInput value={draft.test_start} onChange={(v) => patch('test_start', v)} />
            </Field>
            <Field label="Test to">
              <DateInput value={draft.test_end} onChange={(v) => patch('test_end', v)} />
            </Field>
          </div>

          {/* The clamp is applied whether or not anyone is told. Saying it here
              is the difference between a short backtest and a mystery. */}
          {stopsEarly && (
            <p className="text-[11px] leading-relaxed text-clay">
              This store can only be backtested to {clamped}; the run will end there.
            </p>
          )}

          {activeRun && (
            <Notice tone="muted" icon={false}>
              A backtest is already running. This one will queue behind it.
            </Notice>
          )}

          {previewError && (
            <Notice tone="destructive" icon={false}>{previewError}</Notice>
          )}

          {blockers.length > 0 && (
            <Notice tone="clay">
              {blockers.map((w) => <p key={w}>{w}</p>)}
            </Notice>
          )}

          {/* Worth reading, never a reason to hold the launch — the muted tone
              is the same one the stage cards give this tier. */}
          {advisories.length > 0 && (
            <Notice tone="muted" icon={false}>
              {advisories.map((w) => <p key={w}>{w}</p>)}
            </Notice>
          )}

          <CoverageBanner coverage={preview?.coverage} />

          <p className="text-[11px] text-muted-foreground">
            Changes here are saved into the strategy.
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            data-testid="start-backtest"
            disabled={busy || checking || blockers.length > 0 || previewError !== null}
            title={blockers.length ? blockers.join('\n') : undefined}
            onClick={() => void onStart(draft)}
          >
            {busy ? 'Starting…' : 'Start backtest'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
