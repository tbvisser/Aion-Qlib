import { FileText, Heading2, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { DocumentStructure, DocumentStructureNode } from '@/features/rag/lib/api'

interface DocumentStructureNavProps {
  structure: DocumentStructure | null
  loading: boolean
  activeNodeId: string | null
  onSelectNode: (node: DocumentStructureNode) => void
}

export function DocumentStructureNav({
  structure,
  loading,
  activeNodeId,
  onSelectNode,
}: DocumentStructureNavProps) {
  const nodes = structure?.nodes ?? []

  return (
    <aside
      className="hidden md:flex w-56 shrink-0 flex-col border-r border-border/50 bg-background/40"
      data-testid="document-structure-nav"
    >
      <div className="flex h-12 items-center border-b border-border/50 px-3">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Contents
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto py-2">
        {loading ? (
          <div className="flex h-24 items-center justify-center">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : nodes.length > 0 ? (
          <div className="space-y-0.5 px-2">
            {nodes.map(node => {
              const Icon = node.kind === 'page' ? FileText : Heading2
              const active = activeNodeId === node.id
              const indent = Math.max(0, Math.min((node.level || 1) - 1, 5)) * 10
              return (
                <button
                  key={node.id}
                  type="button"
                  onClick={() => onSelectNode(node)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
                    active
                      ? 'bg-primary/10 text-primary'
                      : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                  )}
                  style={{ paddingLeft: `${8 + indent}px` }}
                  title={node.title}
                  aria-label={`Jump to ${node.title}`}
                  data-testid={`document-structure-node-${node.id}`}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{node.title}</span>
                </button>
              )
            })}
          </div>
        ) : (
          <div className="px-4 py-5 text-xs leading-relaxed text-muted-foreground">
            Rendered structure is unavailable for this document. Re-upload it to generate page anchors.
          </div>
        )}
      </div>
    </aside>
  )
}
