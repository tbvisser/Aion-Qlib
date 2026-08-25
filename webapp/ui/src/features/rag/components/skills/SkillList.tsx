import { useRef, useState, useEffect, useMemo } from 'react'
import { Plus, Sparkles, PenLine, Upload, Zap, Globe, ChevronRight, ChevronDown, File as FileIcon, Folder as FolderIcon, Trash, Edit, FolderPlus } from 'lucide-react'
import { InlineEdit } from '@/features/rag/components/folders/InlineEdit'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
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
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { RowActionsMenu, type RowAction } from '@/features/rag/components/layout/RowActionsMenu'
import { cn } from '@/lib/utils'
import { listSkillFiles } from '@/features/rag/lib/api'
import { useAuth } from '@/hooks/useAuth'
import type { Skill, SkillFile } from '@/features/rag/types'

interface SkillListProps {
  skills: Skill[]
  selectedSkillId: string | null
  selectedFileId?: string | null
  onSelectSkill: (skill: Skill) => void
  onSelectFile?: (skill: Skill, file: SkillFile) => void
  onDeleteFile?: (skill: Skill, file: SkillFile) => Promise<void>
  onRenameFile?: (skill: Skill, file: SkillFile, newFilename: string) => Promise<void>
  onUploadToFolder?: (skill: Skill, folderPath: string) => void
  onCreateSubfolder?: (skill: Skill, parentPath: string, name: string) => Promise<void>
  onRenameFolder?: (skill: Skill, oldPath: string, newPath: string) => Promise<void>
  onDeleteFolder?: (skill: Skill, folderPath: string) => Promise<void>
  onCreateWithAI: () => void
  onCreateManually: () => void
  onImportFile: (file: File) => void
  onImportUrl: () => void
  loading?: boolean
  // Incremented by the parent when a skill's file list changes (upload/delete);
  // causes any expanded SkillNode to refetch.
  fileRefreshKey?: number
}

export function SkillList({
  skills,
  selectedSkillId,
  selectedFileId,
  onSelectSkill,
  onSelectFile,
  onDeleteFile,
  onRenameFile,
  onUploadToFolder,
  onCreateSubfolder,
  onRenameFolder,
  onDeleteFolder,
  onCreateWithAI,
  onCreateManually,
  onImportFile,
  onImportUrl,
  loading,
  fileRefreshKey,
}: SkillListProps) {
  const importInputRef = useRef<HTMLInputElement>(null)

  const handleImportChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) onImportFile(file)
    if (importInputRef.current) importInputRef.current.value = ''
  }

  return (
    <div className="space-y-1">
      <div className="p-3">
        <input
          ref={importInputRef}
          type="file"
          accept=".zip"
          className="hidden"
          onChange={handleImportChange}
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              className="w-full h-10 justify-start rounded-xl border border-foreground/15 bg-transparent transition-all duration-200 btn-press"
              title="New skill"
            >
              <Plus className="mr-2 h-4 w-4" />
              New Skill
              <ChevronDown className="ml-auto h-4 w-4 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-[var(--radix-dropdown-menu-trigger-width)]">
            <DropdownMenuItem onClick={onCreateWithAI}>
              <Sparkles className="mr-2 h-4 w-4" />
              Create with AI
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onCreateManually}>
              <PenLine className="mr-2 h-4 w-4" />
              Create Manually
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => importInputRef.current?.click()}>
              <Upload className="mr-2 h-4 w-4" />
              Import from File
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onImportUrl}>
              <Globe className="mr-2 h-4 w-4" />
              Import from URL
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="flex items-center px-3 py-2">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          Skills
        </span>
      </div>

      {loading ? (
        <div className="text-xs text-muted-foreground py-2 px-3">Loading skills…</div>
      ) : skills.length === 0 ? (
        <div className="text-xs text-muted-foreground py-3 px-3 text-center">
          No skills yet. Click New Skill to create one.
        </div>
      ) : (
        <div className="space-y-0.5">
          {skills.map((skill) => (
            <SkillNode
              key={skill.id}
              skill={skill}
              isSelectedSkill={selectedSkillId === skill.id}
              selectedFileId={selectedFileId ?? null}
              onSelectSkill={onSelectSkill}
              onSelectFile={onSelectFile}
              onDeleteFile={onDeleteFile}
              onRenameFile={onRenameFile}
              onUploadToFolder={onUploadToFolder}
              onCreateSubfolder={onCreateSubfolder}
              onRenameFolder={onRenameFolder}
              onDeleteFolder={onDeleteFolder}
              fileRefreshKey={fileRefreshKey}
            />
          ))}
        </div>
      )}
    </div>
  )
}

