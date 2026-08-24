/**
 * Stage 01 — the user's plain-language objective for the AI assistant.
 *
 * This field does not change the backtest config; it is guidance that the
 * builder assistant reads on every turn so proposals stay aligned with what the
 * user is trying to achieve.
 */
import { Section } from '@/components/builder/FormControls'
import { Textarea } from '@/components/ui/textarea'
import type { InspectorProps } from './types'

const MAX_LENGTH = 2000

export function ContextInspector({ spec, setSpec }: InspectorProps) {
  return (
    <Section title="Objective" columns={1}>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Describe what you want this strategy to achieve. The assistant uses this
        as its primary guide when proposing changes.
      </p>
      <Textarea
        value={spec.context}
        onChange={(e) => {
          const context = e.target.value.slice(0, MAX_LENGTH)
          setSpec((prev) => ({ ...prev, context }))
        }}
        placeholder="e.g. Lower volatility than the benchmark, with a turnover budget of one round-trip per month."
        className="min-h-[120px] resize-y text-[13px]"
      />
      <div className="flex justify-end">
        <span className="text-[10px] text-muted-foreground/70">
          {spec.context.length}/{MAX_LENGTH}
        </span>
      </div>
    </Section>
  )
}
