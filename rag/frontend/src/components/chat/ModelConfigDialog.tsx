import { useEffect, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useModelConfig, type ReasoningEffort } from '@/hooks/useModelConfig'
import { getAvailableModels } from '@/lib/api'

const EFFORTS: ReasoningEffort[] = ['low', 'medium', 'high']

interface ModelConfigDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * Composer "Model" dialog — set the model name and thinking (reasoning) options.
 * Edits a local draft seeded from the persisted config each time it opens, so
 * Cancel discards and Save commits to the global {@link useModelConfig} store.
 */
export function ModelConfigDialog({ open, onOpenChange }: ModelConfigDialogProps) {
  const [config, updateConfig] = useModelConfig()
  const [model, setModel] = useState(config.model)
  const [thinking, setThinking] = useState(config.thinking)
  const [effort, setEffort] = useState<ReasoningEffort>(config.reasoningEffort)

  const [models, setModels] = useState<string[]>([])
  const [provider, setProvider] = useState('')
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelsError, setModelsError] = useState(false)

  // On open: re-seed the draft from the persisted config and load the provider's
  // model list for the dropdown (cached client-side + server-side).
  useEffect(() => {
    if (!open) return
    setModel(config.model)
    setThinking(config.thinking)
    setEffort(config.reasoningEffort)

    let cancelled = false
    setModelsLoading(true)
    setModelsError(false)
    getAvailableModels()
      .then((res) => {
        if (cancelled) return
        setModels(res.models.map((m) => m.id))
        setProvider(res.provider)
        setModelsError(Boolean(res.error))
      })
      .catch(() => {
        if (!cancelled) setModelsError(true)
      })
      .finally(() => {
        if (!cancelled) setModelsLoading(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const handleSave = () => {
    updateConfig({ model: model.trim(), thinking, reasoningEffort: effort })
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Model configuration</DialogTitle>
          <DialogDescription>
            Choose the model used for new messages. Leave the name blank to use the server default.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="model-name">Model name</Label>
            <Input
              id="model-name"
              list="model-options"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={modelsLoading ? 'Loading models…' : 'Search models or type a name — blank = server default'}
              autoComplete="off"
              spellCheck={false}
            />
            <datalist id="model-options">
              {models.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
            <p className="text-xs text-muted-foreground">
              {modelsLoading
                ? 'Loading available models…'
                : modelsError
                  ? 'Couldn’t load the model list — type a model name manually. The API key stays server-side.'
                  : models.length > 0
                    ? `${models.length} ${provider} model${models.length === 1 ? '' : 's'} available — pick one or type a custom name. Blank = server default.`
                    : 'Type a model name, or leave blank to use the server default.'}
            </p>
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label htmlFor="thinking-toggle">Thinking</Label>
              <p className="text-xs text-muted-foreground">Enable reasoning for models that support it.</p>
            </div>
            <Switch id="thinking-toggle" checked={thinking} onCheckedChange={setThinking} />
          </div>

          {thinking && (
            <div className="space-y-1.5">
              <Label>Reasoning effort</Label>
              <div className="inline-flex rounded-lg border border-border/60 p-0.5">
                {EFFORTS.map((e) => (
                  <button
                    key={e}
                    type="button"
                    data-testid={`model-effort-${e}`}
                    onClick={() => setEffort(e)}
                    aria-pressed={effort === e}
                    className={cn(
                      'rounded-md px-3 py-1 text-sm capitalize transition-colors',
                      effort === e
                        ? 'bg-primary text-primary-foreground'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {e}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" data-testid="model-config-save" onClick={handleSave}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