interface SkillNodeProps {
  skill: Skill
  isSelectedSkill: boolean
  selectedFileId: string | null
  onSelectSkill: (skill: Skill) => void
  onSelectFile?: (skill: Skill, file: SkillFile) => void
  onDeleteFile?: (skill: Skill, file: SkillFile) => Promise<void>
  onRenameFile?: (skill: Skill, file: SkillFile, newFilename: string) => Promise<void>
  onUploadToFolder?: (skill: Skill, folderPath: string) => void
  onCreateSubfolder?: (skill: Skill, parentPath: string, name: string) => Promise<void>
  onRenameFolder?: (skill: Skill, oldPath: string, newPath: string) => Promise<void>
  onDeleteFolder?: (skill: Skill, folderPath: string) => Promise<void>
  fileRefreshKey?: number
}

function SkillNode({ skill, isSelectedSkill, selectedFileId, onSelectSkill, onSelectFile, onDeleteFile, onRenameFile, onUploadToFolder, onCreateSubfolder, onRenameFolder, onDeleteFolder, fileRefreshKey }: SkillNodeProps) {
  const { user } = useAuth()
  // Auto-expand when this skill matches the current selection.
  const [isOpen, setIsOpen] = useState(isSelectedSkill)
  const [files, setFiles] = useState<SkillFile[]>([])
  const [loadingFiles, setLoadingFiles] = useState(false)
  // When true, render an InlineEdit row at the top of the file tree to capture
  // a new top-level folder name.
  const [creatingTopFolder, setCreatingTopFolder] = useState(false)
  const [creatingError, setCreatingError] = useState<string | null>(null)

  useEffect(() => {
    if (isSelectedSkill && !isOpen) setIsOpen(true)
  }, [isSelectedSkill]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (isOpen && files.length === 0 && !loadingFiles) {
      setLoadingFiles(true)
      listSkillFiles(skill.id)
        .then(setFiles)
        .catch((err) => console.error('Failed to load skill files:', err))
        .finally(() => setLoadingFiles(false))
    }
  }, [isOpen]) // eslint-disable-line react-hooks/exhaustive-deps

  // Refetch this skill's files when the parent signals a change. Skip the
  // initial mount so we don't double-fetch with the lazy loader above.
  // Refetch happens for any expanded skill — mutations (create folder,
  // rename, upload) can target a skill that's open in the tree without
  // being the currently selected skill in the editor.
  const refreshKeyRef = useRef(fileRefreshKey)
  useEffect(() => {
    if (refreshKeyRef.current === fileRefreshKey) return
    refreshKeyRef.current = fileRefreshKey
    if (!isOpen) return
    setLoadingFiles(true)
    listSkillFiles(skill.id)
      .then(setFiles)
      .catch((err) => console.error('Failed to reload skill files:', err))
      .finally(() => setLoadingFiles(false))
  }, [fileRefreshKey, isOpen, skill.id])

  const handleToggle = (e: React.MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    setIsOpen(!isOpen)
  }

  const handleSkillClick = (e: React.MouseEvent) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey) return
    e.preventDefault()
    onSelectSkill(skill)
  }

  const handleStartNewTopFolder = () => {
    setIsOpen(true)
    setCreatingError(null)
    setCreatingTopFolder(true)
  }

  const handleSubmitTopFolder = async (name: string) => {
    if (!onCreateSubfolder) return
    setCreatingError(null)
    try {
      await onCreateSubfolder(skill, '', name)
      setCreatingTopFolder(false)
    } catch (err) {
      setCreatingError(err instanceof Error ? err.message : 'Failed to create folder')
    }
  }

  const isOwner = skill.user_id === user?.id
  const canUploadToRoot = onUploadToFolder && isOwner
  const canCreateRootFolder = onCreateSubfolder && isOwner

  const skillRow = (
    <a
      href={`/lab/roster/${skill.id}`}
      onClick={handleSkillClick}
      className={cn(
        'group flex items-center gap-1.5 py-2 pl-2 pr-3 mx-2 rounded-xl cursor-pointer transition-all duration-200 no-underline text-foreground',
        isSelectedSkill ? 'bg-accent/80 shadow-sm' : 'hover:bg-accent/50',
        !skill.enabled && 'opacity-50'
      )}
    >
      <CollapsibleTrigger asChild onClick={handleToggle}>
        <button
          data-testid={`skill-tree-toggle-${skill.id}`}
          className="flex h-5 w-5 items-center justify-center rounded hover:bg-background/50"
        >
          <ChevronRight
            className={cn(
              'h-4 w-4 text-muted-foreground transition-transform',
              isOpen && 'rotate-90'
            )}
          />
        </button>
      </CollapsibleTrigger>

      <Zap className={cn(
        'h-4 w-4 shrink-0 transition-colors',
        isSelectedSkill ? 'text-primary' : 'text-muted-foreground'
      )} />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-sm truncate">{skill.name}</span>
          {skill.user_id === null && (
            <span className="inline-flex items-center gap-0.5 rounded-full bg-primary/10 px-1.5 py-0.5 text-micro font-medium text-primary shrink-0">
              <Globe className="h-2.5 w-2.5" />
              Global
            </span>
          )}
          {!skill.enabled && (
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-micro font-medium text-muted-foreground shrink-0">
              Disabled
            </span>
          )}
        </div>
      </div>
    </a>
  )

  const showContextMenu = canUploadToRoot || canCreateRootFolder

  const skillActions: RowAction[] = []
  if (canCreateRootFolder) skillActions.push({ label: 'New Subfolder', icon: <FolderPlus className="h-4 w-4" />, onSelect: handleStartNewTopFolder })
  if (canUploadToRoot) skillActions.push({ label: 'Upload File', icon: <Upload className="h-4 w-4" />, onSelect: () => onUploadToFolder!(skill, '') })

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      {showContextMenu ? (
        <div className="relative">
          <ContextMenu>
            <ContextMenuTrigger asChild>{skillRow}</ContextMenuTrigger>
            <ContextMenuContent>
              {canCreateRootFolder && (
                <ContextMenuItem onClick={handleStartNewTopFolder}>
                  <FolderPlus className="mr-2 h-4 w-4" />
                  New Subfolder
                </ContextMenuItem>
              )}
              {canUploadToRoot && (
                <ContextMenuItem onClick={() => onUploadToFolder!(skill, '')}>
                  <Upload className="mr-2 h-4 w-4" />
                  Upload File
                </ContextMenuItem>
              )}
            </ContextMenuContent>
          </ContextMenu>
          <RowActionsMenu
            actions={skillActions}
            ariaLabel={`Actions for ${skill.name}`}
            className="absolute right-3 top-1/2 -translate-y-1/2"
          />
        </div>
      ) : (
        skillRow
      )}

      <CollapsibleContent>
        <SkillFileTree
          files={files}
          loading={loadingFiles}
          isOpen={isOpen}
          skill={skill}
          selectedFileId={selectedFileId}
          onSelectFile={onSelectFile}
          onDeleteFile={onDeleteFile}
          onRenameFile={onRenameFile}
          onUploadToFolder={onUploadToFolder}
          onCreateSubfolder={onCreateSubfolder}
          onRenameFolder={onRenameFolder}
          onDeleteFolder={onDeleteFolder}
          creatingTopFolder={creatingTopFolder}
          creatingError={creatingError}
          onSubmitTopFolderName={handleSubmitTopFolder}
          onCancelTopFolder={() => { setCreatingTopFolder(false); setCreatingError(null) }}
        />
      </CollapsibleContent>
    </Collapsible>
  )
}

