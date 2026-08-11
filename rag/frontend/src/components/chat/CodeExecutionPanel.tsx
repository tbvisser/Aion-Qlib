import { useState } from 'react'
import { AlertCircle, Check, ChevronDown, Clock, Download, FileText, Loader2, Terminal } from 'lucide-react'
import type { CodeExecutionState, CodeExecutionFile } from '@/types'

interface CodeExecutionPanelProps {
  state: CodeExecutionState
  onFileClick?: (filename: string) => void
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}

function languageLabel(language: string): string {
  return (language || 'python').toUpperCase()
}

function HeaderStatus({ status }: { status: CodeExecutionState['status'] }) {
  if (status === 'running') {
    return (
      <span className="flex items-center gap-2 text-xs font-medium text-primary">
        <span>Running</span>
        <span className="flex h-5 w-5 items-center justify-center">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        </span>
      </span>
    )
  }

  if (status === 'error') {
    return (
      <span className="flex items-center gap-2 text-xs font-medium text-red-400">
        <span>Error</span>
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-red-500/15">
          <AlertCircle className="h-3 w-3" />
        </span>
      </span>
    )
  }

  return (
    <span className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
      <span>Complete</span>
      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500/15">
        <Check className="h-3 w-3 text-emerald-400" />
      </span>
    </span>
  )
}

function FileChip({ file, onFileClick }: { file: CodeExecutionFile; onFileClick?: (filename: string) => void }) {
  const content = (
    <>
      {file.error ? (
        <AlertCircle className="h-3.5 w-3.5 shrink-0 text-red-400" />
      ) : (
        <FileText className="h-3.5 w-3.5 shrink-0 text-primary" />
      )}
      <span className={`min-w-0 flex-1 truncate text-left font-semibold ${file.error ? 'text-red-300' : 'text-foreground'}`}>
        {file.filename}
      </span>
      <span className="shrink-0 text-muted-foreground">{file.error ? 'Failed' : formatBytes(file.file_size)}</span>
      {!onFileClick && !file.error && <Download className="h-3 w-3 shrink-0 text-muted-foreground" />}
    </>
  )

  if (file.error) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs">
        {content}
      </div>
    )
  }

  if (onFileClick) {
    return (
      <button
        type="button"
        onClick={() => onFileClick(file.filename)}
        className="flex w-full items-center gap-2 rounded-lg border border-border/50 bg-background/35 px-3 py-2 text-xs transition-colors hover:bg-muted/40 dark:border-[#2E2E2E] dark:bg-[#1A1A1A]"
      >
        {content}
      </button>
    )
  }

  return (
    <a
      href={file.download_url}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-2 rounded-lg border border-border/50 bg-background/35 px-3 py-2 text-xs transition-colors hover:bg-muted/40 dark:border-[#2E2E2E] dark:bg-[#1A1A1A]"
    >
      {content}
    </a>
  )
}

function CodeBlock({ language, code }: { language: string; code: string }) {
  const lineCount = code ? code.split('\n').length : 0

  return (
    <div className="overflow-hidden rounded-[10px] border border-border/50 bg-background/70 dark:border-[#212121] dark:bg-[#121212]">
      <div className="flex items-center justify-between border-b border-border/50 bg-muted/30 px-3 py-2 dark:border-[#212121] dark:bg-[#161616]">
        <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {languageLabel(language)}
        </span>
        <span className="font-mono text-[10px] text-muted-foreground">
          {lineCount} line{lineCount === 1 ? '' : 's'}
        </span>
      </div>
      <pre className="max-h-72 overflow-auto px-3 py-3 font-mono text-[12.5px] leading-relaxed text-foreground/90 whitespace-pre-wrap">
        {code}
      </pre>
    </div>
  )
}

function OutputBlock({ label, content, tone }: { label: string; content: string; tone: 'stdout' | 'stderr' }) {
  return (
    <div className="overflow-hidden rounded-[10px] border border-border/50 bg-background/70 dark:border-[#212121] dark:bg-[#161616]">
      <div className="border-b border-border/50 px-3 py-2 dark:border-[#212121]">
        <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
      </div>
      <pre className={`max-h-48 overflow-auto px-3 py-3 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap ${tone === 'stdout' ? 'text-emerald-300' : 'text-red-300'}`}>
        {content}
      </pre>
    </div>
  )
}

export function CodeExecutionPanel({ state, onFileClick }: CodeExecutionPanelProps) {
  const [expanded, setExpanded] = useState(true)

  const hasOutput = !!(state.stdout || state.stderr)
  const hasFiles = state.files.length > 0
  const hasContent = !!(state.summary || state.codePreview || hasOutput || hasFiles || state.error)
  const duration = state.executionTimeMs !== undefined && state.status !== 'running'
    ? `${(state.executionTimeMs / 1000).toFixed(1)}s`
    : null

  return (
    <div className="overflow-hidden rounded-[14px] border border-border/60 bg-surface-2/80 animate-fade-in dark:border-[#2E2E2E] dark:bg-[#1D1D1D]">
      <button
        type="button"
        onClick={() => hasContent && setExpanded(!expanded)}
        className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/30 dark:hover:bg-[#262626]/70 ${!hasContent ? 'cursor-default' : ''}`}
        aria-expanded={expanded}
      >
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground dark:bg-[#303030] dark:text-[#C8CBD0]">
          <Terminal className="h-4 w-4" />
        </span>
        <span className="min-w-0 truncate text-[14.5px] font-semibold text-foreground">Run Code</span>
        <span className="rounded border border-primary/20 bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-primary">
          {languageLabel(state.language)}
        </span>
        <span className="flex-1" />
        {duration && (
          <span className="flex items-center gap-1 font-mono text-[11px] text-muted-foreground">
            <Clock className="h-3 w-3" />
            {duration}
          </span>
        )}
        <HeaderStatus status={state.status} />
        {hasContent && (
          <ChevronDown className={`h-3.5 w-3.5 text-muted-foreground/70 transition-transform ${expanded ? '' : '-rotate-90'}`} />
        )}
      </button>

      {expanded && hasContent && (
        <div className="space-y-3 px-4 pb-4 animate-fade-in">
          {state.summary && (
            <p className="text-[13.5px] leading-relaxed text-foreground/90">{state.summary}</p>
          )}

          {state.codePreview && (
            <CodeBlock language={state.language} code={state.codePreview} />
          )}

          {state.stdout && <OutputBlock label="Output" content={state.stdout} tone="stdout" />}
          {state.stderr && <OutputBlock label="Error Output" content={state.stderr} tone="stderr" />}

          {state.error && (
            <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-300">
              {state.error}
            </div>
          )}

          {hasFiles && (
            <div className="space-y-2">
              {state.files.map((file, idx) => (
                <FileChip key={`${file.filename}-${idx}`} file={file} onFileClick={onFileClick} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
