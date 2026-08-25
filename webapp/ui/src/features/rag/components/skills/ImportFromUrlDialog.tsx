import { useState } from 'react'
import { Globe } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

interface ImportFromUrlDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Performs the import. Resolve on success (dialog closes); throw to show the error inline. */
  onSubmit: (source: string) => Promise<void>
}

export function ImportFromUrlDialog({ open, onOpenChange, onSubmit }: ImportFromUrlDialogProps) {
  const [source, setSource] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleOpenChange = (next: boolean) => {
    if (submitting) return
    if (!next) {
      setSource('')
      setError(null)
    }
    onOpenChange(next)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = source.trim()
    if (!trimmed) {
      setError('Paste a skill URL or command')
      return
    }
    setError(null)
    setSubmitting(true)
    try {
      await onSubmit(trimmed)
      setSource('')
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Globe className="h-4 w-4" />
            Import Skill from URL
          </DialogTitle>
          <DialogDescription>
            Install a skill from a public GitHub repo or the skills.sh registry.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Input
              autoFocus
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="https://www.skills.sh/anthropics/skills/docx"
              spellCheck={false}
            />
            <div className="text-xs text-muted-foreground space-y-1">
              <p>Accepts any of:</p>
              <ul className="list-disc pl-4 space-y-0.5 font-mono text-label">
                <li>https://www.skills.sh/anthropics/skills/docx</li>
                <li>https://github.com/anthropics/skills/tree/main/document-skills/docx</li>
                <li>npx skills add https://github.com/anthropics/skills --skill docx</li>
                <li>anthropics/skills/docx</li>
              </ul>
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            Bundled scripts that rely on external tools (e.g. pandoc) may not run in the
            Python-only sandbox, but instructions and reference files import fully.
          </p>

          {error && (
            <div className="rounded-lg bg-destructive/10 border border-destructive/20 px-3 py-2">
              <p className="text-sm text-destructive">{error}</p>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? 'Importing…' : 'Import'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
