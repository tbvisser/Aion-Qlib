import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Plus, Trash2 } from 'lucide-react'
import { IndexHeader } from '@/components/layout/IndexHeader'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Notice } from '@/components/ui/notice'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/empty-state'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useProjects } from '@/hooks/useProjects'
import { api, type Portfolio, type Project, type ProjectSpec, type StoredStrategy } from '@/lib/api'
import { formatRelativeStamp } from '@/lib/time'
import { cn } from '@/lib/utils'

/**
 * Projects: a name over a handful of ids pointing at work that lives elsewhere.
 *
 * The card is the whole page. A project owns nothing — opening one is opening
 * its members, so the detail route hands off to them rather than building a
 * fourth view of a strategy that the builder, the book and the run pages
 * already render.
 */

type SortKey = 'updated' | 'created' | 'name'

const SORTS: { value: SortKey; label: string }[] = [
  { value: 'updated', label: 'Last updated' },
  { value: 'created', label: 'Date created' },
  { value: 'name', label: 'Name' },
]

const memberCount = (project: Project) =>
  project.strategy_ids.length +
  project.portfolio_ids.length +
  project.thread_ids.length +
  project.document_ids.length

export function ProjectsPage() {
  const navigate = useNavigate()
  const { projectId } = useParams<{ projectId: string }>()
  const { projects, error, loading, save, remove } = useProjects()

  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [sort, setSort] = useState<SortKey>('updated')
  const [editing, setEditing] = useState<Project | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)

  // A /projects/:projectId link opens that project's editor rather than a page
  // of its own — see the component docstring on why there is no detail view.
  useEffect(() => {
    if (!projectId || loading) return
    const match = projects.find((p) => p.id === projectId)
    if (match) {
      setEditing(match)
      setDialogOpen(true)
    }
  }, [projectId, projects, loading])

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const matched = needle
      ? projects.filter(
          (p) =>
            p.name.toLowerCase().includes(needle) ||
            p.description.toLowerCase().includes(needle),
        )
      : projects
    return [...matched].sort((a, b) => {
      if (sort === 'name') return a.name.localeCompare(b.name)
      if (sort === 'created') return b.created_at.localeCompare(a.created_at)
      return b.updated_at.localeCompare(a.updated_at)
    })
  }, [projects, query, sort])

  const openNew = () => {
    setEditing(null)
    setDialogOpen(true)
  }

  const closeDialog = () => {
    setDialogOpen(false)
    setEditing(null)
    if (projectId) navigate('/projects', { replace: true })
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <IndexHeader
        title="Projects"
        search={{
          value: query,
          onChange: setQuery,
          open: searchOpen,
          onOpenChange: setSearchOpen,
          placeholder: 'Search projects…',
        }}
        menus={[
          {
            label: 'Sort by',
            value: sort,
            options: SORTS,
            onChange: (value) => setSort(value as SortKey),
            testId: 'projects-sort',
          },
        ]}
        actions={
          <Button size="sm" onClick={openNew}>
            <Plus className="mr-1 h-3.5 w-3.5" /> New project
          </Button>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto max-w-5xl space-y-4">
          {error && <Notice tone="destructive">{error}</Notice>}

          {loading && (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: 3 }, (_, i) => (
                <Skeleton key={i} className="h-40 rounded-xl" />
              ))}
            </div>
          )}

          {!loading && visible.length === 0 && (
            <EmptyState
              title={projects.length === 0
                ? 'No projects yet. A project is a name over the strategies, books, chats and documents that belong to one piece of work.'
                : `Nothing matches “${query}”.`}
              action={projects.length === 0 ? (
                <Button size="sm" onClick={openNew}>
                  <Plus className="mr-1 h-3.5 w-3.5" /> New project
                </Button>
              ) : undefined}
            />
          )}

          {!loading && visible.length > 0 && (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {visible.map((project) => {
                const members = memberCount(project)
                return (
                  <Card
                    key={project.id}
                    data-testid={`project-card-${project.id}`}
                    onClick={() => navigate(`/projects/${project.id}`)}
                    className="cursor-pointer transition-colors hover:border-border"
                  >
                    <CardContent className="flex h-full flex-col gap-2 p-4">
                      <div className="flex items-start justify-between gap-2">
                        <h2 className="min-w-0 truncate text-sm font-semibold">{project.name}</h2>
                        {members > 0 && (
                          <Badge variant="muted" className="shrink-0">
                            {members === 1 ? '1 item' : `${members} items`}
                          </Badge>
                        )}
                      </div>
                      <p className="line-clamp-3 flex-1 text-xs leading-relaxed text-muted-foreground">
                        {project.description || 'No description.'}
                      </p>
                      <p className="font-mono text-label text-muted-foreground/70">
                        {formatRelativeStamp(project.updated_at)}
                      </p>
                    </CardContent>
                  </Card>
                )
              })}
            </div>
          )}
        </div>
      </div>

      <ProjectDialog
        key={editing?.id ?? 'new'}
        open={dialogOpen}
        project={editing}
        onClose={closeDialog}
        onSave={async (spec) => {
          await save(spec, editing?.id)
          closeDialog()
        }}
        onDelete={
          editing
            ? async () => {
                await remove(editing.id)
                closeDialog()
              }
            : undefined
        }
      />
    </div>
  )
}

