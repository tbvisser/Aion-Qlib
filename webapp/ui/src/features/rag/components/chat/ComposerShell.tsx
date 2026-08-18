import { useEffect, useState, type ReactNode, type RefObject } from 'react'
import { ArrowUp, AudioLines, ChevronDown, Mic, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { ComposerMenu, type ComposerMode } from './ComposerMenu'
import { ModelConfigDialog } from './ModelConfigDialog'
import { useModelConfig } from '@/features/rag/hooks/useModelConfig'
import { cn } from '@/lib/utils'

interface ComposerShellProps {
  value: string
  onChange: (value: string) => void
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  onPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void
  placeholder: string
  disabled: boolean
  inputRef: RefObject<HTMLTextAreaElement>
  /** Pending-attachment tray, rendered inside the card above the text. */
  attachmentsSlot?: ReactNode
  activeMode: ComposerMode
  onModeChange: (mode: ComposerMode) => void
  /** True once a harness run is committed to this thread — locks the mode in. */
  harnessLocked: boolean
  onUpload: (file: File) => void
  uploading?: boolean
  showContextStats?: boolean
  contextStatsOpen?: boolean
  onToggleContextStats?: () => void
  /** There is something to send — a trimmed message or an attachment. */
  canSend: boolean
  /** A reply is streaming; with `onStop`, the send button becomes Stop. */
  sending?: boolean
  onStop?: () => void
}

/**
 * The chat composer: a two-row card with the text on top and a toolbar
 * underneath holding the "+" menu, the Chat/Deep toggle, the model control and
 * the send button. Presentational only — the caller owns the form, the state
 * and the submit handler.
 */
export function ComposerShell({
  value,
  onChange,
  onKeyDown,
  onPaste,
  placeholder,
  disabled,
  inputRef,
  attachmentsSlot,
  activeMode,
  onModeChange,
  harnessLocked,
  onUpload,
  uploading,
  showContextStats,
  contextStatsOpen,
  onToggleContextStats,
  canSend,
  sending,
  onStop,
}: ComposerShellProps) {
  const [modelDialogOpen, setModelDialogOpen] = useState(false)
  const [modelConfig] = useModelConfig()

  // Auto-resize the textarea to fit its content, capped at 50vh. Add the border
  // height because Tailwind uses box-sizing: border-box, so height = scrollHeight
  // (padding + content only) would clip the box and trigger a 1-2px scrollbar.
  useEffect(() => {
    const ta = inputRef.current
    if (!ta) return
    ta.style.height = 'auto'
    const cs = getComputedStyle(ta)
    const border = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0)
    ta.style.height = `${ta.scrollHeight + border}px`
  }, [value, inputRef])

  return (
    <>
      <div className="focus-glow rounded-2xl border border-border/50 bg-surface-2 transition-colors">
        {attachmentsSlot}

        <Textarea
          ref={inputRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onPaste={onPaste}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          rows={1}
          className="min-h-[44px] max-h-[50vh] resize-none overflow-y-auto rounded-none border-0 bg-transparent px-4 pb-0 pt-3 text-base leading-6 shadow-none focus-visible:border-transparent focus-visible:ring-0"
        />

        <div className="flex items-center gap-2 px-2 pb-2 pt-1">
          <ComposerMenu
            activeMode={activeMode}
            onModeChange={onModeChange}
            harnessLocked={harnessLocked}
            onUpload={onUpload}
            uploading={uploading}
            showContextStats={showContextStats}
            contextStatsOpen={contextStatsOpen}
            onToggleContextStats={onToggleContextStats}
            disabled={disabled}
            showDeepMode={false}
            onOpenModelConfig={() => setModelDialogOpen(true)}
            triggerClassName="h-8 w-8 rounded-lg"
          />

          <ModeToggle
            activeMode={activeMode}
            onModeChange={onModeChange}
            harnessLocked={harnessLocked}
          />

          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={() => setModelDialogOpen(true)}
              title="Model configuration"
              className="inline-flex max-w-[14rem] items-center gap-1 rounded-lg px-2 py-1 text-[13px] transition-colors hover:bg-surface-3"
            >
              <span className="truncate font-medium text-foreground/90">
                {modelConfig.model || 'Server default'}
              </span>
              {modelConfig.thinking && (
                <span className="capitalize text-muted-foreground">{modelConfig.reasoningEffort}</span>
              )}
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

            {sending && onStop ? (
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
                aria-label="Send message"
                disabled={disabled}
                className="h-8 w-8 rounded-[10px] bg-primary btn-press transition-all duration-200 hover:bg-primary/90"
              >
                <ArrowUp className="h-4 w-4" />
              </Button>
            ) : (
              // Empty composer: the send slot holds the voice control, which
              // becomes the send button on the first keystroke.
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
  activeMode: ComposerMode
  onModeChange: (mode: ComposerMode) => void
  harnessLocked: boolean
}

/**
 * Chat / Deep segmented control. Contract Review is left to the "+" menu — it
 * announces itself through the chip above the composer, and while it is active
 * `Chat` stays lit since Deep Mode is off.
 */
function ModeToggle({ activeMode, onModeChange, harnessLocked }: ModeToggleProps) {
  const deepActive = activeMode === 'general'

  return (
    <div className="inline-flex items-center gap-0.5" role="group" aria-label="Chat mode">
      {([
        { label: 'Chat', mode: null, active: !deepActive },
        { label: 'Deep', mode: 'general', active: deepActive },
      ] as const).map(({ label, mode, active }) => (
        <button
          key={label}
          type="button"
          onClick={() => onModeChange(mode)}
          disabled={harnessLocked}
          aria-pressed={active}
          className={cn(
            'rounded-md px-2.5 py-1 text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
            active
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
