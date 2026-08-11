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
  'inline-flex items-center rounded px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider',
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

export function Badge({
  className,
  variant,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />
}
