import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Copy, Loader2, ShieldAlert, ShieldCheck } from 'lucide-react'
import { checkCitations } from '@/features/rag/lib/api'
import { cn } from '@/lib/utils'
import type { AnswerCitation, CitationVerificationMode } from '@/features/rag/types'

interface MessageActionsProps {
  threadId: string
  /** Persisted message id (the assistant message's DB id). Required for citation checks. */
  messageId?: string
  /** Full message text to copy (citation tokens are stripped for readability). */
  content: string
  /** Whether this message has any citations to check. */
  hasCitations: boolean
  /** True once this message's citations have been graded (semantic-text mode). */
  citationsChecked: boolean
  /** Disable citation checking (e.g. while a stream is in flight). */
  disabled?: boolean
  onCitationsChecked: (
    citations: AnswerCitation[],
    mode: CitationVerificationMode | null,
  ) => void
}

// Drop {[S#]} / {[S1, S8]} citation tokens (and a leading space) so the copied
// text reads cleanly. Mirrors the backend/citationUtils alias pattern.
function stripCitationTokens(text: string): string {
  return text.replace(/ ?\{\s*\[?\s*S?\s*\d+\s*\]?(?:\s*,?\s*\[?\s*S?\s*\d+\s*\]?)*\s*\}/g, '')
}

function ActionButton({
  onClick,
  disabled,
  title,
  className,
  children,
}: {
  onClick: () => void
  disabled?: boolean
  title: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors',
        'hover:bg-accent/50 hover:text-foreground disabled:pointer-events-none disabled:opacity-50',
        '[&_svg]:h-3.5 [&_svg]:w-3.5',
        className,
      )}
    >
      {children}
    </button>
  )
}

export function MessageActions({
  threadId,
  messageId,
  content,
  hasCitations,
  citationsChecked,
  disabled,
  onCitationsChecked,
}: MessageActionsProps) {
  const [copied, setCopied] = useState(false)
  const [checking, setChecking] = useState(false)
  const [checkError, setCheckError] = useState<string | null>(null)
  const copyTimer = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
    }
  }, [])

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(stripCitationTokens(content).trim())
      setCopied(true)
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
      copyTimer.current = window.setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard can be blocked (insecure context / permissions); fail quietly.
    }
  }, [content])

  const handleCheck = useCallback(async () => {
    if (!messageId || checking) return
    setChecking(true)
    setCheckError(null)
    try {
      const result = await checkCitations(threadId, messageId)
      onCitationsChecked(result.citations, result.verification_mode)
    } catch (err) {
      setCheckError((err as Error).message || 'Citation check failed')
    } finally {
      setChecking(false)
    }
  }, [threadId, messageId, checking, onCitationsChecked])

  return (
    <div className="not-prose mt-1.5 flex items-center gap-0.5">
      <ActionButton
        onClick={handleCopy}
        title={copied ? 'Copied' : 'Copy message'}
      >
        {copied ? <Check className="text-primary" /> : <Copy />}
        <span>{copied ? 'Copied' : 'Copy'}</span>
      </ActionButton>

      {hasCitations && messageId && (
        <ActionButton
          onClick={handleCheck}
          disabled={disabled || checking}
          title={
            checkError
              ? checkError
              : citationsChecked
                ? 'Re-check that each citation is supported by its source'
                : 'Check that each citation is faithfully grounded in its source'
          }
          className={checkError ? 'text-destructive hover:text-destructive' : undefined}
        >
          {checking ? (
            <Loader2 className="animate-spin" />
          ) : checkError ? (
            <ShieldAlert />
          ) : (
            <ShieldCheck className={citationsChecked ? 'text-primary' : undefined} />
          )}
          <span>
            {checking
              ? 'Checking…'
              : checkError
                ? 'Retry check'
                : citationsChecked
                  ? 'Re-check citations'
                  : 'Check citations'}
          </span>
        </ActionButton>
      )}
    </div>
  )
}
