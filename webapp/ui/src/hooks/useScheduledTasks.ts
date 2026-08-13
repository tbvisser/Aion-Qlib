import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, type ScheduledTask, type ScheduledTaskInput, type WeekDay } from '@/lib/api'

const rawDemoFlag = import.meta.env.VITE_DEMO_SCHEDULED_TASKS
const DEMO_ENABLED = rawDemoFlag === 'false' ? false : (rawDemoFlag === 'true' || import.meta.env.DEV)

function iso(d: Date) {
  return d.toISOString()
}

function today(hour: number, minute: number) {
  const d = new Date()
  d.setHours(hour, minute, 0, 0)
  return d
}

function addDays(d: Date, days: number) {
  const copy = new Date(d)
  copy.setDate(copy.getDate() + days)
  return copy
}

function nextWeekday(targetDay: number, hour: number, minute: number) {
  const d = today(hour, minute)
  let delta = (targetDay - d.getDay() + 7) % 7
  if (delta === 0 && new Date() > d) delta = 7
  return addDays(d, delta)
}

function prevWeekday(targetDay: number, hour: number, minute: number) {
  const d = today(hour, minute)
  let delta = (d.getDay() - targetDay + 7) % 7
  if (delta === 0) delta = 7
  return addDays(d, -delta)
}

function nextDaily(hour: number, minute: number) {
  const d = today(hour, minute)
  return new Date() > d ? addDays(d, 1) : d
}

function prevDaily(hour: number, minute: number) {
  const d = today(hour, minute)
  return new Date() > d ? d : addDays(d, -1)
}

function nextWeekly(day: WeekDay, hour: number, minute: number) {
  const map: Record<WeekDay, number> = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 0 }
  return nextWeekday(map[day], hour, minute)
}

function prevWeekly(day: WeekDay, hour: number, minute: number) {
  const map: Record<WeekDay, number> = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 0 }
  return prevWeekday(map[day], hour, minute)
}

