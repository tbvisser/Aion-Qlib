import { useState } from 'react'
import { FolderInput, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { MoveToFolderDialog } from './MoveToFolderDialog'

interface DocumentBulkActionsBarProps {
  selectedCount: number
  /** Number of selectable (owned + visible) documents — drives the select-all control. */
  selectableCount: number
  allSelected: boolean
  currentFolderId: string | null
  onToggleSelectAll: () => void
  onClear: () => void
  onDelete: () => Promise<void>
  onMove: (folderId: string | null) => Promise<void>
}

export function DocumentBulkActionsBar({
  selectedCount,
  selectableCount,
  allSelected,
  currentFolderId,
  onToggleSelectAll,
  onClear,
  onDelete,
  onMove,
}: DocumentBulkActionsBarProps) {
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [showMoveDialog, setShowMoveDialog] = useState(false)

  const handleDelete = async () => {
    setDeleting(true)
    try {
      await onDelete()
      setShowDeleteDialog(false)
    } catch (error) {
      console.error('Failed to delete documents:', error)
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="sticky top-0 z-20 -mx-1 flex flex-wrap items-center gap-3 rounded-lg border border-border/60 bg-background/95 px-4 py-2.5 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <div
        className="flex items-center gap-2 text-sm font-medium"
      >
        <Checkbox
          checked={allSelected ? true : 'indeterminate'}
          onCheckedChange={onToggleSelectAll}
          aria-label={allSelected ? 'Clear selection' : 'Select all documents'}
        />
        <button
          type="button"
          onClick={onToggleSelectAll}
          className="text-left"
        >
          {selectedCount} selected
          {selectableCount > selectedCount && ` of ${selectableCount}`}
        </button>
      </div>

      <div className="ml-auto flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowMoveDialog(true)}
          className="flex items-center gap-2"
        >
          <FolderInput className="h-4 w-4" />
          Move to…
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowDeleteDialog(true)}
          className="flex items-center gap-2 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
        >
          <Trash2 className="h-4 w-4" />
          Delete
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={onClear}
          aria-label="Clear selection"
          className="h-8 w-8"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {selectedCount} {selectedCount === 1 ? 'document' : 'documents'}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the selected{' '}
              {selectedCount === 1 ? 'document' : 'documents'} and all of their chunks. This
              cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault()
                void handleDelete()
              }}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? 'Deleting...' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <MoveToFolderDialog
        open={showMoveDialog}
        onOpenChange={setShowMoveDialog}
        count={selectedCount}
        currentFolderId={currentFolderId}
        onMove={onMove}
      />
    </div>
  )
}
