import { useRef, useState } from 'react'
import { Plus, Paperclip, Zap, FileCheck, Gauge, Loader2, Lock, Check, X, SlidersHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { useModelConfig } from '@/features/rag/hooks/useModelConfig'
import { ModelConfigDialog } from './ModelConfigDialog'

export type ComposerMode = 'general' | 'contract_review' | null

const ACCEPTED_TYPES = [
  '.css',
  '.csv',
  '.doc',
  '.docx',
  '.gif',
  '.html',
  '.jpeg',
  '.jpg',
  '.js',
  '.jsx',
  '.json',
  '.log',
  '.md',
  '.pdf',
  '.png',
  '.ppt',
  '.pptx',
  '.py',
  '.rtf',
  '.sql',
  '.ts',
  '.tsx',
  '.tsv',
  '.txt',
  '.webp',
  '.xls',
  '.xlsm',
  '.xlsx',
  '.xml',
  '.yaml',
  '.yml',
].join(',')

// Shared metadata for the selectable modes — icon, copy, and the accent colors
// used by both the menu items and the active-mode chip.
const MODE_META = {
  general: {
    label: 'Deep mode',
    description: 'General-purpose agent',
    icon: Zap,
    iconColor: 'text-amber-500',
    dot: 'bg-amber-500',
    chip: 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  },
  contract_review: {
    label: 'Contract Review',
    description: 'Structured analysis workflow',
    icon: FileCheck,
    iconColor: 'text-blue-500',
    dot: 'bg-blue-500',
    chip: 'border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400',
  },
} as const

interface ComposerMenuProps {
  activeMode: ComposerMode
  onModeChange: (mode: ComposerMode) => void
  /** True once a harness run is committed to this thread — locks the harness in. */
  harnessLocked: boolean
  onUpload: (file: File) => void
  uploading?: boolean
  showContextStats?: boolean
  contextStatsOpen?: boolean
  onToggleContextStats?: () => void
  disabled?: boolean
  /** False when the host shows its own Deep Mode control (the composer toggle). */
  showDeepMode?: boolean
  /** Provided by hosts that own the model dialog themselves — the menu then
   *  only opens theirs instead of rendering a second one. */
  onOpenModelConfig?: () => void
  /** Overrides the trigger's shape, e.g. a flat square in the composer toolbar. */
  triggerClassName?: string
}

/**
 * The composer "+" pop-out menu. Consolidates Upload files, Deep Mode,
 * Contract Review, and Context statistics into a single trigger.
 */
export function ComposerMenu({
  activeMode,
  onModeChange,
  harnessLocked,
  onUpload,
  uploading,
  showContextStats,
  contextStatsOpen,
  onToggleContextStats,
  disabled,
  showDeepMode = true,
  onOpenModelConfig,
  triggerClassName,
}: ComposerMenuProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [modelDialogOpen, setModelDialogOpen] = useState(false)
  const [modelConfig] = useModelConfig()

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-selecting the same file
    if (file) onUpload(file)
  }

  const activeMeta = activeMode ? MODE_META[activeMode] : null
  const activeDots = [activeMeta?.dot].filter(Boolean) as string[]

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_TYPES}
        className="hidden"
        onChange={handleFileSelect}
      />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={disabled}
            aria-label="Add to chat"
            title="Add to chat"
            className={cn(
              'relative rounded-full h-9 w-9 text-muted-foreground hover:text-foreground transition-all duration-200 btn-press',
              triggerClassName,
            )}
          >
            {uploading ? <Loader2 className="h-5 w-5 animate-spin" /> : <Plus className="h-5 w-5" />}
            {activeDots.length > 0 && (
              <span className="absolute right-0.5 top-0.5 flex gap-0.5" aria-hidden="true">
                {activeDots.map((dotClass, index) => (
                  <span
                    key={`${dotClass}-${index}`}
                    className={cn(
                      'rounded-full',
                      activeDots.length > 1 ? 'h-1.5 w-1.5' : 'h-2 w-2',
                      dotClass,
                    )}
                  />
                ))}
              </span>
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" sideOffset={8} className="w-64">
          <DropdownMenuItem
            onSelect={() => {
              // Defer so the menu can close and return focus before the native
              // file dialog opens (avoids the picker being suppressed by Radix).
              window.setTimeout(() => inputRef.current?.click(), 0)
            }}
            disabled={uploading}
          >
            <Paperclip className="text-muted-foreground" />
            <div className="flex flex-col">
              <span className="font-medium">Upload files</span>
              <span className="text-xs text-muted-foreground">Bring a file into this chat's context</span>
            </div>
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          {showDeepMode && (
            <DropdownMenuItem
              onSelect={() => onModeChange(activeMode === 'general' ? null : 'general')}
              disabled={harnessLocked}
            >
              <Zap className={MODE_META.general.iconColor} />
              <div className="flex flex-col">
                <span className="font-medium">Deep mode</span>
                <span className="text-xs text-muted-foreground">{MODE_META.general.description}</span>
              </div>
              {activeMode === 'general' && <Check className="ml-auto h-4 w-4" />}
            </DropdownMenuItem>
          )}

          <DropdownMenuItem
            onSelect={(e) => {
              // Once a run is committed the harness is fixed for the thread — the
              // backend routes by the existing run and rejects a second one, so
              // keep the item visible/checked but non-interactive.
              if (harnessLocked) {
                e.preventDefault()
                return
              }
              onModeChange(activeMode === 'contract_review' ? null : 'contract_review')
            }}
          >
            <FileCheck className={MODE_META.contract_review.iconColor} />
            <div className="flex flex-col">
              <span className="font-medium">Contract Review</span>
              <span className="text-xs text-muted-foreground">
                {harnessLocked ? 'Active for this thread' : MODE_META.contract_review.description}
              </span>
            </div>
            {harnessLocked ? (
              <Lock className="ml-auto h-3.5 w-3.5 text-muted-foreground" />
            ) : (
              activeMode === 'contract_review' && <Check className="ml-auto h-4 w-4" />
            )}
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          <DropdownMenuItem
            data-testid="composer-model-item"
            onSelect={() => {
              // Defer so the dropdown closes / returns focus before the dialog opens.
              window.setTimeout(() => {
                if (onOpenModelConfig) onOpenModelConfig()
                else setModelDialogOpen(true)
              }, 0)
            }}
          >
            <SlidersHorizontal className="text-muted-foreground" />
            <div className="flex min-w-0 flex-col">
              <span className="font-medium">Model</span>
              <span className="truncate text-xs text-muted-foreground">
                {modelConfig.model || 'Server default'}
                {modelConfig.thinking ? ` · thinking ${modelConfig.reasoningEffort}` : ''}
              </span>
            </div>
          </DropdownMenuItem>

          {showContextStats && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => onToggleContextStats?.()}>
                <Gauge className="text-muted-foreground" />
                <span className="font-medium">{contextStatsOpen ? 'Hide' : 'Show'} context statistics</span>
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {!onOpenModelConfig && (
        <ModelConfigDialog open={modelDialogOpen} onOpenChange={setModelDialogOpen} />
      )}
    </>
  )
}

interface ActiveModeChipProps {
  activeMode: ComposerMode
  /** Committed harness — show a lock instead of a clear button. */
  locked: boolean
  onClear: () => void
}

/** Small pills shown above the composer indicating active composer options. */
export function ActiveModeChip({
  activeMode,
  locked,
  onClear,
}: ActiveModeChipProps) {
  if (!activeMode) return null
  const modeMeta = activeMode ? MODE_META[activeMode] : null
  const ModeIcon = modeMeta?.icon
  return (
    <div className="mb-2 flex flex-wrap items-center gap-2" data-testid="composer-active-chips">
      {modeMeta && ModeIcon && (
        <span
          data-testid="active-mode-chip"
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium',
            modeMeta.chip,
          )}
        >
          <ModeIcon className="h-3.5 w-3.5" />
          {modeMeta.label}
          {locked ? (
            <Lock className="h-3 w-3 opacity-70" aria-label="Locked for this thread" />
          ) : (
            <button
              type="button"
              onClick={onClear}
              aria-label={`Turn off ${modeMeta.label}`}
              className="ml-0.5 rounded-full p-0.5 transition-colors hover:bg-foreground/10"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </span>
      )}
    </div>
  )
}
