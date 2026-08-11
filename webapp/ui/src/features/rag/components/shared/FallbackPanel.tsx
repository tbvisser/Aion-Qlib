import { Download, FileDown } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface FallbackPanelProps {
  message: string
  fileName: string
  onDownload: () => void
}

export function FallbackPanel({ message, fileName, onDownload }: FallbackPanelProps) {
  const shortName = fileName.split('/').pop() ?? fileName
  return (
    <div className="flex flex-col items-center justify-center h-full gap-4 text-center">
      <FileDown className="h-12 w-12 text-muted-foreground" />
      <p className="text-sm text-muted-foreground max-w-sm">{message}</p>
      <Button onClick={onDownload} variant="outline" className="gap-2">
        <Download className="h-4 w-4" />
        Download {shortName}
      </Button>
    </div>
  )
}
