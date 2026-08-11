/**
 * Somewhere to start from: curated templates, your own saved work, and the
 * seeded starters.
 *
 * These used to be three unrelated surfaces — templates behind a header button
 * that opened a modal, saved strategies in a card only form mode showed, and
 * the demo seed indistinguishable from either. They answer one question ("what
 * do I open?"), so they are one list.
 *
 * A template that cannot run on this machine is shown and disabled with its
 * reasons, never hidden. Same rule the backend already follows in `materialise`
 * and `available_models`: say why something is unavailable rather than quietly
 * offering a shorter list.
 */
import { useEffect, useMemo, useState } from 'react'
import { Check, Trash2, X } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { RailRow, RailSection } from '@/components/ui/rail'
import { useTemplates } from '@/hooks/useTemplates'
import type { StoredStrategy, StrategySpec, TemplateEntry } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * The prefix `scripts/seed_demo.py` writes and `--reset` deletes by.
 *
 * `StoredStrategy` carries no `is_demo` flag, and adding one to the on-disk
 * schema to drive a section header would be a migration in service of a
 * caption. The prefix is already the contract the seeder relies on.
 */
const DEMO_PREFIX = 'demo-'

export function TemplateRail({
  needle, saved, currentId, onUse, onOpenSaved, onDeleteSaved,
}: {
  /** The rail's search box, already trimmed and lowercased. */
  needle: string
  saved: StoredStrategy[]
  currentId?: string
  onUse: (spec: StrategySpec) => void
  onOpenSaved: (strategy: StoredStrategy) => void
  onDeleteSaved: (strategy: StoredStrategy) => void
}) {
  const { data, error, loading } = useTemplates()

  const templates = useMemo(() => {
    if (!data) return []
    const order = new Map(data.families.map((f, i) => [f.key, i]))
    const label = new Map(data.families.map((f) => [f.key, f.label]))
    return data.templates
      .filter((t) => {
        if (!needle) return true
        return [t.title, t.family, t.rationale, ...t.tags].join(' ').toLowerCase()
          .includes(needle)
      })
      // Served family order, not alphabetical: the backend decides which family
      // a beginner should meet first and a second opinion here would fight it.
      .sort((a, b) => (order.get(a.family) ?? 99) - (order.get(b.family) ?? 99))
      .map((t) => ({ ...t, familyLabel: label.get(t.family) ?? t.family }))
  }, [data, needle])

  const { mine, book } = useMemo(() => {
    const hits = saved.filter((s) => !needle
      || `${s.name} ${s.model} ${s.handler} ${s.universe}`.toLowerCase().includes(needle))
    return {
      mine: hits.filter((s) => !s.id.startsWith(DEMO_PREFIX)),
      book: hits.filter((s) => s.id.startsWith(DEMO_PREFIX)),
    }
  }, [saved, needle])

  const nothing = !loading && !error && !templates.length && !mine.length && !book.length

  return (
    <>
      {loading && <p className="px-1 py-6 text-[11px] text-muted-foreground">Loading templates…</p>}
      {error && <p className="px-1 py-2 text-[11px] text-destructive">{error}</p>}

      {templates.length > 0 && (
        <RailSection label="Templates" count={templates.length} open={needle ? true : undefined}>
          {templates.map((t) => (
            <TemplateRow key={t.id} template={t} familyLabel={t.familyLabel} onUse={onUse} />
          ))}
        </RailSection>
      )}

      {mine.length > 0 && (
        <RailSection label="My strategies" count={mine.length} open={needle ? true : undefined}>
          {mine.map((s) => (
            <SavedRow key={s.id} strategy={s} current={s.id === currentId}
                      onOpen={onOpenSaved} onDelete={onDeleteSaved} />
          ))}
        </RailSection>
      )}

      {book.length > 0 && (
        <RailSection label="Fund book" count={book.length} open={needle ? true : undefined}>
          {book.map((s) => (
            <SavedRow
              key={s.id}
              strategy={s}
              current={s.id === currentId}
              onOpen={onOpenSaved}
              onDelete={onDeleteSaved}
              starter
            />
          ))}
        </RailSection>
      )}

      {nothing && (
        <p className="px-2 py-6 text-center text-[11px] text-muted-foreground">
          {needle ? `Nothing matches “${needle}”.` : 'Nothing to start from yet.'}
        </p>
      )}
    </>
  )
}

/**
 * One template.
 *
 * The row is a name and its family; everything that helps you choose — what it
 * is good and bad at, what was filled in for you, why it cannot run here — is
 * in the popover, which opens on click rather than hover so it can be read
 * without keeping the pointer still.
 */
