import { useState } from 'react'
import { Sparkles, RefreshCw, AlertCircle } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { Button } from '@/components/ui/button'
import { Panel } from '@/components/ui/panel'
import { Segmented, type SegmentedOption } from '@/components/ui/segmented'
import { useAgendaOutlook } from '@/hooks/useAgendaOutlook'
import { OUTLOOK_SCOPES, outlookScopeLabel, outlookWindowLabel, type OutlookScope } from '@/lib/agendaOutlook'
import { cn } from '@/lib/utils'

const SCOPE_OPTIONS: readonly SegmentedOption<OutlookScope>[] = OUTLOOK_SCOPES.map((s) => ({
  value: s,
  label: outlookScopeLabel(s),
}))

/**
 * AI-generated briefing for the selected day, its week, or its month.
 *
 * The panel owns the scope switch; the page just provides the anchor day.
 * Markdown lets the model produce bullets and bold emphasis without the UI
 * having to guess at structure.
 */
export function OutlookPanel({ anchor }: { anchor: string }) {
  const [scope, setScope] = useState<OutlookScope>('week')
  const { data, loading, error, regenerate } = useAgendaOutlook(scope, anchor)

  return (
    <Panel
      title="Outlook"
      hint={outlookWindowLabel(scope, anchor)}
      className="relative"
      bodyClassName="p-0"
      data-testid="outlook-panel"
      actions={
        <div className="flex items-center gap-2">
          <Segmented
            value={scope}
            options={SCOPE_OPTIONS}
            onChange={setScope}
            size="sm"
            data-testid="outlook-scope"
          />
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 px-2 text-[11px] text-muted-foreground hover:text-foreground"
            onClick={() => void regenerate()}
            disabled={loading}
            data-testid="outlook-regenerate"
          >
            <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} />
            Regenerate
          </Button>
        </div>
      }
    >
      <div className="relative min-h-[8rem]">
        <div
          className={cn(
            'pointer-events-none absolute inset-0 flex items-center justify-center transition-opacity',
            loading ? 'opacity-100' : 'opacity-0',
          )}
          aria-hidden={!loading}
        >
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Sparkles className="h-3.5 w-3.5 animate-pulse" />
            Generating outlook…
          </div>
        </div>

        <div className={cn('transition-opacity', loading && 'opacity-40')}>
          {error ? (
            <div className="flex flex-col gap-2 px-3 py-3">
              <div className="flex items-start gap-2 text-xs text-destructive">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{error}</span>
              </div>
              <div>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1.5 text-xs"
                  onClick={() => void regenerate()}
                  disabled={loading}
                  data-testid="outlook-retry"
                >
                  <RefreshCw className="h-3 w-3" />
                  Try again
                </Button>
              </div>
            </div>
          ) : (
            <div className="prose prose-sm max-w-none px-3 py-3 dark:prose-invert">
              {data ? (
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{data.summary}</ReactMarkdown>
              ) : (
                <div className="flex flex-col gap-2">
                  <p className="text-xs text-muted-foreground">
                    No outlook generated for this {scope} yet.
                  </p>
                  <div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 gap-1.5 text-xs"
                      onClick={() => void regenerate()}
                      disabled={loading}
                      data-testid="outlook-generate"
                    >
                      <Sparkles className="h-3 w-3" />
                      Generate outlook
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {data && (
          <p className="border-t border-border/30 px-3 py-1.5 text-[10px] text-muted-foreground/60">
            {data.cached ? 'Served from cache' : 'Generated just now'}
            {' · '}
            {new Date(data.generated_at).toLocaleString(undefined, {
              month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
            })}
          </p>
        )}
      </div>
    </Panel>
  )
}
