/**
 * The generated config, one click away.
 *
 * Never a client-side approximation: this is the backend's own render of the
 * file qrun is handed, which is why the sentence underneath can be true.
 */
import { FileCode2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'

export function YamlDialog({ yaml }: { yaml: string }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <FileCode2 className="h-4 w-4" />
          Config
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="text-sm">Generated workflow config</DialogTitle>
        </DialogHeader>
        <pre className="max-h-[65vh] overflow-auto rounded-lg bg-surface-2 p-3 font-mono text-label leading-relaxed">
          {yaml || 'Building preview…'}
        </pre>
        <p className="text-label text-muted-foreground">
          This exact file is handed to <span className="font-mono">qrun</span>. Running it
          from a terminal produces the same result as the Run button.
        </p>
      </DialogContent>
    </Dialog>
  )
}
