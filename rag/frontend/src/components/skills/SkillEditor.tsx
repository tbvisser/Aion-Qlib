import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { updateSkill, deleteSkill, toggleSkillSharing, exportSkill } from '@/lib/api'
import type { Skill } from '@/types'
import { Save, Trash2, Globe, Lock, MessageSquare, Download, ExternalLink } from 'lucide-react'

interface SkillEditorProps {
  skill: Skill
  onSkillUpdated: (skill: Skill) => void
  onSkillDeleted: (skillId: string) => void
}

interface FormErrors {
  name?: string
  description?: string
  instructions?: string
}

const NAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

export function SkillEditor({ skill, onSkillUpdated, onSkillDeleted }: SkillEditorProps) {
  const navigate = useNavigate()
  const { user } = useAuth()

  // Local form state
  const [name, setName] = useState(skill.name)
  const [description, setDescription] = useState(skill.description)
  const [instructions, setInstructions] = useState(skill.instructions)
  const [enabled, setEnabled] = useState(skill.enabled)

  const [errors, setErrors] = useState<FormErrors>({})
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [apiError, setApiError] = useState<string | null>(null)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)

  // Export state
  const [exporting, setExporting] = useState(false)

  // Re-initialize when skill prop changes
  useEffect(() => {
    setName(skill.name)
    setDescription(skill.description)
    setInstructions(skill.instructions)
    setEnabled(skill.enabled)
    setErrors({})
    setApiError(null)
    setShowDeleteConfirm(false)
  }, [skill.id, skill.name, skill.description, skill.instructions, skill.enabled])

  const isGlobal = skill.user_id === null
  const isOwnedByCurrentUser = skill.user_id === user?.id
  const isSharedByCurrentUser = isGlobal && skill.shared_by === user?.id

  const validate = (): boolean => {
    const newErrors: FormErrors = {}

    if (!name.trim()) {
      newErrors.name = 'Name is required'
    } else if (!NAME_PATTERN.test(name)) {
      newErrors.name = 'Must start and end with a letter or number. Only lowercase letters, numbers, and hyphens allowed.'
    } else if (name.includes('--')) {
      newErrors.name = 'Name cannot contain consecutive hyphens'
    } else if (name.length > 64) {
      newErrors.name = 'Name must be 64 characters or less'
    }

    if (!description.trim()) {
      newErrors.description = 'Description is required'
    } else if (description.length < 20) {
      newErrors.description = 'Description must be at least 20 characters'
    } else if (description.length > 1024) {
      newErrors.description = 'Description must be 1024 characters or less'
    }

    if (!instructions.trim()) {
      newErrors.instructions = 'Instructions are required'
    }

    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  const handleToggleEnabled = async (newEnabled: boolean) => {
    setEnabled(newEnabled)
    try {
      const updated = await updateSkill(skill.id, { enabled: newEnabled })
      onSkillUpdated(updated)
    } catch (err) {
      // Revert on error
      setEnabled(skill.enabled)
      setApiError(err instanceof Error ? err.message : 'Failed to update skill')
    }
  }

  const handleSave = async () => {
    setApiError(null)
    if (!validate()) return

    setSaving(true)
    try {
      // Collect changed fields
      const changes: Record<string, string | boolean> = {}
      if (name !== skill.name) changes.name = name.trim()
      if (description !== skill.description) changes.description = description.trim()
      if (instructions !== skill.instructions) changes.instructions = instructions.trim()

      // Update skill fields if any changed
      let updated = skill
      if (Object.keys(changes).length > 0) {
        updated = await updateSkill(skill.id, changes)
      }

      onSkillUpdated(updated)
    } catch (err) {
      setApiError(err instanceof Error ? err.message : 'Failed to save skill')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    setDeleting(true)
    try {
      await deleteSkill(skill.id)
      onSkillDeleted(skill.id)
    } catch (err) {
      setApiError(err instanceof Error ? err.message : 'Failed to delete skill')
      setDeleting(false)
    }
  }

  const handleToggleSharing = async () => {
    setSharing(true)
    setApiError(null)
    try {
      const updated = await toggleSkillSharing(skill.id, !isGlobal)
      onSkillUpdated(updated)
    } catch (err) {
      setApiError(err instanceof Error ? err.message : 'Failed to update sharing')
    } finally {
      setSharing(false)
    }
  }

  const handleExport = async () => {
    setExporting(true)
    setApiError(null)
    try {
      const blob = await exportSkill(skill.id)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${skill.name}.zip`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (err) {
      setApiError(err instanceof Error ? err.message : 'Export failed')
    } finally {
      setExporting(false)
    }
  }

  const handleTryInChat = () => {
    navigate('/chat', {
      state: {
        initialMessage: `Let's kick off my "${skill.name}" skill?`,
      },
    })
  }

  return (
    <div className="p-8 space-y-6">
      {/* Header row: name + enabled toggle */}
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold truncate">{skill.name}</h1>
        <div className="flex items-center gap-2 shrink-0">
          <Switch
            checked={enabled}
            onCheckedChange={handleToggleEnabled}
          />
          <Label className="text-sm text-muted-foreground">
            {enabled ? 'Enabled' : 'Disabled'}
          </Label>
        </div>
      </div>

      {/* Provenance: shown when the skill was imported from a remote registry */}
      {skill.source_url && (
        <a
          href={skill.source_url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors -mt-2"
        >
          <ExternalLink className="h-3 w-3" />
          <span className="truncate">Imported from {skill.source_url}</span>
        </a>
      )}

      {/* Toolbar row */}
      <div className="flex items-center gap-2 flex-wrap">
        <Button
          variant="default"
          size="sm"
          onClick={handleSave}
          disabled={saving}
        >
          <Save className="mr-2 h-4 w-4" />
          {saving ? 'Saving...' : 'Save'}
        </Button>

        {/* Delete only for user-owned skills */}
        {isOwnedByCurrentUser && !showDeleteConfirm && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowDeleteConfirm(true)}
            disabled={deleting}
          >
            <Trash2 className="mr-2 h-4 w-4" />
            Delete
          </Button>
        )}

        {showDeleteConfirm && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-destructive">Delete this skill?</span>
            <Button
              variant="destructive"
              size="sm"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting ? 'Deleting...' : 'Confirm'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowDeleteConfirm(false)}
              disabled={deleting}
            >
              Cancel
            </Button>
          </div>
        )}

        {/* Share/Unshare: show "Share Globally" for private skills, "Make Private" for skills shared by current user */}
        {isOwnedByCurrentUser && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleToggleSharing}
            disabled={sharing}
          >
            <Globe className="mr-2 h-4 w-4" />
            {sharing ? 'Updating...' : 'Share Globally'}
          </Button>
        )}
        {isSharedByCurrentUser && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleToggleSharing}
            disabled={sharing}
          >
            <Lock className="mr-2 h-4 w-4" />
            {sharing ? 'Updating...' : 'Make Private'}
          </Button>
        )}

        <Button variant="outline" size="sm" onClick={handleTryInChat}>
          <MessageSquare className="mr-2 h-4 w-4" />
          Try in Chat
        </Button>

        <Button
          variant="outline"
          size="sm"
          onClick={handleExport}
          disabled={exporting}
        >
          <Download className="mr-2 h-4 w-4" />
          {exporting ? 'Exporting...' : 'Export'}
        </Button>
      </div>

      {/* API Error */}
      {apiError && (
        <div className="rounded-lg bg-destructive/10 border border-destructive/20 px-3 py-2">
          <p className="text-sm text-destructive">{apiError}</p>
        </div>
      )}

      {/* Form fields */}
      <div className="space-y-4">
        {/* Name */}
        <div className="space-y-2">
          <Label htmlFor="editor-name">Name</Label>
          <Input
            id="editor-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g., analyzing-sales-data"
            maxLength={64}
          />
          <p className="text-xs text-muted-foreground">
            Lowercase letters, numbers, and hyphens only. Max 64 characters.
          </p>
          {errors.name && (
            <p className="text-xs text-destructive">{errors.name}</p>
          )}
        </div>

        {/* Description */}
        <div className="space-y-2">
          <Label htmlFor="editor-description">Description</Label>
          <Textarea
            id="editor-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Analyzes sales data and generates reports. Use when the user asks about revenue, pipeline, or quarterly metrics."
            rows={3}
            maxLength={1024}
          />
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              Write in third person. Include what the skill does AND when to use it.
            </p>
            <span className="text-xs text-muted-foreground tabular-nums">
              {description.length} / 1024
            </span>
          </div>
          {errors.description && (
            <p className="text-xs text-destructive">{errors.description}</p>
          )}
        </div>

        {/* Instructions */}
        <div className="space-y-2">
          <Label htmlFor="editor-instructions">Instructions</Label>
          <Textarea
            id="editor-instructions"
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="Enter the instructions the AI should follow..."
            className="font-mono"
            rows={12}
          />
          <p className="text-xs text-muted-foreground">
            Supports Markdown — use headings, code blocks, and checklists
          </p>
          {errors.instructions && (
            <p className="text-xs text-destructive">{errors.instructions}</p>
          )}
        </div>
      </div>
    </div>
  )
}
