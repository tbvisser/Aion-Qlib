import { useState, useEffect } from 'react'
import { ChevronRight, Folder as FolderIcon, Globe } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { listFolders, createFolder, renameFolder, deleteFolder, toggleFolderSharing } from '@/features/rag/lib/api'
import { FolderContextMenu } from './FolderContextMenu'
import { InlineEdit } from './InlineEdit'
import type { Folder } from '@/features/rag/types'

interface FolderNodeProps {
  folder: Folder
  level: number
  selectedId: string | null
  onSelect: (id: string | null, name: string | null) => void
  onRefresh: () => void
  onFolderChildrenChanged?: (parentId: string | null) => void | Promise<void>
}

export function FolderNode({
  folder,
  level,
  selectedId,
  onSelect,
  onRefresh,
  onFolderChildrenChanged,
}: FolderNodeProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [children, setChildren] = useState<Folder[]>([])
  const [loadingChildren, setLoadingChildren] = useState(false)
  const [isRenaming, setIsRenaming] = useState(false)
  const [isCreatingChild, setIsCreatingChild] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [renameError, setRenameError] = useState<string | null>(null)

  const isGlobal = folder.user_id === null
  const isSelected = selectedId === folder.id

  // Load children when expanded
  useEffect(() => {
    if (isOpen && children.length === 0 && !loadingChildren) {
      loadChildren()
    }
  }, [isOpen])

  const loadChildren = async () => {
    setLoadingChildren(true)
    try {
      const result = await listFolders(folder.id)
      setChildren(result)
    } catch (error) {
      console.error('Failed to load children:', error)
    } finally {
      setLoadingChildren(false)
    }
  }

  const handleCreateSubfolder = () => {
    setIsOpen(true)
    setIsCreatingChild(true)
    setCreateError(null)
  }

  const handleSaveNewFolder = async (name: string) => {
    try {
      setCreateError(null)
      const childFolder = await createFolder(name, folder.id)
      setIsCreatingChild(false)
      await loadChildren()
      onRefresh()
      await onFolderChildrenChanged?.(childFolder.parent_id ?? folder.id)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create folder'
      setCreateError(message)
    }
  }

  const handleCancelCreate = () => {
    setIsCreatingChild(false)
    setCreateError(null)
  }

  const handleStartRename = () => {
    setIsRenaming(true)
    setRenameError(null)
  }

  const handleRename = async (newName: string) => {
    try {
      setRenameError(null)
      await renameFolder(folder.id, newName)
      setIsRenaming(false)
      onRefresh()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to rename folder'
      setRenameError(message)
    }
  }

  const handleCancelRename = () => {
    setIsRenaming(false)
    setRenameError(null)
  }

  const handleDelete = async () => {
    await deleteFolder(folder.id)
    if (selectedId === folder.id) {
      onSelect(null, null)
    }
    await onFolderChildrenChanged?.(folder.parent_id ?? null)
    onRefresh()
  }

  const handleToggleSharing = async () => {
    try {
      await toggleFolderSharing(folder.id, !isGlobal)
      onRefresh()
    } catch (error) {
      console.error('Failed to toggle folder sharing:', error)
    }
  }

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (e.ctrlKey || e.metaKey || e.shiftKey) return
    e.preventDefault()
    onSelect(folder.id, folder.name)
  }

  const handleToggle = (e: React.MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    setIsOpen(!isOpen)
  }

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <FolderContextMenu
        folder={folder}
        onCreateSubfolder={handleCreateSubfolder}
        onRename={handleStartRename}
        onDelete={handleDelete}
        onToggleSharing={handleToggleSharing}
        isTopLevel={folder.parent_id === null}
      >
        <a
          href={`/documents/${folder.id}`}
          className={cn(
            'flex items-center gap-1 py-1 px-2 rounded cursor-pointer hover:bg-muted/50 no-underline text-foreground',
            isSelected && 'bg-accent'
          )}
          style={{ paddingLeft: `${level * 16 + 8}px` }}
          onClick={handleClick}
        >
          <CollapsibleTrigger asChild onClick={handleToggle}>
            <Button
              variant="ghost"
              size="icon"
              className="h-5 w-5 p-0 hover:bg-transparent"
            >
              <ChevronRight
                className={cn(
                  'h-4 w-4 text-muted-foreground transition-transform',
                  isOpen && 'rotate-90'
                )}
              />
            </Button>
          </CollapsibleTrigger>

          {isGlobal ? (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Globe className="h-4 w-4 text-muted-foreground shrink-0" />
                </TooltipTrigger>
                <TooltipContent>Shared with all users</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : (
            <FolderIcon className="h-4 w-4 text-muted-foreground shrink-0" />
          )}

          {isRenaming ? (
            <InlineEdit
              value={folder.name}
              onSave={handleRename}
              onCancel={handleCancelRename}
              error={renameError}
            />
          ) : (
            <span className="text-sm truncate">{folder.name}</span>
          )}
        </a>
      </FolderContextMenu>

      <CollapsibleContent>
        {loadingChildren && (
          <div
            className="text-xs text-muted-foreground py-1"
            style={{ paddingLeft: `${(level + 1) * 16 + 8}px` }}
          >
            Loading…
          </div>
        )}
        {children.map((child) => (
          <FolderNode
            key={child.id}
            folder={child}
            level={level + 1}
            selectedId={selectedId}
            onSelect={onSelect}
            onFolderChildrenChanged={onFolderChildrenChanged}
            onRefresh={async () => {
              await loadChildren()
              onRefresh()
            }}
          />
        ))}
        {isCreatingChild && (
          <div
            className="flex items-center gap-1 py-1 px-2"
            style={{ paddingLeft: `${(level + 1) * 16 + 8}px` }}
          >
            <FolderIcon className="h-4 w-4 text-muted-foreground shrink-0" />
            <InlineEdit
              value=""
              onSave={handleSaveNewFolder}
              onCancel={handleCancelCreate}
              error={createError}
            />
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}
