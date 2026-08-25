import { File, FileImage, X } from 'lucide-react'
import { formatAttachmentSize, type PendingAttachment } from '@/features/rag/lib/pendingAttachments'

interface AttachmentPreviewTrayProps {
  attachments: PendingAttachment[]
  onRemove: (id: string) => void
  disabled?: boolean
}

export function AttachmentPreviewTray({ attachments, onRemove, disabled }: AttachmentPreviewTrayProps) {
  if (attachments.length === 0) return null

  return (
    <div className="flex gap-2 overflow-x-auto px-3 pt-3 pb-1">
      {attachments.map((attachment) => {
        const image = attachment.previewUrl && attachment.file.type.startsWith('image/')
        return (
          <div
            key={attachment.id}
            data-testid="pending-attachment"
            className="relative h-20 w-20 shrink-0 overflow-hidden rounded-lg border border-border/60 bg-surface-1"
            title={attachment.file.name}
          >
            {image ? (
              <img
                src={attachment.previewUrl ?? undefined}
                alt={attachment.file.name}
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full w-full flex-col items-center justify-center gap-1 px-2 text-muted-foreground">
                {attachment.file.type.startsWith('image/') ? (
                  <FileImage className="h-5 w-5" />
                ) : (
                  <File className="h-5 w-5" />
                )}
                <span className="max-w-full truncate text-micro">{attachment.file.name}</span>
              </div>
            )}
            <button
              type="button"
              aria-label={`Remove ${attachment.file.name}`}
              disabled={disabled}
              onClick={() => onRemove(attachment.id)}
              className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-background/90 text-foreground shadow-sm transition-colors hover:bg-background disabled:opacity-60"
            >
              <X className="h-3.5 w-3.5" />
            </button>
            <div className="absolute bottom-0 left-0 right-0 bg-background/85 px-1.5 py-0.5 text-micro text-muted-foreground">
              <span className="block truncate">{formatAttachmentSize(attachment.file.size)}</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}
