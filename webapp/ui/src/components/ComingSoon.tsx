import { Card, CardContent } from '@/components/ui/card'

/**
 * Honest placeholder for a route that exists but isn't built yet.
 *
 * Deliberately not a fake mockup: it says which phase delivers the page, so an
 * empty screen is never mistaken for a broken one.
 */
export function ComingSoon({ phase, children }: { phase: string; children: React.ReactNode }) {
  return (
    <Card className="mx-auto max-w-2xl border-dashed">
      <CardContent className="space-y-2 p-8 text-center">
        <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
          {phase}
        </div>
        <div className="text-sm text-muted-foreground">{children}</div>
      </CardContent>
    </Card>
  )
}