function TemplateRow({ template, familyLabel, onUse }: {
  template: TemplateEntry
  familyLabel: string
  onUse: (spec: StrategySpec) => void
}) {
  const [open, setOpen] = useState(false)
  const dead = !template.runnable

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <div>
          <RailRow
            data-testid={`template-${template.id}`}
            label={template.title}
            badges={
              <Badge variant={dead ? 'clay' : 'muted'} className="shrink-0">
                {familyLabel}
              </Badge>
            }
            onClick={() => setOpen(true)}
            // Not `disabled`: an unrunnable template must still open, because
            // the popover is where its reasons are written down.
          />
        </div>
      </PopoverTrigger>

      <PopoverContent side="right" align="start" className="w-96 p-3">
        <TemplateDetail
          template={template}
          onUse={() => {
            if (!template.spec) return
            onUse(template.spec)
            setOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

export function TemplateDetail({ template, onUse }: {
  template: TemplateEntry
  onUse: () => void
}) {
  return (
    <div className="space-y-3 text-[11px] leading-relaxed">
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1 text-sm font-medium">{template.title}</span>
        {/* The most important click a new user makes, so it is the app's
            actual button rather than a fourth hand-rolled pill. */}
        <Button
          size="sm"
          className="shrink-0"
          disabled={!template.runnable}
          onClick={onUse}
          data-testid={`template-use-${template.id}`}
        >
          Use
        </Button>
      </div>

      {template.tags.length > 0 && (
        <div className="font-mono text-[10px] text-muted-foreground/70">
          {template.tags.join(' · ')}
        </div>
      )}

      <p className="text-muted-foreground">{template.rationale}</p>

      {!template.runnable && (
        <div className="space-y-1">
          {template.blocked_by.map((d, i) => (
            <p key={i} className="font-mono text-[10px] text-clay">{d.message}</p>
          ))}
        </div>
      )}

      <List icon="good" items={template.good_for} />
      <List icon="bad" items={template.bad_for} />

      {template.assumed && template.assumed.length > 0 && (
        <div>
          <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
            Filled in for you
          </div>
          <div className="space-y-0.5">
            {template.assumed.map((a) => (
              <div key={a.path} className="flex gap-2 font-mono text-[10px]">
                <span className="shrink-0 text-muted-foreground/70">{a.path}</span>
                <span className="shrink-0">{String(a.value)}</span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground/70">{a.why}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * One saved strategy.
 *
 * There is no rename control here on purpose: the builder's header *is* the
 * name field now, so opening a strategy, retyping the title and pressing Update
 * renames it in place. A second way to do it would be a second thing to keep
 * consistent.
 *
 * Delete needed one, though — `api.deleteStrategy` has existed since the store
 * was written and nothing called it, so the rail only ever grew.
 */
function SavedRow({ strategy, current, starter, onOpen, onDelete }: {
  strategy: StoredStrategy
  current?: boolean
  starter?: boolean
  onOpen: (strategy: StoredStrategy) => void
  onDelete: (strategy: StoredStrategy) => void
}) {
  const [confirming, setConfirming] = useState(false)

  // A misclick on a trash icon should not destroy work. The second click is the
  // confirmation, and moving away from the row cancels it.
  useEffect(() => {
    if (!confirming) return
    const t = setTimeout(() => setConfirming(false), 4000)
    return () => clearTimeout(t)
  }, [confirming])

  return (
    <RailRow
      data-testid={`saved-${strategy.id}`}
      label={strategy.name}
      selected={current}
      onClick={() => onOpen(strategy)}
      badges={
        <>
          <Badge variant="outline" className="shrink-0">{strategy.universe}</Badge>
          {starter && <Badge className="shrink-0">starter</Badge>}
        </>
      }
      actions={
        <button
          data-testid={`delete-${strategy.id}`}
          title={confirming ? 'Click again to delete' : `Delete “${strategy.name}”`}
          onClick={(e) => {
            e.stopPropagation()
            if (confirming) onDelete(strategy)
            else setConfirming(true)
          }}
          onMouseLeave={() => setConfirming(false)}
          className={cn(
            'rounded p-1 transition-colors',
            confirming
              ? 'bg-clay/15 text-clay'
              : 'text-muted-foreground hover:text-clay',
          )}
        >
          {confirming
            ? <span className="px-0.5 font-mono text-[10px] uppercase">sure?</span>
            : <Trash2 className="h-3.5 w-3.5" />}
        </button>
      }
      tooltip={
        <div className="space-y-1">
          <p className="text-[11px]">{strategy.name}</p>
          <p className="font-mono text-[10px] text-muted-foreground">
            {strategy.model} · {strategy.handler} · {strategy.universe}
          </p>
          <p className="font-mono text-[10px] text-muted-foreground">
            {strategy.test_start} → {strategy.test_end}
          </p>
        </div>
      }
    />
  )
}

function List({ icon, items }: { icon: 'good' | 'bad'; items: string[] }) {
  const Glyph = icon === 'good' ? Check : X
  return (
    <div className="space-y-1">
      {items.map((line) => (
        <div key={line} className="flex gap-2">
          <Glyph
            className={cn('mt-0.5 h-3 w-3 shrink-0',
              icon === 'good' ? 'text-primary' : 'text-clay')}
          />
          <span className="min-w-0 text-muted-foreground">{line}</span>
        </div>
      ))}
    </div>
  )
}
