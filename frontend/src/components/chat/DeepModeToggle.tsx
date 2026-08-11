import { Zap } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface DeepModeToggleProps {
  isActive: boolean
  onToggle: () => void
  disabled?: boolean
}

export function DeepModeToggle({ isActive, onToggle, disabled }: DeepModeToggleProps) {
  return (
    <Button
      type="button"
      variant={isActive ? 'default' : 'ghost'}
      size="icon"
      className={`rounded-full h-9 w-9 transition-all duration-200 btn-press ${
        isActive
          ? 'bg-amber-500 hover:bg-amber-600 text-white'
          : 'text-muted-foreground hover:text-foreground'
      }`}
      onClick={onToggle}
      disabled={disabled}
      aria-label="Deep Mode"
      title="Deep Mode"
    >
      <Zap className={`h-4 w-4 ${isActive ? 'fill-current' : ''}`} />
    </Button>
  )
}
