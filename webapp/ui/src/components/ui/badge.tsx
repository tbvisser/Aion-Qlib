import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

/**
 * The small mono pill already hand-rolled across IndicatorsPage, DatabankPage
 * and RunsPage, with the same classes those pages use.
 *
 * `clay` is a statistical verdict (a loss, a negative relationship);
 * `destructive` is not offered here because an error is not a badge.
 */
const badgeVariants = cva(
  'inline-flex items-center rounded px-1.5 py-0.5 text-tiny uppercase tracking-wider',
  {
    variants: {
      variant: {
        muted: 'bg-muted text-muted-foreground',
        primary: 'bg-primary/10 text-primary',
        clay: 'bg-clay/10 text-clay',
        outline: 'border border-border/50 text-muted-foreground',
      },
    },
    defaultVariants: { variant: 'muted' },
  },
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {
  font?: 'sans' | 'mono'
}

export function Badge({
  className,
  variant,
  font = 'mono',
  ...props
}: BadgeProps) {
  return (
    <span
      className={cn(badgeVariants({ variant }), font === 'sans' ? 'font-sans' : 'font-mono', className)}
      {...props}
    />
  )
}
