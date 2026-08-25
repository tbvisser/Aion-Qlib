import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import { cn } from '@/lib/utils'
import { SkeletonText } from '@/components/ui/skeleton'
import { SkillList } from '@/features/rag/components/skills/SkillList'
import { SkillEditor } from '@/features/rag/components/skills/SkillEditor'
import { SkillFilePreview } from '@/features/rag/components/skills/SkillFilePreview'
import { SkillsHome } from '@/features/rag/components/skills/SkillsHome'
import { CreateSkillDialog } from '@/features/rag/components/skills/CreateSkillDialog'
import { ImportFromUrlDialog } from '@/features/rag/components/skills/ImportFromUrlDialog'
import {
  listSkills,
  importSkills,
  importSkillFromUrl,
  deleteSkillFile,
  uploadSkillFile,
  renameSkillFile,
  createSkillFolder,
  renameSkillFolder,
  deleteSkillFolder,
} from '@/features/rag/lib/api'
import type { Skill, SkillFile, SkillImportResponse } from '@/features/rag/types'

export function SkillsPage() {
  const { skillId: urlSkillId } = useParams<{ skillId?: string }>()
  const { user } = useAuth()
  const navigate = useNavigate()
  const [skills, setSkills] = useState<Skill[]>([])
  const [selectedFile, setSelectedFile] = useState<SkillFile | null>(null)
  const [loading, setLoading] = useState(true)
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [showImportUrlDialog, setShowImportUrlDialog] = useState(false)
  const [importMessage, setImportMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  // Bumped whenever a skill's file list changes (upload from editor, delete from sidebar).
  // Causes the SkillList tree to refetch its files.
  const [fileRefreshKey, setFileRefreshKey] = useState(0)
  // Tracks whether the pending URL change was triggered by a file selection (so we don't clear it).
  const preserveFileOnNav = useRef(false)
  // Hidden input used when uploading into a folder via the sidebar context menu.
  const folderUploadInputRef = useRef<HTMLInputElement>(null)
  const pendingFolderUploadRef = useRef<{ skill: Skill; folderPath: string } | null>(null)

  const selectedSkill = urlSkillId ? skills.find(s => s.id === urlSkillId) ?? null : null

  const loadSkills = useCallback(async () => {
    if (!user) return
    try {
      const data = await listSkills()
      setSkills(data)
    } catch (error) {
      console.error('Failed to load skills:', error)
    } finally {
      setLoading(false)
    }
  }, [user])

  useEffect(() => {
    loadSkills()
  }, [loadSkills])

  // Clear file preview when skill changes via URL (but not when the nav was triggered by a file selection).
  useEffect(() => {
    if (preserveFileOnNav.current) {
      preserveFileOnNav.current = false
      return
    }
    setSelectedFile(null)
  }, [urlSkillId])

  const handleSelectSkill = (skill: Skill) => {
    setSelectedFile(null)
    navigate(`/lab/roster/${skill.id}`)
  }

  // "Use skill" jumps into a fresh chat with a kickoff prompt that names the
  // skill, prompting the assistant to activate it (mirrors the editor's
  // "Try in Chat" action).
  const handleUseSkill = (skill: Skill) => {
    navigate('/dashboard', {
      state: {
        initialMessage: `Let's kick off my "${skill.name}" skill?`,
      },
    })
  }

  const handleCreateWithAI = () => {
    navigate('/dashboard', {
      state: {
        initialMessage: "Let's create a skill together. First ask me what the skill should do."
      }
    })
  }

  const handleCreateManually = () => {
    setShowCreateDialog(true)
  }

  const handleSkillCreated = async (skill: Skill) => {
    setShowCreateDialog(false)
    setSkills(prev => [skill, ...prev])
    navigate(`/lab/roster/${skill.id}`)
  }

  const handleSkillUpdated = async (updatedSkill: Skill) => {
    setSkills(prev => prev.map(s => s.id === updatedSkill.id ? updatedSkill : s))
  }

  const handleSkillDeleted = async () => {
    navigate('/lab/roster')
    await loadSkills()
  }

  const handleDeleteFile = async (skill: Skill, file: SkillFile) => {
    await deleteSkillFile(skill.id, file.id)
    if (selectedFile?.id === file.id) setSelectedFile(null)
    setFileRefreshKey(k => k + 1)
  }

  const handleRenameFile = async (skill: Skill, file: SkillFile, newFilename: string) => {
    const updated = await renameSkillFile(skill.id, file.id, newFilename)
    if (selectedFile?.id === file.id) setSelectedFile(updated)
    setFileRefreshKey(k => k + 1)
  }

  const handleCreateSubfolder = async (skill: Skill, parentPath: string, name: string) => {
    const path = parentPath ? `${parentPath}/${name}` : name
    await createSkillFolder(skill.id, path)
    setFileRefreshKey(k => k + 1)
  }

  const handleRenameFolder = async (skill: Skill, oldPath: string, newPath: string) => {
    await renameSkillFolder(skill.id, oldPath, newPath)
    // If the previewed file lived inside the renamed folder, close the preview
    // (its identifier path is now stale).
    if (selectedFile && selectedFile.filename.startsWith(`${oldPath}/`)) {
      setSelectedFile(null)
    }
    setFileRefreshKey(k => k + 1)
  }

  const handleDeleteFolder = async (skill: Skill, folderPath: string) => {
    await deleteSkillFolder(skill.id, folderPath)
    if (selectedFile && selectedFile.filename.startsWith(`${folderPath}/`)) {
      setSelectedFile(null)
    }
    setFileRefreshKey(k => k + 1)
  }

  const handleUploadToFolder = (skill: Skill, folderPath: string) => {
    pendingFolderUploadRef.current = { skill, folderPath }
    folderUploadInputRef.current?.click()
  }

  const handleFolderUploadInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    const pending = pendingFolderUploadRef.current
    pendingFolderUploadRef.current = null
    if (folderUploadInputRef.current) folderUploadInputRef.current.value = ''
    if (!file || !pending) return
    try {
      await uploadSkillFile(pending.skill.id, file, pending.folderPath)
      setFileRefreshKey(k => k + 1)
    } catch (err) {
      setImportMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'Upload failed',
      })
      setTimeout(() => setImportMessage(null), 5000)
    }
  }

  // Shared success path for both import flows: refresh, auto-select the first
  // imported skill, and show the success banner.
  const onImportSucceeded = useCallback(async (result: SkillImportResponse) => {
    await loadSkills()
    const firstImported = result.results.find(r => r.success && r.skill_id)
    if (firstImported?.skill_id) {
      navigate(`/lab/roster/${firstImported.skill_id}`)
    }
    setImportMessage({ type: 'success', text: `Imported ${result.imported} skill${result.imported > 1 ? 's' : ''}${result.failed > 0 ? `, ${result.failed} failed` : ''}` })
    setTimeout(() => setImportMessage(null), 5000)
  }, [loadSkills, navigate])

  const handleImportFile = async (file: File) => {
    setImportMessage(null)
    try {
      const result = await importSkills(file)
      if (result.imported > 0) {
        await onImportSucceeded(result)
      } else {
        const firstError = result.results.find(r => r.error)?.error || 'Unknown error'
        setImportMessage({ type: 'error', text: `Import failed: ${firstError}` })
        setTimeout(() => setImportMessage(null), 5000)
      }
    } catch (err) {
      setImportMessage({ type: 'error', text: err instanceof Error ? err.message : 'Import failed' })
      setTimeout(() => setImportMessage(null), 5000)
    }
  }

  // Used by ImportFromUrlDialog. Throws on failure so the dialog can surface the
  // error inline and stay open; resolves (and the dialog closes) on success.
  const handleImportFromUrl = async (source: string) => {
    setImportMessage(null)
    const result = await importSkillFromUrl(source)
    if (result.imported > 0) {
      await onImportSucceeded(result)
      return
    }
    const firstError = result.results.find(r => r.error)?.error || 'Import failed'
    throw new Error(firstError)
  }

  // Layout chrome (sidebar, mobile top bar) lives outside the page here — App
  // renders AppSidebar beside <main> and this fills <main>. So the skill tree
  // that was the RAG app's sidebar payload becomes an in-page left column,
  // matching the list+detail idiom of /book and /runs.
  return (
    <div className="flex h-full min-h-0 flex-1 overflow-hidden">
      {/* Hidden input used by the tree's "Upload File" folder action. */}
      <input
        ref={folderUploadInputRef}
        type="file"
        className="hidden"
        onChange={handleFolderUploadInputChange}
      />

      <aside className="flex w-72 shrink-0 flex-col overflow-y-auto border-r border-border/50">
        <SkillList
          skills={skills}
          selectedSkillId={selectedSkill?.id ?? null}
          selectedFileId={selectedFile?.id ?? null}
          onSelectSkill={handleSelectSkill}
          onSelectFile={(skill, file) => {
            setSelectedFile(file)
            if (skill.id !== selectedSkill?.id) {
              preserveFileOnNav.current = true
              navigate(`/lab/roster/${skill.id}`)
            }
          }}
          onDeleteFile={handleDeleteFile}
          onRenameFile={handleRenameFile}
          onUploadToFolder={handleUploadToFolder}
          onCreateSubfolder={handleCreateSubfolder}
          onRenameFolder={handleRenameFolder}
          onDeleteFolder={handleDeleteFolder}
          onCreateWithAI={handleCreateWithAI}
          onCreateManually={handleCreateManually}
          onImportFile={handleImportFile}
          onImportUrl={() => setShowImportUrlDialog(true)}
          loading={loading}
          fileRefreshKey={fileRefreshKey}
        />
      </aside>

      {/* Main content */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* Import feedback banner */}
        {importMessage && (
          <div className={cn('px-4 py-2 text-sm', importMessage.type === 'success' ? 'bg-primary/10 text-primary border-b border-primary/20' : 'bg-destructive/10 text-destructive border-b border-destructive/20')}>
            {importMessage.text}
          </div>
        )}
        <div className="flex min-h-0 flex-1">
          {selectedSkill ? (
            <>
              <div className="min-w-0 flex-1 overflow-auto">
                <SkillEditor
                  skill={selectedSkill}
                  onSkillUpdated={handleSkillUpdated}
                  onSkillDeleted={handleSkillDeleted}
                />
              </div>
              {selectedFile && (
                <div className="w-1/2 min-w-0 shrink-0">
                  <SkillFilePreview
                    file={selectedFile}
                    skillId={selectedSkill.id}
                    onClose={() => setSelectedFile(null)}
                  />
                </div>
              )}
            </>
          ) : urlSkillId && loading ? (
            <div className="p-6">
              <SkeletonText lines={4} />
            </div>
          ) : (
            <div className="relative flex-1">
              <SkillsHome
                skills={skills}
                onCreateWithAI={handleCreateWithAI}
                onCreateManually={handleCreateManually}
                onImportFile={handleImportFile}
                onImportUrl={() => setShowImportUrlDialog(true)}
                onUseSkill={handleUseSkill}
                onViewSkill={handleSelectSkill}
              />
            </div>
          )}
        </div>
      </div>

      {/* Create Skill Dialog */}
      {showCreateDialog && (
        <CreateSkillDialog
          open={showCreateDialog}
          onOpenChange={setShowCreateDialog}
          onSkillCreated={handleSkillCreated}
        />
      )}

      {/* Import from URL Dialog */}
      <ImportFromUrlDialog
        open={showImportUrlDialog}
        onOpenChange={setShowImportUrlDialog}
        onSubmit={handleImportFromUrl}
      />
    </div>
  )
}
