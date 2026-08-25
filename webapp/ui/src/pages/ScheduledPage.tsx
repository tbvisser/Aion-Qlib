import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  Boxes,
  Clock,
  GitCompare,
  MoreHorizontal,
  Newspaper,
  Pencil,
  Radar,
  Repeat,
  Sunrise,
  Timer,
  Trash2,
} from 'lucide-react'
import { IndexHeader } from '@/components/layout/IndexHeader'
import { Button } from '@/components/ui/button'
import { MicroLabel } from '@/components/ui/micro-label'
import { Switch } from '@/components/ui/switch'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Notice } from '@/components/ui/notice'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/empty-state'
import { TaskDialog } from '@/components/scheduled/TaskDialog'
import { OutputPreview } from '@/components/scheduled/OutputPreview'
import { useScheduledTasks } from '@/hooks/useScheduledTasks'
import { type ScheduledTask, type ScheduledTaskInput } from '@/lib/api'
import { formatRelativeStamp } from '@/lib/time'
import { cn } from '@/lib/utils'

/**
 * Scheduled tasks — run work on a cadence instead of by hand.
 *
 * The page is a platform-style list-detail split: the task list on the left,
 * the selected task's schedule and latest output on the right. Each task kind
 * produces output in a different place (macro refresh job, data refresh job,
 * or backtest run); the detail pane links into the full output page.
 */

interface Suggestion {
  icon: typeof Clock
  name: string
  description: string
  cadence: string
  task: ScheduledTaskInput
}

const SUGGESTIONS: Suggestion[] = [
  {
    icon: Sunrise,
    name: 'Morning macro pull',
    description: 'Refresh the economic calendar and the country indicators before the open.',
    cadence: 'Weekdays at 7:00 AM',
    task: {
      name: 'Morning macro pull',
      kind: 'macro_refresh',
      schedule: { frequency: 'weekdays', time: '07:00' },
      params: { what: 'all' },
      enabled: true,
    },
  },
  {
    icon: Repeat,
    name: 'Overnight rerun',
    description: 'Re-run every strategy attached to a live book against the new bars.',
    cadence: 'Every day at 2:00 AM',
    task: {
      name: 'Overnight rerun',
      kind: 'run_strategy',
      schedule: { frequency: 'daily', time: '02:00' },
      params: { strategy_id: '' },
      enabled: true,
    },
  },
  {
    icon: Radar,
    name: 'Regime watch',
    description: 'Raise an inbox item when the macro quadrant flips.',
    cadence: 'Every day at 9:00 AM',
    task: {
      name: 'Regime watch',
      kind: 'macro_refresh',
      schedule: { frequency: 'daily', time: '09:00' },
      params: { what: 'all' },
      enabled: true,
    },
  },
  {
    icon: GitCompare,
    name: 'Drift check',
    description: "Compare a shadow account's signals against the fills the journal actually shows.",
    cadence: 'Fridays at 4:00 PM',
    task: {
      name: 'Drift check',
      kind: 'run_strategy',
      schedule: { frequency: 'weekly', time: '16:00', day: 'fri' },
      params: { strategy_id: '' },
      enabled: true,
    },
  },
  {
    icon: Newspaper,
    name: 'Weekly review',
    description: 'A Friday summary of every run, fill and release from the week.',
    cadence: 'Every Friday at 4:00 PM',
    task: {
      name: 'Weekly review',
      kind: 'run_strategy',
      schedule: { frequency: 'weekly', time: '16:00', day: 'fri' },
      params: { strategy_id: '' },
      enabled: true,
    },
  },
  {
    icon: Newspaper,
    name: 'Weekly outlook',
    description: 'Generate an Aion-branded PDF outlook every Friday before the weekend.',
    cadence: 'Every Friday at 7:00 AM',
    task: {
      name: 'Weekly outlook',
      kind: 'outlook_report',
      schedule: { frequency: 'weekly', time: '07:00', day: 'fri' },
      params: { scope: 'week' },
      enabled: true,
    },
  },
  {
    icon: Boxes,
    name: 'Databank sweep',
    description: "Re-measure the curated factor set's IC against forward returns.",
    cadence: 'Every Monday at 9:00 AM',
    task: {
      name: 'Databank sweep',
      kind: 'data_refresh',
      schedule: { frequency: 'weekly', time: '09:00', day: 'mon' },
      params: { universe_size: 500, mode: 'update' },
      enabled: true,
    },
  },
]

const KIND_LABELS: Record<ScheduledTask['kind'], string> = {
  macro_refresh: 'Macro refresh',
  data_refresh: 'Data refresh',
  run_strategy: 'Run strategy',
  outlook_report: 'Outlook report',
}

const STATUS_COLORS: Record<string, string> = {
  ok: 'text-primary',
  skipped: 'text-clay',
  error: 'text-destructive',
}

