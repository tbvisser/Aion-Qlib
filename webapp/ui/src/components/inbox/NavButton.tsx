import { cn } from '@/lib/utils'

/** The step-back/step-forward control shared by the month and week headers. */
export function NavButton({ label, disabled, onClick, children }: {
  label: string
  disabled: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors',
        disabled ? 'opacity-40' : 'hover:bg-foreground/[0.04] hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}
