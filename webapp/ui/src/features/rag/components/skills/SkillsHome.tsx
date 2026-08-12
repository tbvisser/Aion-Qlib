import { useRef } from 'react'
import { Sparkles, PenLine, Upload, Globe, Zap, MessageSquare, Pencil } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { useAuth } from '@/hooks/useAuth'
import type { Skill } from '@/features/rag/types'

interface SkillsHomeProps {
  skills: Skill[]
  onCreateWithAI: () => void
  onCreateManually: () => void
  onImportFile: (file: File) => void
  onImportUrl: () => void
  onUseSkill: (skill: Skill) => void
  onViewSkill: (skill: Skill) => void
}

export function SkillsHome({
  skills,
  onCreateWithAI,
  onCreateManually,
  onImportFile,
  onImportUrl,
  onUseSkill,
  onViewSkill,
}: SkillsHomeProps) {
  const importInputRef = useRef<HTMLInputElement>(null)

  const handleImportChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) onImportFile(file)
    if (importInputRef.current) importInputRef.current.value = ''
  }

  return (
    <div className="absolute inset-0 overflow-auto animate-fade-in">
      <input
        ref={importInputRef}
        type="file"
        accept=".zip"
        className="hidden"
        onChange={handleImportChange}
      />
      <div className="p-4 sm:p-6 lg:p-8 space-y-8">
        {/* Heading */}
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Agent Skills</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Reusable instructions the assistant loads on demand. Add a new skill or pick one to use.
          </p>
        </div>

        {/* Add-skill options — mirrors the "New Skill" dropdown */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <AddSkillCard
            icon={Sparkles}
            title="Create with AI"
            description="Describe what you want and let the assistant build it."
            onClick={onCreateWithAI}
          />
          <AddSkillCard
            icon={PenLine}
            title="Create manually"
            description="Write the name, description, and instructions yourself."
            onClick={onCreateManually}
          />
          <AddSkillCard
            icon={Upload}
            title="Import from file"
            description="Upload a skill packaged as a .zip archive."
            onClick={() => importInputRef.current?.click()}
          />
          <AddSkillCard
            icon={Globe}
            title="Import from URL"
            description="Pull a skill from a GitHub repo or registry link."
            onClick={onImportUrl}
          />
        </div>

        {/* Existing skills */}
        <div className="space-y-3">
          <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Your skills
          </h2>
          {skills.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border/60 py-12 text-center">
              <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-muted/50">
                <Zap className="h-6 w-6 text-muted-foreground" />
              </div>
              <p className="text-sm font-medium">No skills yet</p>
              <p className="mt-0.5 text-sm text-muted-foreground">
                Use one of the options above to add your first skill.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {skills.map((skill) => (
                <SkillCard
                  key={skill.id}
                  skill={skill}
                  onUse={() => onUseSkill(skill)}
                  onView={() => onViewSkill(skill)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

interface AddSkillCardProps {
  icon: React.ComponentType<{ className?: string }>
  title: string
  description: string
  onClick: () => void
}

function AddSkillCard({ icon: Icon, title, description, onClick }: AddSkillCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex flex-col items-start gap-3 rounded-xl border border-border/50 bg-card p-4 text-left shadow-card transition-all duration-200 btn-press hover:border-border hover:bg-accent/40 hover:shadow-md"
    >
      <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary transition-colors group-hover:bg-primary/15">
        <Icon className="h-5 w-5" />
      </div>
      <div>
        <div className="text-sm font-medium">{title}</div>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </div>
    </button>
  )
}

interface SkillCardProps {
  skill: Skill
  onUse: () => void
  onView: () => void
}

function SkillCard({ skill, onUse, onView }: SkillCardProps) {
  const { user } = useAuth()
  const isGlobal = skill.user_id === null

  return (
    <Card
      className={cn(
        'flex flex-col gap-3 p-4 transition-all duration-200 hover:border-border hover:shadow-md',
        !skill.enabled && 'opacity-60'
      )}
    >
      <div className="flex items-start gap-2.5">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">
          <Zap className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-sm font-medium">{skill.name}</span>
            {isGlobal && (
              <span className="inline-flex items-center gap-0.5 rounded-full bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-medium text-blue-500">
                <Globe className="h-2.5 w-2.5" />
                Global
              </span>
            )}
            {!skill.enabled && (
              <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                Disabled
              </span>
            )}
          </div>
        </div>
      </div>

      <p className="line-clamp-2 min-h-[2.5rem] flex-1 text-sm text-muted-foreground">
        {skill.description}
      </p>

      <div className="flex items-center gap-2 pt-1">
        <Button size="sm" className="flex-1" onClick={onUse}>
          <MessageSquare className="mr-1.5 h-3.5 w-3.5" />
          Use skill
        </Button>
        <Button size="sm" variant="outline" className="flex-1" onClick={onView}>
          <Pencil className="mr-1.5 h-3.5 w-3.5" />
          View &amp; edit
        </Button>
      </div>

      {/* Owner-attribution for shared/global skills the current user doesn't own */}
      {isGlobal && skill.shared_by && skill.shared_by !== user?.id && (
        <p className="text-[11px] text-muted-foreground">Shared globally</p>
      )}
    </Card>
  )
}