function taskIcon(task: ScheduledTask) {
  return (
    SUGGESTIONS.find((s) => s.name === task.name)?.icon ||
    (task.kind === 'data_refresh' ? Boxes : task.kind === 'macro_refresh' ? Radar : task.kind === 'outlook_report' ? Newspaper : Repeat)
  )
}

function statusText(task: ScheduledTask): string {
  if (!task.last_run) return 'Not run yet'
  if (!task.last_status) return 'Running'
  if (task.last_status === 'error' && task.last_error) {
    return `Error: ${task.last_error}`
  }
  return `Last run ${task.last_status}`
}

export function ScheduledPage() {
  const { taskId } = useParams()
  const navigate = useNavigate()
  const { tasks, error, loading, save, remove, toggle } = useScheduledTasks()
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<ScheduledTask | null>(null)
  const [template, setTemplate] = useState<ScheduledTaskInput | undefined>(undefined)

  const needle = query.trim().toLowerCase()
  const visibleTasks = needle
    ? tasks.filter(
        (t) =>
          t.name.toLowerCase().includes(needle) ||
          KIND_LABELS[t.kind].toLowerCase().includes(needle) ||
          t.cadence.toLowerCase().includes(needle),
      )
    : tasks

  const visibleSuggestions = needle
    ? SUGGESTIONS.filter(
        (s) =>
          s.name.toLowerCase().includes(needle) ||
          s.description.toLowerCase().includes(needle),
      )
    : SUGGESTIONS

  const selectedTask = visibleTasks.find((t) => t.id === taskId) || null

  useEffect(() => {
    if (!taskId && visibleTasks.length > 0) {
      navigate(`/scheduled/${visibleTasks[0].id}`, { replace: true })
    }
  }, [taskId, visibleTasks, navigate])

  const openNew = () => {
    setEditing(null)
    setTemplate(undefined)
    setDialogOpen(true)
  }

  const openTemplate = (suggestion: Suggestion) => {
    setEditing(null)
    setTemplate(suggestion.task)
    setDialogOpen(true)
  }

  const openEdit = (task: ScheduledTask) => {
    setEditing(task)
    setTemplate(undefined)
    setDialogOpen(true)
  }

  const closeDialog = () => {
    setDialogOpen(false)
    setEditing(null)
    setTemplate(undefined)
  }

  const handleSave = async (input: ScheduledTaskInput) => {
    await save(input, editing?.id)
    closeDialog()
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <IndexHeader
        title="Scheduled tasks"
        description="Run tasks on a schedule or whenever you need them."
        search={{
          value: query,
          onChange: setQuery,
          open: searchOpen,
          onOpenChange: setSearchOpen,
          placeholder: 'Search tasks…',
        }}
        actions={
          <Button size="sm" onClick={openNew} data-testid="scheduled-new-task">
            New task
          </Button>
        }
      />

      <div className="min-h-0 flex-1 flex">
        <div className="flex w-72 shrink-0 flex-col border-r border-border/50">
          {error && (
            <Notice tone="destructive" className="m-2">
              {error}
            </Notice>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {loading && (
              <div className="space-y-2 p-1">
                {Array.from({ length: 4 }, (_, i) => (
                  <Skeleton key={i} className="h-12 rounded-lg" />
                ))}
              </div>
            )}

            {!loading && visibleTasks.length === 0 && tasks.length === 0 && !needle && (
              <EmptyState icon={Timer} title="No scheduled tasks yet." className="m-1 p-6" />
            )}

            {!loading && visibleTasks.length > 0 && (
              <div className="space-y-1">
                {visibleTasks.map((task) => {
                  const Icon = taskIcon(task)
                  return (
                    <button
                      key={task.id}
                      onClick={() => navigate(`/scheduled/${task.id}`)}
                      className={cn(
                        'w-full rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-foreground/[0.04]',
                        task.id === taskId && 'bg-foreground/[0.07]',
                      )}
                    >
                      <div className="flex items-start gap-2.5">
                        <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted/50">
                          <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{task.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {KIND_LABELS[task.kind]} · {task.cadence}
                          </p>
                          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-label text-muted-foreground">
                            <span className="flex items-center gap-1">
                              <Clock className="h-3 w-3" />
                              {task.next_run
                                ? `Next ${formatRelativeStamp(task.next_run)}`
                                : 'No upcoming run'}
                            </span>
                            {task.last_run && (
                              <span
                                className={cn(
                                  'flex items-center gap-1',
                                  STATUS_COLORS[task.last_status || ''],
                                )}
                              >
                                {statusText(task)}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    </button>
                  )
                })}
              </div>
            )}

            {!loading && visibleTasks.length === 0 && needle && (
              <p className="py-6 text-center text-xs text-muted-foreground">
                Nothing matches “{query}”.
              </p>
            )}
          </div>

          {!loading && visibleSuggestions.length > 0 && (
            <div className="border-t border-border/50 p-3">
              <MicroLabel as="div" className="mb-2">
                Worth scheduling first
              </MicroLabel>
              <div className="space-y-2">
                {visibleSuggestions.map((suggestion) => {
                  const Icon = suggestion.icon
                  return (
                    <button
                      key={suggestion.name}
                      onClick={() => openTemplate(suggestion)}
                      className="flex w-full items-start gap-2 rounded-md p-1.5 text-left transition-colors hover:bg-foreground/[0.04]"
                    >
                      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <div className="min-w-0">
                        <p className="text-xs font-medium">{suggestion.name}</p>
                        <p className="text-micro text-muted-foreground">{suggestion.cadence}</p>
                      </div>
                    </button>
                  )
                })}
              </div>
            </div>
          )}
        </div>

        <div className="min-w-0 flex-1 overflow-y-auto bg-background">
          {selectedTask ? (
            <TaskDetail
              task={selectedTask}
              onEdit={openEdit}
              onToggle={toggle}
              onRemove={remove}
            />
          ) : (
            <div className="flex h-full items-center justify-center p-8">
              <EmptyState
                icon={Timer}
                title="Select a scheduled task"
                description="Its schedule, params and latest output will appear here."
                className="w-full max-w-sm"
              />
            </div>
          )}
        </div>
      </div>

      <TaskDialog
        key={editing?.id ?? template?.name ?? 'new'}
        open={dialogOpen}
        task={editing}
        defaultInput={template}
        onClose={closeDialog}
        onSave={handleSave}
      />
    </div>
  )
}

function TaskDetail({
  task,
  onEdit,
  onToggle,
  onRemove,
}: {
  task: ScheduledTask
  onEdit: (task: ScheduledTask) => void
  onToggle: (id: string, enabled: boolean) => Promise<void>
  onRemove: (id: string) => Promise<void>
}) {
  const Icon = taskIcon(task)

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-9 w-9 items-center justify-center rounded-lg bg-muted/50">
            <Icon className="h-4 w-4 text-muted-foreground" />
          </div>
          <div>
            <h2 className="text-lg font-semibold tracking-tight">{task.name}</h2>
            <p className="text-xs text-muted-foreground">
              {KIND_LABELS[task.kind]} · {task.cadence}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {task.is_demo ? (
            <MicroLabel>
              Demo
            </MicroLabel>
          ) : (
            <>
              <Switch
                checked={task.enabled}
                onCheckedChange={(enabled) => onToggle(task.id, enabled)}
                aria-label={task.enabled ? 'Disable task' : 'Enable task'}
              />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-8 w-8">
                    <MoreHorizontal className="h-4 w-4" />
                    <span className="sr-only">Task options</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => onEdit(task)}>
                    <Pencil className="mr-2 h-4 w-4" /> Edit
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    onClick={() => void onRemove(task.id)}
                  >
                    <Trash2 className="mr-2 h-4 w-4" /> Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          )}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Schedule</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 pt-0 text-sm text-muted-foreground">
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4" />
              {task.cadence}
            </div>
            {task.next_run && (
              <div>
                Next run{' '}
                <span className="font-medium text-foreground">{formatRelativeStamp(task.next_run)}</span>
              </div>
            )}
            {task.last_run && (
              <div className={cn(STATUS_COLORS[task.last_status || ''])}>
                {statusText(task)}{' '}
                <span className="text-muted-foreground">· {formatRelativeStamp(task.last_run)}</span>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">What it does</CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <ActionSummary task={task} />
          </CardContent>
        </Card>
      </div>

      <div>
        <h3 className="mb-3 text-sm font-medium">Latest output</h3>
        <OutputPreview task={task} />
      </div>
    </div>
  )
}

function ActionSummary({ task }: { task: ScheduledTask }) {
  switch (task.kind) {
    case 'macro_refresh': {
      const what = String(task.params.what || 'all')
      return (
        <p className="text-sm text-muted-foreground">
          Refreshes the macro cache:{' '}
          <span className="font-medium text-foreground">
            {what === 'all' ? 'calendar + indicators' : what}
          </span>
          .
        </p>
      )
    }
    case 'data_refresh': {
      const universeSize = Number(task.params.universe_size || 500)
      const mode = String(task.params.mode || 'all')
      return (
        <p className="text-sm text-muted-foreground">
          Rebuilds the qlib store for the top{' '}
          <span className="font-medium text-foreground">{universeSize}</span>{' '}
          instruments in <span className="font-medium text-foreground">{mode}</span> mode.
        </p>
      )
    }
    case 'run_strategy': {
      const strategyId = String(task.params.strategy_id || '')
      return (
        <p className="text-sm text-muted-foreground">
          Runs the strategy attached to{' '}
          <span className="font-mono text-xs font-medium text-foreground">
            {strategyId || 'no strategy'}
          </span>
          .
        </p>
      )
    }
    case 'outlook_report': {
      const scope = String(task.params.scope || 'week')
      return (
        <p className="text-sm text-muted-foreground">
          Generates an Aion-branded{' '}
          <span className="font-medium text-foreground">{scope}</span> outlook PDF.
        </p>
      )
    }
    default:
      return null
  }
}