/**
 * The editor. Members are picked from the two stores this client can reach;
 * threads and documents live in Supabase and are carried through untouched so
 * editing a project's name never drops the chats attached to it.
 */
function ProjectDialog({
  open,
  project,
  onClose,
  onSave,
  onDelete,
}: {
  open: boolean
  project: Project | null
  onClose: () => void
  onSave: (spec: ProjectSpec) => Promise<void>
  onDelete?: () => Promise<void>
}) {
  const [name, setName] = useState(project?.name ?? '')
  const [description, setDescription] = useState(project?.description ?? '')
  const [strategyIds, setStrategyIds] = useState<string[]>(project?.strategy_ids ?? [])
  const [portfolioIds, setPortfolioIds] = useState<string[]>(project?.portfolio_ids ?? [])
  const [strategies, setStrategies] = useState<StoredStrategy[]>([])
  const [portfolios, setPortfolios] = useState<Portfolio[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void Promise.allSettled([api.listStrategies(), api.listPortfolios()]).then(
      ([strategyResult, portfolioResult]) => {
        if (cancelled) return
        if (strategyResult.status === 'fulfilled') setStrategies(strategyResult.value.strategies)
        if (portfolioResult.status === 'fulfilled') setPortfolios(portfolioResult.value.portfolios)
      },
    )
    return () => {
      cancelled = true
    }
  }, [open])

  const toggle = (ids: string[], id: string) =>
    ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]

  const submit = async () => {
    setSaving(true)
    setError(null)
    try {
      // Spec only — `id` and the timestamps are the store's to set, and the
      // request model forbids extra keys, so sending them back is a 422.
      await onSave({
        name: name.trim(),
        description: description.trim(),
        strategy_ids: strategyIds,
        portfolio_ids: portfolioIds,
        // Threads and documents pass through: this editor cannot see them (they
        // live in Supabase), so it must not be the thing that clears them.
        thread_ids: project?.thread_ids ?? [],
        document_ids: project?.document_ids ?? [],
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the project')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{project ? 'Edit project' : 'New project'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="project-name">Name</Label>
            <Input
              id="project-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Crypto momentum, Q3"
              maxLength={80}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="project-description">Description</Label>
            <Textarea
              id="project-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="What this project is for."
              rows={3}
              maxLength={2000}
            />
          </div>

          <MemberPicker
            label="Strategies"
            empty="No saved strategies yet."
            items={strategies.map((s) => ({ id: s.id, label: s.name }))}
            selected={strategyIds}
            onToggle={(id) => setStrategyIds((ids) => toggle(ids, id))}
          />

          <MemberPicker
            label="Portfolios"
            empty="No portfolios yet."
            items={portfolios.map((p) => ({ id: p.id, label: p.name }))}
            selected={portfolioIds}
            onToggle={(id) => setPortfolioIds((ids) => toggle(ids, id))}
          />

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter className="sm:justify-between">
          {onDelete ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void onDelete()}
              className="text-destructive hover:text-destructive"
            >
              <Trash2 className="mr-1 h-3.5 w-3.5" /> Delete
            </Button>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button size="sm" disabled={!name.trim() || saving} onClick={() => void submit()}>
              {saving ? 'Saving…' : 'Save project'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function MemberPicker({
  label,
  empty,
  items,
  selected,
  onToggle,
}: {
  label: string
  empty: string
  items: { id: string; label: string }[]
  selected: string[]
  onToggle: (id: string) => void
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground">{empty}</p>
      ) : (
        <div className="flex max-h-32 flex-wrap gap-1.5 overflow-y-auto rounded-lg border border-border/50 p-2">
          {items.map((item) => {
            const on = selected.includes(item.id)
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onToggle(item.id)}
                aria-pressed={on}
                className={cn(
                  'rounded-md px-2 py-1 text-xs transition-colors',
                  on
                    ? 'bg-foreground/[0.07] text-foreground'
                    : 'text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground',
                )}
              >
                {item.label}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
