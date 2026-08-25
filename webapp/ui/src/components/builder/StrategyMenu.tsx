/**
 * The header's strategy switcher.
 *
 * A *split* trigger: the name stays an editable input and only the chevron
 * opens the menu. The three obvious alternatives are all worse — a
 * `DropdownMenuTrigger` that is also a text field is a keyboard trap (Space
 * opens the menu, arrows move the highlight), an `Input` inside the menu
 * content fights Radix's typeahead, and a Rename dialog puts the most-edited
 * field on the page two clicks deep. The split keeps the click-the-title-to-
 * rename gesture that was already here.
 *
 * Presentational, with one exception: the delete confirm is local, because the
 * page has nothing to do with it until it is answered. The *unsaved* guard is
 * not here at all — it wraps the page's own funnels, so every route into a
 * strategy switch is covered rather than just this one.
 */
import { useState } from 'react'
import { Check, ChevronDown, Copy, LayoutGrid, Lock, Plus, Save, Trash2, Users } from 'lucide-react'

import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { OwnershipBadge, useIsOwner } from '@/components/OwnershipBadge'
import { Badge } from '@/components/ui/badge'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from '@/components/ui/tooltip'
import type { StoredStrategy } from '@/lib/api'
import { SAVE_STATE_LABELS, saveState } from '@/lib/strategyDirty'
import { MicroLabel } from '@/components/ui/micro-label'
import { cn } from '@/lib/utils'

/** Seeded demo books, grouped apart so they do not crowd out your own work. */
const DEMO_PREFIX = 'demo-'

export interface StrategyMenuProps {
  name: string
  onNameChange: (name: string) => void
  /** The saved record open in the builder, or undefined for a never-saved draft. */
  currentId?: string
  /** Unsaved edits against the baseline. Drives the dot; the page owns the guard. */
  dirty: boolean
  /** What differs, for the dot's tooltip. */
  changed: string[]
  saved: StoredStrategy[]
  /** Save or update the open strategy. Lives here rather than in the header:
   *  there is no reason to save before you know whether it worked. */
  onSave: () => void
  busy?: boolean
  /** Already guarded by the page. */
  onOpen: (strategy: StoredStrategy) => void
  onNew: () => void
  /** Not guarded: duplicating carries the edits into the copy, so nothing is lost. */
  onDuplicate: () => void
  onDelete: (strategy: StoredStrategy) => void
  /** Share the open strategy with the workspace, or take it back. */
  onSetVisibility: (strategy: StoredStrategy, visibility: 'private' | 'org') => void
  onBrowseTemplates: () => void
}

