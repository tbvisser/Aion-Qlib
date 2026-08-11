import { FileUp } from 'lucide-react'

interface ChatFileDropOverlayProps {
  visible: boolean
}

export function ChatFileDropOverlay({ visible }: ChatFileDropOverlayProps) {
  if (!visible) return null

  return (
    <div
      data-testid="chat-file-drop-overlay"
      className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-background/85 p-6 backdrop-blur-sm animate-fade-in"
    >
      <div className="flex max-w-sm flex-col items-center gap-4 text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-lg bg-primary/10">
          <FileUp className="h-8 w-8 text-primary" />
        </div>
        <div className="space-y-1">
          <h2 className="text-xl font-semibold tracking-tight">Add files</h2>
          <p className="text-sm text-muted-foreground">
            Drop files to attach them to this conversation.
          </p>
        </div>
      </div>
    </div>
  )
}
