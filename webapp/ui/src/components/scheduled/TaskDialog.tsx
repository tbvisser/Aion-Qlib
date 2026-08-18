import { useEffect, useMemo, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { api, type ScheduledTask, type ScheduledTaskInput, type StoredStrategy } from '@/lib/api'

interface TaskDialogProps {
  open: boolean
  task: ScheduledTask | null
  defaultInput?: ScheduledTaskInput
  onClose: () => void
  onSave: (task: ScheduledTaskInput) => Promise<void>
}

const KIND_OPTIONS = [
  { value: 'macro_refresh', label: 'Macro refresh' },
  { value: 'data_refresh', label: 'Data refresh' },
  { value: 'run_strategy', label: 'Run strategy' },
  { value: 'outlook_report', label: 'Outlook report' },
]

const OUTLOOK_SCOPE_OPTIONS = [
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
]

const FREQUENCY_OPTIONS = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekdays', label: 'Weekdays' },
  { value: 'weekly', label: 'Weekly' },
]

const WEEKDAY_OPTIONS = [
  { value: 'mon', label: 'Monday' },
  { value: 'tue', label: 'Tuesday' },
  { value: 'wed', label: 'Wednesday' },
  { value: 'thu', label: 'Thursday' },
  { value: 'fri', label: 'Friday' },
  { value: 'sat', label: 'Saturday' },
  { value: 'sun', label: 'Sunday' },
]

const MACRO_WHAT_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'calendar', label: 'Calendar' },
  { value: 'indicators', label: 'Indicators' },
]

const DATA_MODE_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'update', label: 'Update' },
]

function defaultParams(kind: string): Record<string, unknown> {
  switch (kind) {
    case 'macro_refresh':
      return { what: 'all' }
    case 'data_refresh':
      return { universe_size: 500, mode: 'all' }
    case 'run_strategy':
      return { strategy_id: '' }
    case 'outlook_report':
      return { scope: 'week' }
    default:
      return {}
  }
}

export function TaskDialog({ open, task, defaultInput, onClose, onSave }: TaskDialogProps) {
  const [name, setName] = useState('')
  const [kind, setKind] = useState('macro_refresh')
  const [frequency, setFrequency] = useState('weekdays')
  const [time, setTime] = useState('07:00')
  const [day, setDay] = useState('mon')
  const [enabled, setEnabled] = useState(true)
  const [params, setParams] = useState<Record<string, unknown>>({})
  const [strategies, setStrategies] = useState<StoredStrategy[]>([])
  const [strategiesLoading, setStrategiesLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    const source = task ?? defaultInput
    if (source) {
      setName(source.name)
      setKind(source.kind)
      setFrequency(source.schedule.frequency)
      setTime(source.schedule.time)
      setDay(source.schedule.day || 'mon')
      setEnabled(source.enabled ?? true)
      setParams(source.params)
    } else {
      setName('')
      setKind('macro_refresh')
      setFrequency('weekdays')
      setTime('07:00')
      setDay('mon')
      setEnabled(true)
      setParams(defaultParams('macro_refresh'))
    }
    setError(null)
    setSaving(false)
  }, [open, task, defaultInput])

  useEffect(() => {
    if (kind !== 'run_strategy') return
    setStrategiesLoading(true)
    api
      .listStrategies()
      .then((res) => setStrategies(res.strategies))
      .catch(() => setStrategies([]))
      .finally(() => setStrategiesLoading(false))
  }, [kind])

  useEffect(() => {
    setParams((prev) => {
      const next = { ...defaultParams(kind) }
      // Preserve strategy_id when switching kinds if it still makes sense.
      if (kind === 'run_strategy' && prev.strategy_id) {
        next.strategy_id = prev.strategy_id
      }
      return next
    })
  }, [kind])

  const schedule = useMemo(
    () => ({
      frequency: frequency as 'daily' | 'weekdays' | 'weekly',
      time,
      ...(frequency === 'weekly' ? { day: day as 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun' } : {}),
    }),
    [frequency, time, day],
  )

  const isValid = useMemo(() => {
    if (!name.trim()) return false
    if (!/^([0-1]\d|2[0-3]):([0-5]\d)$/.test(time)) return false
    if (kind === 'run_strategy' && !params.strategy_id) return false
    return true
  }, [name, time, kind, params])

  const handleSave = async () => {
    if (!isValid) return
    setSaving(true)
    setError(null)
    try {
      await onSave({
        name: name.trim(),
        kind: kind as ScheduledTaskInput['kind'],
        schedule,
        params,
        enabled,
      })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save scheduled task')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{task ? 'Edit scheduled task' : 'New scheduled task'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="task-name">Name</Label>
            <Input
              id="task-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Morning macro pull"
            />
          </div>

          <div className="space-y-1.5">
            <Label>Task type</Label>
            <Select value={kind} onValueChange={setKind}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {KIND_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {kind === 'macro_refresh' && (
            <div className="space-y-1.5">
              <Label>Refresh what</Label>
              <Select
                value={String(params.what || 'all')}
                onValueChange={(v) => setParams((p) => ({ ...p, what: v }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MACRO_WHAT_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {kind === 'data_refresh' && (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="universe-size">Universe size</Label>
                <Input
                  id="universe-size"
                  type="number"
                  min={1}
                  max={5000}
                  value={Number(params.universe_size || 500)}
                  onChange={(e) =>
                    setParams((p) => ({ ...p, universe_size: parseInt(e.target.value, 10) }))
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label>Mode</Label>
                <Select
                  value={String(params.mode || 'all')}
                  onValueChange={(v) => setParams((p) => ({ ...p, mode: v }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DATA_MODE_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}

          {kind === 'run_strategy' && (
            <div className="space-y-1.5">
              <Label>Strategy</Label>
              <Select
                value={String(params.strategy_id || '')}
                onValueChange={(v) => setParams((p) => ({ ...p, strategy_id: v }))}
                disabled={strategiesLoading}
              >
                <SelectTrigger>
                  <SelectValue placeholder={strategiesLoading ? 'Loading…' : 'Choose a strategy'} />
                </SelectTrigger>
                <SelectContent>
                  {strategies.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {kind === 'outlook_report' && (
            <div className="space-y-1.5">
              <Label>Horizon</Label>
              <Select
                value={String(params.scope || 'week')}
                onValueChange={(v) => setParams((p) => ({ ...p, scope: v }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {OUTLOOK_SCOPE_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Frequency</Label>
              <Select value={frequency} onValueChange={setFrequency}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FREQUENCY_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="task-time">Time (UTC)</Label>
              <Input
                id="task-time"
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
              />
            </div>
          </div>

          {frequency === 'weekly' && (
            <div className="space-y-1.5">
              <Label>Day</Label>
              <Select value={day} onValueChange={setDay}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WEEKDAY_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="flex items-center gap-3 pt-1">
            <Switch id="task-enabled" checked={enabled} onCheckedChange={setEnabled} />
            <Label htmlFor="task-enabled" className="cursor-pointer">
              Enabled
            </Label>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void handleSave()} disabled={!isValid || saving}>
            {saving ? 'Saving…' : task ? 'Save changes' : 'Create task'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
