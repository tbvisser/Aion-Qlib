import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { createSkill } from '@/lib/api'
import type { Skill } from '@/types'

interface CreateSkillDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSkillCreated: (skill: Skill) => void
}

interface FormErrors {
  name?: string
  description?: string
  instructions?: string
}

const NAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

export function CreateSkillDialog({ open, onOpenChange, onSkillCreated }: CreateSkillDialogProps) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [instructions, setInstructions] = useState('')
  const [errors, setErrors] = useState<FormErrors>({})
  const [submitting, setSubmitting] = useState(false)
  const [apiError, setApiError] = useState<string | null>(null)

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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setApiError(null)

    if (!validate()) return

    setSubmitting(true)
    try {
      const skill = await createSkill({
        name: name.trim(),
        description: description.trim(),
        instructions: instructions.trim(),
      })
      onSkillCreated(skill)
      onOpenChange(false)
    } catch (err) {
      setApiError(err instanceof Error ? err.message : 'Failed to create skill')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create Skill</DialogTitle>
          <DialogDescription>
            Define a new skill with instructions the AI will follow when activated.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Name */}
          <div className="space-y-2">
            <Label htmlFor="skill-name">Name</Label>
            <Input
              id="skill-name"
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
            <Label htmlFor="skill-description">Description</Label>
            <Textarea
              id="skill-description"
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
            <Label htmlFor="skill-instructions">Instructions</Label>
            <Textarea
              id="skill-instructions"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="Enter the instructions the AI should follow..."
              className="font-mono"
              rows={8}
            />
            <p className="text-xs text-muted-foreground">
              Supports Markdown — use headings, code blocks, and checklists
            </p>
            {errors.instructions && (
              <p className="text-xs text-destructive">{errors.instructions}</p>
            )}
          </div>

          {/* API Error */}
          {apiError && (
            <div className="rounded-lg bg-destructive/10 border border-destructive/20 px-3 py-2">
              <p className="text-sm text-destructive">{apiError}</p>
            </div>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? 'Creating...' : 'Create Skill'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