const DEMO_TASKS: ScheduledTask[] = [
  {
    id: 'demo-morning-macro',
    org_id: 'demo',
    user_id: 'demo',
    visibility: 'private',
    name: 'Morning macro pull',
    kind: 'macro_refresh',
    enabled: true,
    schedule: { frequency: 'weekdays', time: '07:00' },
    params: { what: 'all' },
    next_run: iso(nextWeekday(1, 7, 0)),
    last_run: iso(prevWeekday(1, 7, 0)),
    last_status: 'ok',
    last_error: null,
    last_output_id: 'demo-macro-001',
    last_output_kind: 'macro_job',
    last_output_summary: {
      kind: 'macro_job',
      status: 'done',
      error: null,
      calendar_rows: 1247,
      indicator_rows: 892,
      indicators: {
        'USA/non_farm_payrolls': 156,
        'USA/cpi_yoy': 142,
        'USA/gdp_growth_rate': 88,
        'DEU/cpi_yoy': 134,
        'GBP/boe_interest_rate': 72,
      },
      warnings_count: 0,
    },
    created_at: iso(prevWeekday(1, 7, 0)),
    updated_at: iso(prevWeekday(1, 7, 0)),
    cadence: 'Weekdays at 07:00',
    is_demo: true,
  },
  {
    id: 'demo-regime-watch',
    org_id: 'demo',
    user_id: 'demo',
    visibility: 'private',
    name: 'Regime watch',
    kind: 'macro_refresh',
    enabled: true,
    schedule: { frequency: 'daily', time: '09:00' },
    params: { what: 'all' },
    next_run: iso(nextDaily(9, 0)),
    last_run: iso(prevDaily(9, 0)),
    last_status: 'ok',
    last_error: null,
    last_output_id: 'demo-macro-002',
    last_output_kind: 'macro_job',
    last_output_summary: {
      kind: 'macro_job',
      status: 'done',
      error: null,
      calendar_rows: 89,
      indicator_rows: 64,
      indicators: {
        'USA/initial_jobless_claims': 12,
        'USA/core_pce_price_index_yoy': 8,
      },
      warnings_count: 1,
    },
    created_at: iso(prevDaily(9, 0)),
    updated_at: iso(prevDaily(9, 0)),
    cadence: 'Every day at 09:00',
    is_demo: true,
  },
  {
    id: 'demo-databank-sweep',
    org_id: 'demo',
    user_id: 'demo',
    visibility: 'private',
    name: 'Databank sweep',
    kind: 'data_refresh',
    enabled: true,
    schedule: { frequency: 'weekly', time: '09:00', day: 'mon' },
    params: { universe_size: 500, mode: 'update' },
    next_run: iso(nextWeekly('mon', 9, 0)),
    last_run: iso(prevWeekly('mon', 9, 0)),
    last_status: 'ok',
    last_error: null,
    last_output_id: 'demo-ingest-001',
    last_output_kind: 'ingest_job',
    last_output_summary: {
      kind: 'ingest_job',
      status: 'done',
      error: null,
      restart_required: false,
      symbols_requested: 500,
      symbols_written: 498,
      symbols_failed: 2,
      failed_sample: ['XYZW', 'ABCD'],
      universe: 'top500',
      start: '2010-01-01',
      end: '2026-08-12',
      non_trading_days_pruned: 14,
    },
    created_at: iso(prevWeekly('mon', 9, 0)),
    updated_at: iso(prevWeekly('mon', 9, 0)),
    cadence: 'Every Monday at 09:00',
    is_demo: true,
  },
  {
    id: 'demo-weekly-outlook',
    org_id: 'demo',
    user_id: 'demo',
    visibility: 'private',
    name: 'Weekly outlook',
    kind: 'outlook_report',
    enabled: true,
    schedule: { frequency: 'weekly', time: '07:00', day: 'fri' },
    params: { scope: 'week' },
    next_run: iso(nextWeekly('fri', 7, 0)),
    last_run: iso(prevWeekly('fri', 7, 0)),
    last_status: 'ok',
    last_error: null,
    last_output_id: 'demo-outlook-001',
    last_output_kind: 'outlook_report',
    last_output_summary: {
      kind: 'outlook_report',
      status: 'ok',
      scope: 'week',
      date: '2026-08-10',
      start: '2026-08-10',
      end: '2026-08-16',
      pages: 2,
      file_size: 124_780,
      title: 'Week outlook (2026-08-10)',
    },
    created_at: iso(prevWeekly('fri', 7, 0)),
    updated_at: iso(prevWeekly('fri', 7, 0)),
    cadence: 'Every Friday at 07:00',
    is_demo: true,
  },
  {
    id: 'demo-drift-check',
    org_id: 'demo',
    user_id: 'demo',
    visibility: 'private',
    name: 'Drift check',
    kind: 'run_strategy',
    enabled: false,
    schedule: { frequency: 'weekly', time: '16:00', day: 'fri' },
    params: { strategy_id: 'demo-baseline' },
    next_run: null,
    last_run: iso(prevWeekly('fri', 16, 0)),
    last_status: 'skipped',
    last_error: 'Strategy not linked yet',
    last_output_id: null,
    last_output_kind: null,
    last_output_summary: null,
    created_at: iso(prevWeekly('fri', 16, 0)),
    updated_at: iso(prevWeekly('fri', 16, 0)),
    cadence: 'Every Friday at 16:00',
    is_demo: true,
  },
]

export function useScheduledTasks() {
  const [tasks, setTasks] = useState<ScheduledTask[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const response = await api.listScheduledTasks()
      setTasks(response.tasks)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load scheduled tasks')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const displayTasks = useMemo(() => {
    if (!DEMO_ENABLED) return tasks
    return tasks.length === 0 ? DEMO_TASKS : tasks
  }, [tasks])

  const displayError = DEMO_ENABLED && tasks.length === 0 ? null : error

  const save = useCallback(
    async (task: ScheduledTaskInput, id?: string) => {
      const saved = await api.saveScheduledTask(task, id)
      await refresh()
      return saved
    },
    [refresh],
  )

  const remove = useCallback(
    async (id: string) => {
      await api.deleteScheduledTask(id)
      await refresh()
    },
    [refresh],
  )

  const toggle = useCallback(
    async (id: string, enabled: boolean) => {
      await api.toggleScheduledTask(id, enabled)
      await refresh()
    },
    [refresh],
  )

  return {
    tasks: displayTasks,
    error: displayError,
    loading,
    refresh,
    save,
    remove,
    toggle,
  }
}
