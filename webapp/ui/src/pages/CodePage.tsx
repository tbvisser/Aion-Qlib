import { useRef, useState } from 'react'
import { ChevronDown, Cloud, CornerDownLeft, Mic, Plus } from 'lucide-react'
import { AionMark } from '@/components/AionMark'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useAuth } from '@/hooks/useAuth'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { getFirstName } from '@/lib/greeting'
import { cn } from '@/lib/utils'

/**
 * The Code shell's home: a greeting and a composer, and nothing else.
 *
 * **There is no backend behind this yet.** Nothing here starts a session, and
 * the page says so rather than accepting a prompt into a void — the send
 * control is disabled and carries the reason. The environment, model and
 * edit-mode controls are real controls over real local state, so that wiring
 * them up later is a matter of handing their values to a request rather than
 * rebuilding the surface.
 *
 * Deliberately not built on `ComposerShell`: that one is the chat composer, and
 * it owns uploads, the Chat/Deep toggle, the harness lock and the RAG model
 * config — none of which a coding session shares. It borrows the same tokens
 * (`rounded-2xl`, `border-border/50`, `bg-surface-2`, `focus-glow`) so the two
 * read as one family without one pretending to be the other.
 */

const ENVIRONMENTS = [
  { value: 'default', label: 'Default' },
  { value: 'sandbox', label: 'Sandbox' },
]

const MODELS = [
  { value: 'claude-opus-5', label: 'Opus 5' },
  { value: 'claude-sonnet-5', label: 'Sonnet 5' },
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
]

const EFFORTS = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
]

const EDIT_MODES = [
  { value: 'accept', label: 'Accept edits' },
  { value: 'plan', label: 'Plan first' },
  { value: 'ask', label: 'Ask each time' },
]

export function CodePage() {
  useDocumentTitle('Code')
  const { user } = useAuth()
  const name = getFirstName(user?.email)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const [prompt, setPrompt] = useState('')
  const [environment, setEnvironment] = useState('default')
  const [model, setModel] = useState('claude-opus-5')
  const [effort, setEffort] = useState('high')
  const [editMode, setEditMode] = useState('accept')
  const [repo, setRepo] = useState<string | null>(null)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6">
        {/* `AionMark`, not a hardcoded mint SVG: it is mint on dark and ink on
            light, which is the rule the component exists to hold — mint on the
            cream background is what it was written to fix. */}
        <h1 className="flex items-center gap-2.5 pt-8 text-lg font-medium tracking-tight">
          <AionMark alt="" className="h-5" />
          What’s up next, {name}?
        </h1>
      </div>

      <div className="shrink-0 px-6 pb-6">
        <div className="mx-auto w-full max-w-3xl space-y-2">
          {/* Context chips: what the session would run against. */}
          <div className="flex items-center gap-2">
            <Picker
              value={environment}
              options={ENVIRONMENTS}
              onChange={setEnvironment}
              icon={Cloud}
              testId="code-environment"
            />
            <button
              type="button"
              data-testid="code-select-repo"
              onClick={() => setRepo(repo ? null : 'Aion-Qlib')}
              className="flex h-7 items-center gap-1 rounded-lg border border-border/50 px-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              <Plus className="h-3 w-3 shrink-0" />
              {repo ?? 'Select repo…'}
            </button>
          </div>

          <div className="focus-glow rounded-2xl border border-border/50 bg-surface-2 transition-colors">
            <Textarea
              ref={inputRef}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Describe a change, a bug, or a question about the codebase…"
              rows={1}
              className="min-h-[44px] max-h-[40vh] resize-none overflow-y-auto rounded-none border-0 bg-transparent px-4 pb-0 pt-3 text-base leading-6 shadow-none focus-visible:border-transparent focus-visible:ring-0"
            />

            <div className="flex items-center gap-2 px-2 pb-2 pt-1">
              <Picker
                value={editMode}
                options={EDIT_MODES}
                onChange={setEditMode}
                testId="code-edit-mode"
              />

              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled
                aria-label="Attach"
                title="Attachments — once the session backend is connected"
                className="h-8 w-8 rounded-lg text-muted-foreground/50 disabled:opacity-100"
              >
                <Plus className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled
                aria-label="Dictate"
                title="Voice — coming soon"
                className="h-8 w-8 rounded-lg text-muted-foreground/50 disabled:opacity-100"
              >
                <Mic className="h-4 w-4" />
              </Button>

              <div className="ml-auto flex items-center gap-1">
                <Picker value={model} options={MODELS} onChange={setModel} testId="code-model" />
                <Picker value={effort} options={EFFORTS} onChange={setEffort} testId="code-effort" />
                <Button
                  type="button"
                  size="icon"
                  disabled
                  aria-label="Start session"
                  title="Not connected yet — nothing would run"
                  className="h-8 w-8 rounded-lg"
                >
                  <CornerDownLeft className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>

          {/* One quiet line rather than a banner. The disabled send control says
              the same thing, but only to whoever thinks to hover it. */}
          <p className="text-center text-label text-muted-foreground/70">
            Coding sessions aren’t connected yet — the controls are live, nothing runs.
          </p>
        </div>
      </div>
    </div>
  )
}

/** A chip that opens a radio menu. The toolbar's one repeated shape. */
function Picker({
  value,
  options,
  onChange,
  icon: Icon,
  testId,
}: {
  value: string
  options: { value: string; label: string }[]
  onChange: (value: string) => void
  icon?: typeof Cloud
  testId?: string
}) {
  const current = options.find((option) => option.value === value)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-testid={testId}
        className={cn(
          'flex h-7 items-center gap-1 rounded-lg px-2 text-xs text-muted-foreground transition-colors',
          'hover:bg-surface-3 hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring/20',
        )}
      >
        {Icon && <Icon className="h-3 w-3 shrink-0" />}
        <span className="truncate">{current?.label ?? value}</span>
        <ChevronDown className="h-3 w-3 shrink-0" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          {options.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value} className="text-xs">
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
