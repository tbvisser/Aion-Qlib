/**
 * Bringing a strategy file back in.
 *
 * The builder could already show you the exact YAML `qrun` receives, and had no
 * way to accept one — so a strategy that left the app could not return, and a
 * file edited by hand had to be retyped through the form.
 *
 * Parsing happens on the server. The UI ships no YAML parser, and `StrategySpec`
 * is the authority on what a strategy is: a second, looser reading of the format
 * in TypeScript would accept files the engine then refuses, which is the same
 * class of split this whole change exists to close.
 *
 * Nothing is repaired on the way in. A file whose benchmark is not in its store
 * still loads, with that field marked and its ways out offered on the field
 * itself — see `CompatField`. The alternative, quietly rewriting the value to
 * the nearest valid one, changes what the reader asked for without asking.
 */
import { useCallback, useRef, useState } from 'react'
import { FileUp, Upload } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'
import { Notice } from '@/components/ui/notice'
import { api, type StrategyImport as Parsed, type StrategySpec } from '@/lib/api'
import { cn } from '@/lib/utils'

/** Anything larger is not a strategy; the server caps at 256 KB regardless. */
const MAX_BYTES = 262_144

export function StrategyImport({ onApply }: { onApply: (spec: StrategySpec) => void }) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [parsed, setParsed] = useState<Parsed | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  // Retires any parse still in flight: two fast drops must resolve to the
  // later one, and a dialog closed mid-parse must not repopulate itself.
  const parseSeq = useRef(0)

  const reset = useCallback(() => {
    parseSeq.current++
    setText(''); setParsed(null); setError(null); setDragging(false)
  }, [])

  const parse = useCallback(async (source: string) => {
    const mine = ++parseSeq.current
    setBusy(true)
    try {
      const result = await api.importStrategy(source)
      if (mine !== parseSeq.current) return
      setParsed(result)
      setError(null)
    } catch (e) {
      if (mine !== parseSeq.current) return
      setParsed(null)
      setError(e instanceof Error ? e.message : 'Could not read that file')
    } finally {
      if (mine === parseSeq.current) setBusy(false)
    }
  }, [])

  const take = useCallback(async (file: File) => {
    if (file.size > MAX_BYTES) {
      // Also retire any previous result: a size-rejected file must not leave
      // the last file's preview standing beside this one's error.
      parseSeq.current++
      setParsed(null)
      setError(`That file is ${Math.round(file.size / 1024)} KB. A strategy is a few.`)
      return
    }
    const source = await file.text()
    setText(source)
    void parse(source)
  }, [parse])

  const blocking = (parsed?.defects ?? []).filter((d) => d.severity === 'blocking')

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { setOpen(next); if (!next) reset() }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <FileUp className="h-4 w-4" />
          Import
        </Button>
      </DialogTrigger>

      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import a strategy</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div
            onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragging(false)
              const file = e.dataTransfer.files[0]
              if (file) void take(file)
            }}
            className={cn(
              'rounded-xl border border-dashed p-4 text-center transition-colors',
              dragging ? 'border-primary bg-primary/5' : 'border-border/60')}
          >
            <Upload className="mx-auto h-5 w-5 text-muted-foreground/70" />
            <p className="pt-1.5 text-xs text-muted-foreground">
              Drop a .yaml or .json strategy here, or{' '}
              <button
                type="button"
                className="text-primary hover:underline"
                onClick={() => fileInput.current?.click()}
              >
                choose a file
              </button>
            </p>
            <input
              ref={fileInput}
              type="file"
              accept=".yaml,.yml,.json,text/yaml,application/json"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) void take(file)
                // Cleared so choosing the same file twice fires again — a
                // reader who fixes the file and re-picks it expects a re-read.
                e.target.value = ''
              }}
            />
          </div>

          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={() => { if (text.trim()) void parse(text) }}
            rows={8}
            spellCheck={false}
            placeholder="…or paste the file here"
            className="w-full rounded-lg border border-border/50 bg-surface-2 p-2.5
                       font-mono text-label leading-relaxed"
          />

          {error && <Notice tone="destructive" icon={false}>{error}</Notice>}

          {parsed && (
            <div className="space-y-2 rounded-lg border border-border/50 p-3">
              <p className="text-sm font-medium">{parsed.spec.name}</p>

              {/* Said before the strategy opens, because after it opens these
                  fields look like ordinary values someone chose. */}
              {parsed.rejected.length > 0 && (
                <Notice tone="clay">
                  <p className="font-medium">
                    {parsed.rejected.length} field
                    {parsed.rejected.length === 1 ? '' : 's'} would not hold
                    {' '}their value and fell back to the default:
                  </p>
                  {parsed.rejected.map((r) => (
                    <p key={r.path}>
                      <span className="font-mono">{r.path}</span>
                      {' = '}
                      <span className="font-mono">{JSON.stringify(r.value)}</span>
                      {' — '}{r.message}
                    </p>
                  ))}
                </Notice>
              )}

              {parsed.unknown_fields.length > 0 && (
                <p className="text-label text-muted-foreground">
                  Ignored, not part of a strategy:{' '}
                  <span className="font-mono">{parsed.unknown_fields.join(', ')}</span>
                </p>
              )}

              {blocking.length > 0 ? (
                <Notice tone="clay">
                  <p className="font-medium">
                    {blocking.length} field{blocking.length === 1 ? '' : 's'} will
                    {' '}need attention. Nothing has been changed — open it and each
                    {' '}one will offer the choices that resolve it.
                  </p>
                  {blocking.map((d) => (
                    <p key={d.path}>
                      <span className="font-mono">{d.path}</span> — {d.message}
                    </p>
                  ))}
                </Notice>
              ) : (
                <p className="text-label text-muted-foreground">
                  Everything resolves against this machine. Ready to run.
                </p>
              )}
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              size="sm"
              disabled={!parsed || busy}
              onClick={() => {
                if (!parsed) return
                onApply(parsed.spec)
                setOpen(false)
                reset()
              }}
            >
              Open in the builder
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
