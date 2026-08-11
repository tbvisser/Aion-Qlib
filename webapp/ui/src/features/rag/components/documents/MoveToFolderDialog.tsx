import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { FileText, Folder as FolderIcon, Globe, Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { listAllFolders } from '@/features/rag/lib/api'
import { cn } from '@/lib/utils'
import type { Folder } from '@/features/rag/types'

interface MoveToFolderDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  count: number
  /** Folder currently being viewed — offered as a no-op and disabled as a target. */
  currentFolderId: string | null
  onMove: (folderId: string | null) => Promise<void>
}

// `null` target id means the Knowledgebase root (unfiled).
type Target = { id: string | null }

export function MoveToFolderDialog({
  open,
  onOpenChange,
  count,
  currentFolderId,
  onMove,
}: MoveToFolderDialogProps) {
  const [folders, setFolders] = useState<Folder[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [target, setTarget] = useState<Target | null>(null)
  const [moving, setMoving] = useState(false)
  const [moveError, setMoveError] = useState<string | null>(null)

  // Load the full folder list (and reset transient state) each time the dialog opens.
  useEffect(() => {
    if (!open) return

    let cancelled = false
    setTarget(null)
    setMoveError(null)
    setLoadError(null)
    setLoading(true)

    listAllFolders()
      .then((result) => {
        if (!cancelled) setFolders(result)
      })
      .catch((error) => {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : 'Failed to load folders')
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [open])

  const childrenByParent = useMemo(() => {
    const map = new Map<string | null, Folder[]>()
    for (const folder of folders) {
      const key = folder.parent_id ?? null
      const bucket = map.get(key)
      if (bucket) bucket.push(folder)
      else map.set(key, [folder])
    }
    return map
  }, [folders])

  const rootFolders = childrenByParent.get(null) ?? []

  const renderFolder = (folder: Folder, depth: number): ReactNode => {
    const isGlobal = folder.user_id === null
    const isSelected = target?.id === folder.id
    const isCurrent = folder.id === currentFolderId
    const kids = childrenByParent.get(folder.id) ?? []

    return (
      <div key={folder.id}>
        <button
          type="button"
          disabled={isCurrent}
          onClick={() => setTarget({ id: folder.id })}
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
          className={cn(
            'flex w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left text-sm transition-colors',
            isSelected ? 'bg-accent text-accent-foreground' : 'hover:bg-muted',
            isCurrent && 'cursor-not-allowed opacity-50 hover:bg-transparent',
          )}
        >
          {isGlobal ? (
            <Globe className="h-4 w-4 shrink-0 text-blue-500" />
          ) : (
            <FolderIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate">{folder.name}</span>
          {isCurrent && <span className="ml-auto text-xs text-muted-foreground">Current</span>}
        </button>
        {kids.map((child) => renderFolder(child, depth + 1))}
      </div>
    )
  }

  const rootSelected = target?.id === null && target !== null
  const rootIsCurrent = currentFolderId === null
  const canMove = target !== null && !moving && target.id !== currentFolderId

  const handleMove = async () => {
    if (!target) return
    setMoving(true)
    setMoveError(null)
    try {
      await onMove(target.id)
      onOpenChange(false)
    } catch (error) {
      setMoveError(error instanceof Error ? error.message : 'Failed to move documents')
    } finally {
      setMoving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !moving && onOpenChange(next)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Move {count} {count === 1 ? 'document' : 'documents'}</DialogTitle>
          <DialogDescription>Choose a destination folder.</DialogDescription>
        </DialogHeader>

        <div className="max-h-72 overflow-y-auto rounded-md border border-border/60 p-1">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading folders...
            </div>
          ) : loadError ? (
            <p className="py-8 text-center text-sm text-destructive">{loadError}</p>
          ) : (
            <>
              {/* Knowledgebase root (unfiled) */}
              <button
                type="button"
                disabled={rootIsCurrent}
                onClick={() => setTarget({ id: null })}
                style={{ paddingLeft: '8px' }}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left text-sm transition-colors',
                  rootSelected ? 'bg-accent text-accent-foreground' : 'hover:bg-muted',
                  rootIsCurrent && 'cursor-not-allowed opacity-50 hover:bg-transparent',
                )}
              >
                <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="truncate">Knowledgebase</span>
                {rootIsCurrent && (
                  <span className="ml-auto text-xs text-muted-foreground">Current</span>
                )}
              </button>

              {rootFolders.map((folder) => renderFolder(folder, 0))}

              {rootFolders.length === 0 && (
                <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                  No folders yet — create one from the sidebar.
                </p>
              )}
            </>
          )}
        </div>

        {moveError && <p className="text-sm text-destructive">{moveError}</p>}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={moving}>
            Cancel
          </Button>
          <Button onClick={handleMove} disabled={!canMove}>
            {moving ? 'Moving...' : 'Move here'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
