import { useEffect, useState } from 'react'
import { FolderPlus, FileText, FilePlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { listFolders, createFolder } from '@/lib/api'
import { FolderNode } from './FolderNode'
import { InlineEdit } from './InlineEdit'
import { cn } from '@/lib/utils'
import type { Folder } from '@/types'

interface FolderTreeProps {
  selectedFolderId: string | null
  onSelectFolder: (folderId: string | null, folderName: string | null) => void
  onAddFiles: () => void
  onFolderChildrenChanged?: (parentId: string | null) => void | Promise<void>
}

export function FolderTree({
  selectedFolderId,
  onSelectFolder,
  onAddFiles,
  onFolderChildrenChanged,
}: FolderTreeProps) {
  const [folders, setFolders] = useState<Folder[]>([])
  const [loading, setLoading] = useState(true)
  const [isCreatingRoot, setIsCreatingRoot] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const loadRootFolders = async () => {
    try {
      const result = await listFolders()
      setFolders(result)
    } catch (error) {
      console.error('Failed to load folders:', error)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadRootFolders()
  }, [])

  const handleCreateRootFolder = async (name: string) => {
    try {
      setCreateError(null)
      const folder = await createFolder(name, null)
      setIsCreatingRoot(false)
      await loadRootFolders()
      await onFolderChildrenChanged?.(folder.parent_id ?? null)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create folder'
      setCreateError(message)
    }
  }

  const handleStartCreate = () => {
    setIsCreatingRoot(true)
    setCreateError(null)
  }

  const handleCancelCreate = () => {
    setIsCreatingRoot(false)
    setCreateError(null)
  }

  const handleSelectKnowledgebase = () => {
    onSelectFolder(null, 'Knowledgebase')
  }

  const handleSelectFolder = (folderId: string | null, folderName: string | null) => {
    onSelectFolder(folderId, folderName)
  }

  return (
    <div className="space-y-1">
      <div className="p-3">
        <Button
          variant="ghost"
          onClick={onAddFiles}
          className="w-full h-10 justify-start rounded-xl border border-foreground/15 bg-transparent transition-all duration-200 btn-press"
        >
          <FilePlus className="mr-2 h-4 w-4" />
          Add Files
        </Button>
      </div>

      {/* Header with New Folder button */}
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          Folders
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 rounded-lg hover:bg-accent/50 transition-colors"
          onClick={handleStartCreate}
          title="New folder"
        >
          <FolderPlus className="h-4 w-4" />
        </Button>
      </div>

      {/* Knowledgebase option - uploads without folder */}
      <a
        href="/documents"
        className={cn(
          'flex items-center gap-2.5 py-2 px-3 mx-2 rounded-xl cursor-pointer transition-all duration-200 no-underline text-foreground',
          selectedFolderId === null
            ? 'bg-accent/80 shadow-sm'
            : 'hover:bg-accent/50'
        )}
        onClick={(e) => {
          if (e.ctrlKey || e.metaKey || e.shiftKey) return
          e.preventDefault()
          handleSelectKnowledgebase()
        }}
      >
        <FileText className={cn(
          "h-4 w-4 shrink-0 transition-colors",
          selectedFolderId === null ? "text-primary" : "text-muted-foreground"
        )} />
        <span className="text-sm">Knowledgebase</span>
      </a>

      {loading ? (
        <div className="text-xs text-muted-foreground py-2 px-3">Loading folders...</div>
      ) : (
        <>
          {/* Root folders */}
          {folders.map((folder) => (
            <FolderNode
              key={folder.id}
              folder={folder}
              level={0}
              selectedId={selectedFolderId}
              onSelect={handleSelectFolder}
              onRefresh={loadRootFolders}
              onFolderChildrenChanged={onFolderChildrenChanged}
            />
          ))}

          {/* New root folder input */}
          {isCreatingRoot && (
            <div className="flex items-center gap-1 py-1 px-2 animate-fade-in" style={{ paddingLeft: '24px' }}>
              <InlineEdit
                value=""
                onSave={handleCreateRootFolder}
                onCancel={handleCancelCreate}
                error={createError}
              />
            </div>
          )}

          {/* Empty state */}
          {folders.length === 0 && !isCreatingRoot && (
            <div className="text-xs text-muted-foreground py-3 px-3 text-center">
              No folders yet. Click + to create one.
            </div>
          )}
        </>
      )}
    </div>
  )
}