// File-tree primitives. Skill files are stored with path-like names
// (e.g. "office/helpers/merge_request.py"). The tree groups them by
// path segments so they render as nested folders instead of a flat
// list of truncated paths.

interface TreeNode {
  name: string
  path: string
  isFile: boolean
  file?: SkillFile
  children: TreeNode[]
}

const SKILLKEEP_FILENAME = '.skillkeep'

function buildSkillTree(files: SkillFile[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', isFile: false, children: [] }
  for (const file of files) {
    const parts = file.filename.split('/')
    let node = root
    let path = ''
    for (let i = 0; i < parts.length; i++) {
      const segment = parts[i]
      const isLast = i === parts.length - 1
      path = path ? `${path}/${segment}` : segment

      // .skillkeep placeholders exist only to keep empty folders in the tree;
      // don't add them as visible file leaves. Their parent folders are
      // already created by the prior iterations of this loop.
      if (isLast && segment === SKILLKEEP_FILENAME) continue

      let child = node.children.find(c => c.name === segment && c.isFile === isLast)
      if (!child) {
        child = {
          name: segment,
          path,
          isFile: isLast,
          file: isLast ? file : undefined,
          children: [],
        }
        node.children.push(child)
      }
      node = child
    }
  }
  sortTree(root)
  return root.children
}

function sortTree(node: TreeNode) {
  node.children.sort((a, b) => {
    if (a.isFile !== b.isFile) return a.isFile ? 1 : -1
    return a.name.localeCompare(b.name)
  })
  for (const child of node.children) {
    if (!child.isFile) sortTree(child)
  }
}

function containsSelectedFile(node: TreeNode, selectedFileId: string | null): boolean {
  if (!selectedFileId) return false
  if (node.isFile) return node.file?.id === selectedFileId
  return node.children.some(c => containsSelectedFile(c, selectedFileId))
}

interface SkillFileTreeProps {
  files: SkillFile[]
  loading: boolean
  isOpen: boolean
  skill: Skill
  selectedFileId: string | null
  onSelectFile?: (skill: Skill, file: SkillFile) => void
  onDeleteFile?: (skill: Skill, file: SkillFile) => Promise<void>
  onRenameFile?: (skill: Skill, file: SkillFile, newFilename: string) => Promise<void>
  onUploadToFolder?: (skill: Skill, folderPath: string) => void
  onCreateSubfolder?: (skill: Skill, parentPath: string, name: string) => Promise<void>
  onRenameFolder?: (skill: Skill, oldPath: string, newPath: string) => Promise<void>
  onDeleteFolder?: (skill: Skill, folderPath: string) => Promise<void>
  creatingTopFolder?: boolean
  creatingError?: string | null
  onSubmitTopFolderName?: (name: string) => void
  onCancelTopFolder?: () => void
}

function SkillFileTree({
  files,
  loading,
  isOpen,
  skill,
  selectedFileId,
  onSelectFile,
  onDeleteFile,
  onRenameFile,
  onUploadToFolder,
  onCreateSubfolder,
  onRenameFolder,
  onDeleteFolder,
  creatingTopFolder,
  creatingError,
  onSubmitTopFolderName,
  onCancelTopFolder,
}: SkillFileTreeProps) {
  const tree = useMemo(() => buildSkillTree(files), [files])
  const treeIsEmpty = tree.length === 0

  return (
    <div className="ml-6 mr-2">
      {loading && (
        <div className="text-xs text-muted-foreground py-1 px-3">Loading files…</div>
      )}
      {creatingTopFolder && onSubmitTopFolderName && onCancelTopFolder && (
        <NewFolderInputRow
          level={0}
          value=""
          error={creatingError ?? null}
          onSubmit={onSubmitTopFolderName}
          onCancel={onCancelTopFolder}
        />
      )}
      {!loading && treeIsEmpty && !creatingTopFolder && isOpen && (
        <div className="text-xs text-muted-foreground py-1 px-3 italic">No files</div>
      )}
      {!loading && tree.map((node) => (
        <SkillTreeNode
          key={node.path}
          node={node}
          skill={skill}
          level={0}
          selectedFileId={selectedFileId}
          onSelectFile={onSelectFile}
          onDeleteFile={onDeleteFile}
          onRenameFile={onRenameFile}
          onUploadToFolder={onUploadToFolder}
          onCreateSubfolder={onCreateSubfolder}
          onRenameFolder={onRenameFolder}
          onDeleteFolder={onDeleteFolder}
        />
      ))}
    </div>
  )
}

// Shared inline-edit row used both for creating a new (sub)folder and as a
// helper for matching tree indentation.
function NewFolderInputRow({
  level,
  value,
  error,
  onSubmit,
  onCancel,
}: {
  level: number
  value: string
  error: string | null
  onSubmit: (name: string) => void
  onCancel: () => void
}) {
  const paddingLeft = `${level * 12 + 8}px`
  return (
    <div
      style={{ paddingLeft }}
      className="flex items-center gap-1.5 pr-3 py-1.5 text-sm text-muted-foreground"
    >
      <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-50" />
      <FolderIcon className="h-3.5 w-3.5 shrink-0" />
      <InlineEdit value={value} onSave={onSubmit} onCancel={onCancel} error={error} />
    </div>
  )
}

interface SkillTreeNodeProps {
  node: TreeNode
  skill: Skill
  level: number
  selectedFileId: string | null
  onSelectFile?: (skill: Skill, file: SkillFile) => void
  onDeleteFile?: (skill: Skill, file: SkillFile) => Promise<void>
  onRenameFile?: (skill: Skill, file: SkillFile, newFilename: string) => Promise<void>
  onUploadToFolder?: (skill: Skill, folderPath: string) => void
  onCreateSubfolder?: (skill: Skill, parentPath: string, name: string) => Promise<void>
  onRenameFolder?: (skill: Skill, oldPath: string, newPath: string) => Promise<void>
  onDeleteFolder?: (skill: Skill, folderPath: string) => Promise<void>
}

function SkillTreeNode({
  node,
  skill,
  level,
  selectedFileId,
  onSelectFile,
  onDeleteFile,
  onRenameFile,
  onUploadToFolder,
  onCreateSubfolder,
  onRenameFolder,
  onDeleteFolder,
}: SkillTreeNodeProps) {
  const { user } = useAuth()
  const isOwner = skill.user_id === user?.id
  const shouldAutoExpand = !node.isFile && containsSelectedFile(node, selectedFileId)
  const [isOpen, setIsOpen] = useState(shouldAutoExpand)
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [isRenaming, setIsRenaming] = useState(false)
  const [renameError, setRenameError] = useState<string | null>(null)
  const [isCreatingChild, setIsCreatingChild] = useState(false)
  const [createChildError, setCreateChildError] = useState<string | null>(null)

  useEffect(() => {
    if (shouldAutoExpand && !isOpen) setIsOpen(true)
  }, [shouldAutoExpand]) // eslint-disable-line react-hooks/exhaustive-deps

  const paddingLeft = `${level * 12 + 8}px`
  const parentPath = node.path.includes('/') ? node.path.slice(0, node.path.lastIndexOf('/')) : ''

  // --- File node -----------------------------------------------------------
  if (node.isFile && node.file) {
    const file = node.file
    const isSelectedFile = selectedFileId === file.id
    const canMutate = isOwner && (onDeleteFile || onRenameFile)

    const handleRenameSubmit = async (newName: string) => {
      if (!onRenameFile) return
      const newFilename = parentPath ? `${parentPath}/${newName}` : newName
      setRenameError(null)
      try {
        await onRenameFile(skill, file, newFilename)
        setIsRenaming(false)
      } catch (err) {
        setRenameError(err instanceof Error ? err.message : 'Rename failed')
      }
    }

    if (isRenaming) {
      return (
        <div
          style={{ paddingLeft }}
          className="flex items-center gap-2 pr-3 py-1.5 text-sm"
        >
          <FileIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <InlineEdit
            value={node.name}
            onSave={handleRenameSubmit}
            onCancel={() => { setIsRenaming(false); setRenameError(null) }}
            error={renameError}
          />
        </div>
      )
    }

    const fileButton = (
      <button
        data-testid={`skill-tree-file-${file.id}`}
        onClick={() => onSelectFile?.(skill, file)}
        style={{ paddingLeft }}
        className={cn(
          'flex w-full items-center gap-2 pr-3 py-1.5 text-left text-sm rounded-lg transition-colors',
          isSelectedFile
            ? 'bg-accent/80 text-foreground'
            : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
        )}
      >
        <FileIcon className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{node.name}</span>
      </button>
    )

    if (!canMutate) return fileButton

    const handleDelete = async () => {
      setDeleting(true)
      try {
        await onDeleteFile!(skill, file)
        setShowDeleteDialog(false)
      } catch (err) {
        console.error('Failed to delete skill file:', err)
      } finally {
        setDeleting(false)
      }
    }

    const fileActions: RowAction[] = []
    if (onRenameFile) fileActions.push({ label: 'Rename', icon: <Edit className="h-4 w-4" />, onSelect: () => { setRenameError(null); setIsRenaming(true) } })
    if (onDeleteFile) fileActions.push({ label: 'Delete', icon: <Trash className="h-4 w-4" />, onSelect: () => setShowDeleteDialog(true), destructive: true })

    return (
      <>
        <div className="relative">
          <ContextMenu>
            <ContextMenuTrigger asChild>{fileButton}</ContextMenuTrigger>
            <ContextMenuContent>
              {onRenameFile && (
                <ContextMenuItem onClick={() => { setRenameError(null); setIsRenaming(true) }}>
                  <Edit className="mr-2 h-4 w-4" />
                  Rename
                </ContextMenuItem>
              )}
              {onDeleteFile && (
                <ContextMenuItem
                  onClick={() => setShowDeleteDialog(true)}
                  className="text-destructive focus:text-destructive"
                >
                  <Trash className="mr-2 h-4 w-4" />
                  Delete
                </ContextMenuItem>
              )}
            </ContextMenuContent>
          </ContextMenu>
          <RowActionsMenu
            actions={fileActions}
            ariaLabel={`Actions for ${node.name}`}
            className="absolute right-1 top-1/2 -translate-y-1/2"
          />
        </div>

        <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete file?</AlertDialogTitle>
              <AlertDialogDescription>
                This will remove "{file.filename}" from the skill. This cannot be undone.
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

  // --- Folder node ---------------------------------------------------------
  const canUploadHere = !!onUploadToFolder && isOwner
  const canCreateChild = !!onCreateSubfolder && isOwner
  const canRenameFolder = !!onRenameFolder && isOwner
  const canDeleteFolder = !!onDeleteFolder && isOwner
  const hasContextMenu = canUploadHere || canCreateChild || canRenameFolder || canDeleteFolder

  const handleRenameFolderSubmit = async (newName: string) => {
    if (!onRenameFolder) return
    const newPath = parentPath ? `${parentPath}/${newName}` : newName
    setRenameError(null)
    try {
      await onRenameFolder(skill, node.path, newPath)
      setIsRenaming(false)
    } catch (err) {
      setRenameError(err instanceof Error ? err.message : 'Rename failed')
    }
  }

  const handleCreateChildSubmit = async (name: string) => {
    if (!onCreateSubfolder) return
    setCreateChildError(null)
    try {
      await onCreateSubfolder(skill, node.path, name)
      setIsCreatingChild(false)
    } catch (err) {
      setCreateChildError(err instanceof Error ? err.message : 'Failed to create folder')
    }
  }

  const handleDeleteFolderAction = async () => {
    if (!onDeleteFolder) return
    setDeleting(true)
    try {
      await onDeleteFolder(skill, node.path)
      setShowDeleteDialog(false)
    } catch (err) {
      console.error('Failed to delete folder:', err)
    } finally {
      setDeleting(false)
    }
  }

  if (isRenaming) {
    return (
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <div
          style={{ paddingLeft }}
          className="flex items-center gap-1.5 pr-3 py-1.5 text-sm text-muted-foreground"
        >
          <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 transition-transform', isOpen && 'rotate-90')} />
          <FolderIcon className="h-3.5 w-3.5 shrink-0" />
          <InlineEdit
            value={node.name}
            onSave={handleRenameFolderSubmit}
            onCancel={() => { setIsRenaming(false); setRenameError(null) }}
            error={renameError}
          />
        </div>
        <CollapsibleContent>
          {/* render children as usual so context is visible while renaming */}
          {node.children.map((child) => (
            <SkillTreeNode
              key={child.path}
              node={child}
              skill={skill}
              level={level + 1}
              selectedFileId={selectedFileId}
              onSelectFile={onSelectFile}
              onDeleteFile={onDeleteFile}
              onRenameFile={onRenameFile}
              onUploadToFolder={onUploadToFolder}
              onCreateSubfolder={onCreateSubfolder}
              onRenameFolder={onRenameFolder}
              onDeleteFolder={onDeleteFolder}
            />
          ))}
        </CollapsibleContent>
      </Collapsible>
    )
  }

  const folderButton = (
    <button
      data-testid={`skill-tree-folder-${node.path}`}
      style={{ paddingLeft }}
      className="flex w-full items-center gap-1.5 pr-3 py-1.5 text-left text-sm rounded-lg text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors"
    >
      <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 transition-transform', isOpen && 'rotate-90')} />
      <FolderIcon className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{node.name}</span>
    </button>
  )

  const folderActions: RowAction[] = []
  if (canCreateChild) folderActions.push({ label: 'New Subfolder', icon: <FolderPlus className="h-4 w-4" />, onSelect: () => { setIsOpen(true); setCreateChildError(null); setIsCreatingChild(true) } })
  if (canUploadHere) folderActions.push({ label: 'Upload File', icon: <Upload className="h-4 w-4" />, onSelect: () => onUploadToFolder!(skill, node.path) })
  if (canRenameFolder) folderActions.push({ label: 'Rename', icon: <Edit className="h-4 w-4" />, onSelect: () => { setRenameError(null); setIsRenaming(true) } })
  if (canDeleteFolder) folderActions.push({ label: 'Delete', icon: <Trash className="h-4 w-4" />, onSelect: () => setShowDeleteDialog(true), destructive: true })

  const folderTrigger = hasContextMenu ? (
    <div className="relative">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <CollapsibleTrigger asChild>{folderButton}</CollapsibleTrigger>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {canCreateChild && (
            <ContextMenuItem onClick={() => {
              setIsOpen(true)
              setCreateChildError(null)
              setIsCreatingChild(true)
            }}>
              <FolderPlus className="mr-2 h-4 w-4" />
              New Subfolder
            </ContextMenuItem>
          )}
          {canUploadHere && (
            <ContextMenuItem onClick={() => onUploadToFolder!(skill, node.path)}>
              <Upload className="mr-2 h-4 w-4" />
              Upload File
            </ContextMenuItem>
          )}
          {canRenameFolder && (
            <ContextMenuItem onClick={() => { setRenameError(null); setIsRenaming(true) }}>
              <Edit className="mr-2 h-4 w-4" />
              Rename
            </ContextMenuItem>
          )}
          {canDeleteFolder && (
            <ContextMenuItem
              onClick={() => setShowDeleteDialog(true)}
              className="text-destructive focus:text-destructive"
            >
              <Trash className="mr-2 h-4 w-4" />
              Delete
            </ContextMenuItem>
          )}
        </ContextMenuContent>
      </ContextMenu>
      <RowActionsMenu
        actions={folderActions}
        ariaLabel={`Actions for ${node.name}`}
        className="absolute right-1 top-1/2 -translate-y-1/2"
      />
    </div>
  ) : (
    <CollapsibleTrigger asChild>{folderButton}</CollapsibleTrigger>
  )

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      {folderTrigger}
      <CollapsibleContent>
        {isCreatingChild && (
          <NewFolderInputRow
            level={level + 1}
            value=""
            error={createChildError}
            onSubmit={handleCreateChildSubmit}
            onCancel={() => { setIsCreatingChild(false); setCreateChildError(null) }}
          />
        )}
        {node.children.map((child) => (
          <SkillTreeNode
            key={child.path}
            node={child}
            skill={skill}
            level={level + 1}
            selectedFileId={selectedFileId}
            onSelectFile={onSelectFile}
            onDeleteFile={onDeleteFile}
            onRenameFile={onRenameFile}
            onUploadToFolder={onUploadToFolder}
            onCreateSubfolder={onCreateSubfolder}
            onRenameFolder={onRenameFolder}
            onDeleteFolder={onDeleteFolder}
          />
        ))}
      </CollapsibleContent>

      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete folder?</AlertDialogTitle>
            <AlertDialogDescription>
              This will delete "{node.path}" and every file inside it. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteFolderAction}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? 'Deleting…' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Collapsible>
  )
}