export function StrategyMenu({
  name, onNameChange, currentId, dirty, changed, saved, onSave, busy,
  onOpen, onNew, onDuplicate, onDelete, onSetVisibility, onBrowseTemplates,
}: StrategyMenuProps) {
  // Held here rather than as an `AlertDialogTrigger` inside a menu item: the
  // menu unmounts on select and would take the dialog with it.
  const [deleting, setDeleting] = useState<StoredStrategy | null>(null)

  const mine = saved.filter((s) => !s.id.startsWith(DEMO_PREFIX))
  const book = saved.filter((s) => s.id.startsWith(DEMO_PREFIX))
  const open = currentId ? saved.find((s) => s.id === currentId) : undefined
  // Sharing is the owner's call. A colleague can open and run a shared
  // strategy; publishing it further is not theirs to decide.
  const mineToShare = useIsOwner(open)

  return (
    <div className="flex min-w-0 items-baseline gap-2">
      <MicroLabel className="shrink-0">
        AION
      </MicroLabel>
      <span aria-hidden className="shrink-0 text-muted-foreground/40">·</span>

      <input
        data-testid="strategy-name"
        value={name}
        onChange={(e) => onNameChange(e.target.value)}
        placeholder="Name this strategy"
        aria-label="Strategy name"
        className="min-w-0 max-w-sm flex-1 truncate rounded-md bg-transparent px-1.5 py-0.5 text-lg font-semibold tracking-tight outline-none transition-colors placeholder:font-normal placeholder:text-muted-foreground/60 hover:bg-foreground/[0.04] focus:bg-foreground/[0.06]"
      />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-testid="strategy-menu"
            aria-label="Switch strategy"
            className="shrink-0 self-center rounded-md p-1 text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
          >
            <ChevronDown className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>

        <DropdownMenuContent align="start" className="w-72">
          {mine.length > 0 && (
            <>
              <DropdownMenuLabel className="font-mono text-micro uppercase tracking-wider text-muted-foreground/70">
                My strategies
              </DropdownMenuLabel>
              {mine.map((s) => (
                <StrategyItem key={s.id} strategy={s} currentId={currentId} onOpen={onOpen} />
              ))}
            </>
          )}

          {book.length > 0 && (
            <>
              <DropdownMenuLabel className="font-mono text-micro uppercase tracking-wider text-muted-foreground/70">
                Fund book
              </DropdownMenuLabel>
              {book.map((s) => (
                <StrategyItem key={s.id} strategy={s} currentId={currentId} onOpen={onOpen} />
              ))}
            </>
          )}

          {saved.length > 0 && <DropdownMenuSeparator />}

          <DropdownMenuItem onSelect={onSave} disabled={busy || !name.trim()}>
            <Save className="h-3.5 w-3.5" />
            {currentId ? 'Update' : 'Save'}
            {dirty && <span className="ml-auto h-1.5 w-1.5 rounded-full border border-muted-foreground/60" />}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onNew}>
            <Plus className="h-3.5 w-3.5" />
            New strategy
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onDuplicate} disabled={!name.trim()}>
            <Copy className="h-3.5 w-3.5" />
            Duplicate
          </DropdownMenuItem>
          {/* Only for a saved strategy you own: there is nothing to share
              until it exists, and a colleague's copy is not yours to publish. */}
          {open && mineToShare && (
            <DropdownMenuItem
              onSelect={() =>
                onSetVisibility(open, open.visibility === 'org' ? 'private' : 'org')}
            >
              {open.visibility === 'org'
                ? <><Lock className="h-3.5 w-3.5" />Make private</>
                : <><Users className="h-3.5 w-3.5" />Share with workspace</>}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            disabled={!open}
            onSelect={() => { if (open) setDeleting(open) }}
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete
          </DropdownMenuItem>

          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onBrowseTemplates}>
            <LayoutGrid className="h-3.5 w-3.5" />
            Browse templates
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <StateDot currentId={currentId} dirty={dirty} changed={changed} />

      {/* A sibling of the menu, not a child of an item — see the note on `deleting`. */}
      <AlertDialog open={deleting !== null} onOpenChange={(o) => { if (!o) setDeleting(null) }}>
        <AlertDialogContent data-testid="delete-strategy-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleting?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The saved record goes. What is open in the builder stays, so the next Save
              writes a new one. Backtests already run against it are not touched.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { if (deleting) onDelete(deleting); setDeleting(null) }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function StrategyItem({ strategy, currentId, onOpen }: {
  strategy: StoredStrategy
  currentId?: string
  onOpen: (s: StoredStrategy) => void
}) {
  return (
    <DropdownMenuItem onSelect={() => onOpen(strategy)} className="gap-2">
      <Check className={cn('h-3.5 w-3.5 shrink-0',
                           strategy.id === currentId ? 'opacity-100' : 'opacity-0')} />
      <span className="min-w-0 flex-1 truncate">{strategy.name}</span>
      {/* Renders nothing for your own private work, which is most rows. It
          appears only when there is something to say: this one is shared, or
          it is not yours. */}
      <OwnershipBadge record={strategy} className="shrink-0" />
      <Badge variant="outline" className="shrink-0">{strategy.universe}</Badge>
    </DropdownMenuItem>
  )
}

/**
 * Saved, or not.
 *
 * Mint-filled means in sync with the store; a hollow ring means it is not.
 * Deliberately *not* clay: house semantics reserve clay for a bad result and
 * destructive for something that broke, and your own unsaved typing is neither.
 * A never-saved draft nobody has touched shows nothing at all rather than
 * nagging about work that does not exist yet.
 */
function StateDot({ currentId, dirty, changed }: {
  currentId?: string
  dirty: boolean
  changed: string[]
}) {
  const state = saveState(dirty, currentId)
  if (state === 'clean-draft') return null

  const label = SAVE_STATE_LABELS[state]
  const detail = state === 'saved'
    ? label
    : `${label}${changed.length ? `: ${changed.slice(0, 4).join(', ')}` : ''}`

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            data-testid="save-state-dot"
            data-state={state}
            aria-label={detail}
            className={cn('h-1.5 w-1.5 shrink-0 self-center rounded-full',
                          state === 'saved'
                            ? 'bg-primary'
                            : 'border border-muted-foreground/60')}
          />
        </TooltipTrigger>
        <TooltipContent>
          <span className="text-label">{detail}</span>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
