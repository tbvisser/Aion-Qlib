import {
  Download,
  LayoutTemplate,
  MoreHorizontal,
  Play,
  Save,
  Share2,
  Trash2,
  Upload,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import type { KeycardDefect, KeycardSpec } from '@/lib/api'
import { firstBlockedNodeId } from '@/lib/keycardGraph/keycardFlow'

interface Props {
  spec: KeycardSpec
  currentId?: string
  dirty: boolean
  busy: boolean
  defects: KeycardDefect[]
  onNameChange: (name: string) => void
  onSave: () => void
  onRun: () => void
  onImport: () => void
  onExport: () => void
  onDelete: () => void
  onAutoLayout: () => void
  /** Select the node the first blocking defect is about, so the chip leads somewhere. */
  onFocusBlocked?: (nodeId: string) => void
}

export function KeycardToolbar({
  spec,
  currentId,
  dirty,
  busy,
  defects,
  onNameChange,
  onSave,
  onRun,
  onImport,
  onExport,
  onDelete,
  onAutoLayout,
  onFocusBlocked,
}: Props) {
  const blocking = defects.filter((d) => d.severity === 'blocking')
  // The node behind the first blocker, when it is about one. The strategy
  // builder's chip jumps to the first blocked stage; this is the same gesture.
  const firstBlockedNode = firstBlockedNodeId(defects)

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex items-center gap-3 border-b border-border/50 bg-card px-4 py-2">
        <Input
          value={spec.name}
          onChange={(e) => onNameChange(e.target.value)}
          className="h-8 w-64 text-sm font-semibold"
          placeholder="Keycard name"
        />

        <div className="flex items-center gap-1.5">
          {dirty && (
            <Badge variant="outline" font="sans" className="text-micro">unsaved</Badge>
          )}
          {blocking.length > 0 && (
            // A button, not an inert label: the strategy builder's chip jumps
            // to the problem, and its title carries the sentences the count
            // cannot.
            <button
              type="button"
              title={blocking.map((d) => d.message).join('\n')}
              onClick={() => {
                if (firstBlockedNode && onFocusBlocked) onFocusBlocked(firstBlockedNode)
              }}
              className={firstBlockedNode && onFocusBlocked ? undefined : 'cursor-default'}
            >
              <Badge variant="clay" font="sans" className="text-micro">
                {blocking.length} blocking
              </Badge>
            </button>
          )}
        </div>

        <div className="ml-auto flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 w-8 px-0 [&_svg]:size-3.5"
                onClick={onAutoLayout}
                disabled={busy}
              >
                <LayoutTemplate className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Auto layout</TooltipContent>
          </Tooltip>

          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button type="button" variant="outline" size="sm" className="h-8 w-8 px-0 [&_svg]:size-3.5" disabled={busy}>
                    <MoreHorizontal className="h-3.5 w-3.5" />
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="bottom">More</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" className="w-40">
              <DropdownMenuItem onClick={onImport} disabled={busy}>
                <Upload className="mr-2 h-3.5 w-3.5" />
                Import
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onExport} disabled={busy}>
                <Download className="mr-2 h-3.5 w-3.5" />
                Export
              </DropdownMenuItem>
              {currentId && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={onDelete}
                    disabled={busy}
                    className="text-destructive focus:text-destructive"
                  >
                    <Trash2 className="mr-2 h-3.5 w-3.5" />
                    Delete
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onSave}
            disabled={busy}
          >
            <Save className="mr-1.5 h-3.5 w-3.5" />
            Save
          </Button>

          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || !currentId}
            onClick={() => {
              const url = window.location.href
              void navigator.clipboard?.writeText(url)
            }}
          >
            <Share2 className="mr-1.5 h-3.5 w-3.5" />
            Share
          </Button>

          {/* Disabled only while busy, per the strategy builder's own written
              policy: a button whose sole explanation is a tooltip is
              unreachable by keyboard and invisible on touch. Blockers hold the
              launch inside the confirm dialog, where the reasons are written. */}
          <Button
            type="button"
            size="sm"
            onClick={onRun}
            disabled={busy}
          >
            <Play className="mr-1.5 h-3.5 w-3.5" />
            Test keycard
          </Button>
        </div>
      </div>
    </TooltipProvider>
  )
}
