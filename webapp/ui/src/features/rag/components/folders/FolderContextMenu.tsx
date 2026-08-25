import { ReactNode, useState } from 'react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
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
import { FolderPlus, Edit, Trash, Globe, Lock } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { RowActionsMenu, type RowAction } from '@/features/rag/components/layout/RowActionsMenu'
import type { Folder } from '@/features/rag/types'

interface FolderContextMenuProps {
  folder: Folder
  children: ReactNode
  onCreateSubfolder: () => void
  onRename: () => void
  onDelete: () => Promise<void>
  onToggleSharing?: () => Promise<void>
  isTopLevel?: boolean
  disabled?: boolean
}

export function FolderContextMenu({
  folder,
  children,
  onCreateSubfolder,
  onRename,
  onDelete,
  onToggleSharing,
  isTopLevel = false,
  disabled = false,
}: FolderContextMenuProps) {
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const { user } = useAuth()
  const isGlobal = folder.user_id === null
  const isOwner = folder.user_id === user?.id
  const isOriginalOwner = folder.shared_by === user?.id

  const handleDelete = async () => {
    setDeleting(true)
    try {
      await onDelete()
      setShowDeleteDialog(false)
    } catch (error) {
      console.error('Failed to delete folder:', error)
    } finally {
      setDeleting(false)
    }
  }

  // Same actions the desktop right-click menu offers, surfaced as a tappable
  // "⋯" menu on mobile (touch can't right-click).
  const mobileActions: RowAction[] = [
    { label: 'New Subfolder', icon: <FolderPlus className="h-4 w-4" />, onSelect: onCreateSubfolder },
  ]
  if (isTopLevel && onToggleSharing && !isGlobal && isOwner) {
    mobileActions.push({ label: 'Share with all', icon: <Globe className="h-4 w-4" />, onSelect: () => { void onToggleSharing() } })
  }
  if (isTopLevel && onToggleSharing && isGlobal && isOriginalOwner) {
    mobileActions.push({ label: 'Make private', icon: <Lock className="h-4 w-4" />, onSelect: () => { void onToggleSharing() } })
  }
  if (!isGlobal) {
    mobileActions.push({ label: 'Rename', icon: <Edit className="h-4 w-4" />, onSelect: onRename })
    mobileActions.push({ label: 'Delete', icon: <Trash className="h-4 w-4" />, onSelect: () => setShowDeleteDialog(true), destructive: true })
  }

  return (
    <>
      <div className="relative">
        <ContextMenu>
          <ContextMenuTrigger asChild disabled={disabled}>
            {children}
          </ContextMenuTrigger>
          <ContextMenuContent>
          <ContextMenuItem onClick={onCreateSubfolder}>
            <FolderPlus className="mr-2 h-4 w-4" />
            New Subfolder
          </ContextMenuItem>
          {isTopLevel && onToggleSharing && !isGlobal && isOwner && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={onToggleSharing}>
                <Globe className="mr-2 h-4 w-4" />
                Share with all
              </ContextMenuItem>
            </>
          )}
          {isTopLevel && onToggleSharing && isGlobal && isOriginalOwner && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={onToggleSharing}>
                <Lock className="mr-2 h-4 w-4" />
                Make private
              </ContextMenuItem>
            </>
          )}
          {!isGlobal && (
            <>
              <ContextMenuItem onClick={onRename}>
                <Edit className="mr-2 h-4 w-4" />
                Rename
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem
                onClick={() => setShowDeleteDialog(true)}
                className="text-destructive focus:text-destructive"
              >
                <Trash className="mr-2 h-4 w-4" />
                Delete
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
        </ContextMenu>
        {!disabled && (
          <RowActionsMenu
            actions={mobileActions}
            ariaLabel={`Actions for ${folder.name}`}
            className="absolute right-1 top-1/2 -translate-y-1/2"
          />
        )}
      </div>

      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete folder?</AlertDialogTitle>
            <AlertDialogDescription>
              This will delete "{folder.name}", all its subfolders, and all documents inside them. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? 'Deleting…' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
