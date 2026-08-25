/**
 * Keycard-builder composer styled to match the main chat composer.
 *
 * This is a presentational wrapper: the host owns the message state and submit.
 * Voice input is visual-only for now; the model dropdown and Chat/Deep toggle
 * are wired to local state so the UI is complete, and the chosen model is sent
 * to the backend on each message.
 */
import { useEffect, useRef, useState } from 'react'
import {
  ArrowUp,
  AudioLines,
  ChevronDown,
  Mic,
  Plus,
  SlidersHorizontal,
  Square,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Textarea } from '@/components/ui/textarea'
import { ModelConfigDialog } from '@/features/rag/components/chat/ModelConfigDialog'
import { useModelConfig } from '@/features/rag/hooks/useModelConfig'
import { cn } from '@/lib/utils'

interface KeycardComposerProps {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  placeholder?: string
  disabled?: boolean
  streaming?: boolean
  onStop?: () => void
}

export function KeycardComposer({
  value,
  onChange,
  onSubmit,
  placeholder = 'Ask about the data, test a factor, or run a backtest',
  disabled = false,
  streaming = false,
  onStop,
}: KeycardComposerProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [modelDialogOpen, setModelDialogOpen] = useState(false)
  const [modelConfig] = useModelConfig()
  const [deepMode, setDeepMode] = useState(false)

  // Auto-resize the textarea to fit its content, capped at 50vh.
  useEffect(() => {
    const ta = inputRef.current
    if (!ta) return
    ta.style.height = 'auto'
    const cs = getComputedStyle(ta)
    const border =
      (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0)
    ta.style.height = `${ta.scrollHeight + border}px`
  }, [value])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      onSubmit()
    }
  }

  const canSend = value.trim().length > 0

  return (
    <>
      <div className="focus-glow rounded-2xl border border-border/50 bg-surface-2 transition-colors">
        <Textarea
          ref={inputRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          rows={1}
          className="min-h-[44px] max-h-[50vh] resize-none overflow-y-auto rounded-none border-0 bg-transparent px-4 pb-0 pt-3 text-base leading-6 shadow-none focus-visible:border-transparent focus-visible:ring-0"
        />

        <div className="flex items-center gap-2 px-2 pb-2 pt-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={disabled}
                aria-label="Add to chat"
                title="Add to chat"
                className="relative h-8 w-8 rounded-lg text-muted-foreground transition-all duration-200 hover:text-foreground"
              >
                <Plus className="h-5 w-5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="top" sideOffset={8} className="w-56">
              <DropdownMenuItem
                onSelect={() => window.setTimeout(() => setModelDialogOpen(true), 0)}
              >
                <SlidersHorizontal className="text-muted-foreground" />
                <div className="flex flex-col">
                  <span className="font-medium">Model</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {modelConfig.model || 'Server default'}
                  </span>
                </div>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <ModeToggle active={deepMode} onChange={setDeepMode} disabled={disabled} />

          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={() => setModelDialogOpen(true)}
              title="Model configuration"
              className="inline-flex max-w-[14rem] items-center gap-1 rounded-lg px-2 py-1 text-body-sm transition-colors hover:bg-surface-3"
            >
              <span className="truncate font-medium text-foreground/90">
                {modelConfig.model || 'Server default'}
              </span>
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            </button>

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

            {streaming && onStop ? (
              <Button
                type="button"
                variant="destructive"
                size="icon"
                onClick={onStop}
                aria-label="Stop generating"
                title="Stop generating"
                className="h-8 w-8 rounded-[10px] btn-press"
              >
                <Square className="h-3.5 w-3.5" />
              </Button>
            ) : canSend ? (
              <Button
                type="submit"
                size="icon"
                onClick={onSubmit}
                disabled={disabled}
                aria-label="Send message"
                className="h-8 w-8 rounded-[10px] bg-primary btn-press transition-all duration-200 hover:bg-primary/90"
              >
                <ArrowUp className="h-4 w-4" />
              </Button>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled
                aria-label="Voice mode"
                title="Voice — coming soon"
                className="h-8 w-8 rounded-lg text-muted-foreground/50 disabled:opacity-100"
              >
                <AudioLines className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      </div>

      <ModelConfigDialog open={modelDialogOpen} onOpenChange={setModelDialogOpen} />
    </>
  )
}

interface ModeToggleProps {
  active: boolean
  onChange: (active: boolean) => void
  disabled?: boolean
}

function ModeToggle({ active, onChange, disabled }: ModeToggleProps) {
  return (
    <div className="inline-flex items-center gap-0.5" role="group" aria-label="Chat mode">
      {([
        { label: 'Chat', value: false },
        { label: 'Deep', value: true },
      ] as const).map(({ label, value }) => (
        <button
          key={label}
          type="button"
          onClick={() => onChange(value)}
          disabled={disabled}
          aria-pressed={active === value}
          className={cn(
            'rounded-md px-2.5 py-1 text-body-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
            active === value
              ? 'bg-surface-3 text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {label}
        </button>
      ))}
    </div>
  )
}
