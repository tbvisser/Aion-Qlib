/**
 * The right rail: what the selected card is, and every edit that is awkward on
 * the card itself.
 *
 * The one that earns its place is **Replace operator**. Rebuilding
 * `Mean($close,20)` as `Std($close,20)` by hand means deleting a card, adding
 * another and rewiring its child; as a swap it is one click, because the slots
 * line up by position and `tree.ts` keeps the children.
 */
import { Trash2, Unlink } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Field, Section } from '@/components/builder/FormControls'
import { serializeNode } from '@/lib/factorExpr/serialize'
import { seriesSlots } from '@/lib/factorExpr/tree'
import type { ExprNode, OperatorRegistry } from '@/lib/factorExpr/types'
import type { ExpressionEditor } from '@/hooks/useFeatureSet'
import { cn } from '@/lib/utils'

interface Props {
  node: ExprNode | null
  registry: OperatorRegistry
  fields: string[]
  editor: ExpressionEditor
  isRoot: boolean
}

/**
 * With nothing selected the rail shows the *column*, not a placeholder. The
 * name lives there because it is the field most likely to be wrong invisibly.
 */
export function NodeInspector({ node, empty, ...rest }: Props & { empty: React.ReactNode }) {
  return (
    <div className="min-h-0 w-72 shrink-0 overflow-y-auto border-l border-border/50 p-4">
      {node === null ? empty : <Selected node={node} {...rest} />}
    </div>
  )
}

function Selected({ node, registry, fields, editor, isRoot }: Props & { node: ExprNode }) {
  const spec = node.kind === 'call' ? registry[node.op] : undefined
  const title = node.kind === 'field' ? `$${node.name}`
    : node.kind === 'const' ? String(node.value)
      : spec?.name ?? node.op

  /** Same arity and the same slot kinds: a swap that cannot lose a child. */
  const swappable = spec
    ? Object.values(registry).filter((other) =>
      other.name !== spec.name
      && other.slots.length === spec.slots.length
      && other.slots.every((s, i) => s.kind === spec.slots[i].kind))
    : []

  return (
    <div className="space-y-4">
      <div>
        <div className="font-mono text-sm font-medium">{title}</div>
        {spec && <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{spec.summary}</p>}
      </div>

      <Field label="Renders as">
        <code className="block break-all rounded-lg bg-surface-2 p-2 font-mono text-[11px] leading-relaxed">
          {serializeNode(node, registry)}
        </code>
      </Field>

      {node.kind === 'call' && spec && (
        <Section title="Inputs">
          {seriesSlots(node, registry).map((slot) => {
            const child = node.args[slot]
            const label = spec.slots.find((s) => s.name === slot)?.label ?? slot
            return (
              <Field key={slot} label={label} className="sm:col-span-2">
                <div className="flex items-center gap-2">
                  <code
                    className={cn(
                      'min-w-0 flex-1 truncate rounded-md border border-border/50 bg-surface-2 px-2 py-1.5 font-mono text-[11px]',
                      !child && 'border-dashed border-clay/40 text-clay',
                    )}
                  >
                    {child ? serializeNode(child, registry) : 'empty'}
                  </code>
                  {child && (
                    <Button
                      variant="ghost"
                      size="sm"
                      title="Detach"
                      onClick={() => editor.detach(node.id, slot)}
                    >
                      <Unlink className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </Field>
            )
          })}
        </Section>
      )}

      {node.kind === 'field' && (
        <Section title="Column">
          <div className="flex flex-wrap gap-1 sm:col-span-2">
            {fields.map((name) => (
              <button
                key={name}
                onClick={() => editor.setField(node.id, name)}
                className={cn(
                  'rounded-md border px-2 py-1 font-mono text-[11px] transition-colors',
                  name === node.name
                    ? 'border-primary/40 bg-foreground/[0.07]'
                    : 'border-border/50 hover:bg-foreground/[0.04]',
                )}
              >
                ${name}
              </button>
            ))}
          </div>
        </Section>
      )}

      {swappable.length > 0 && spec && (
        <Section title="Replace operator" >
          <div className="flex flex-wrap gap-1 sm:col-span-2">
            {swappable.map((other) => (
              <button
                key={other.name}
                title={other.summary}
                onClick={() => editor.replaceOp(node.id, other)}
                className="rounded-md border border-border/50 px-2 py-1 font-mono text-[11px] transition-colors hover:bg-foreground/[0.04]"
              >
                {other.symbol ?? other.name}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground sm:col-span-2">
            Same shape, so the inputs stay where they are.
          </p>
        </Section>
      )}

      <Button
        variant="outline"
        size="sm"
        className="w-full"
        disabled={isRoot}
        title={isRoot ? 'The output card cannot be removed' : undefined}
        onClick={() => editor.remove(node.id)}
      >
        <Trash2 className="h-4 w-4" />
        Remove card
      </Button>
    </div>
  )
}
