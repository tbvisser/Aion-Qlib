import { Circle, CheckCircle2, Loader2, Lock } from 'lucide-react'
import type { TodoItem } from '@/types'

interface PlanPanelProps {
  todos: TodoItem[]
  locked?: boolean
}

export function PlanPanel({ todos, locked }: PlanPanelProps) {
  const sortedTodos = [...todos].sort((a, b) => a.position - b.position)

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3">
        <span className="text-sm font-semibold text-foreground">Plan</span>
        {locked && (
          <Lock className="h-3.5 w-3.5 text-muted-foreground" aria-label="System-controlled workflow" />
        )}
      </div>

      {/* Todo list */}
      <div className="flex-1 overflow-y-auto px-3 py-2">
        {sortedTodos.length === 0 ? (
          <div className="flex items-center justify-center h-20">
            <span className="text-xs text-muted-foreground">No plan yet</span>
          </div>
        ) : (
          <div className="space-y-1">
            {sortedTodos.map((todo, idx) => (
              <div
                key={`${todo.position}-${idx}`}
                className={`flex items-start gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors ${
                  todo.status === 'in_progress'
                    ? 'bg-primary/5 border border-primary/20'
                    : ''
                }`}
              >
                <div className="mt-0.5 shrink-0">
                  {todo.status === 'completed' ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                  ) : todo.status === 'in_progress' ? (
                    <Loader2 className="h-4 w-4 animate-spin text-primary" />
                  ) : (
                    <Circle className="h-4 w-4 text-muted-foreground/50" />
                  )}
                </div>
                <span
                  className={`leading-snug ${
                    todo.status === 'completed'
                      ? 'text-foreground/75'
                      : todo.status === 'in_progress'
                        ? 'text-foreground font-medium'
                        : 'text-muted-foreground'
                  }`}
                >
                  {todo.content}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
