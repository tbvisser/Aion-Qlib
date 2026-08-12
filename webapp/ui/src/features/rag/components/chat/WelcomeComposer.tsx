import { useState, useRef, useEffect, useCallback } from 'react'
import { Send } from 'lucide-react'
import { ComposerMenu, ActiveModeChip, type ComposerMode } from '@/features/rag/components/chat/ComposerMenu'
import { AttachmentPreviewTray } from '@/features/rag/components/chat/AttachmentPreviewTray'
import { ChatFileDropOverlay } from '@/features/rag/components/chat/ChatFileDropOverlay'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { getPastedImageFile } from '@/features/rag/lib/clipboardFiles'
import { useFileDrop } from '@/features/rag/hooks/useFileDrop'
import {
  createPendingAttachment,
  revokePendingAttachment,
  type PendingAttachment,
} from '@/features/rag/lib/pendingAttachments'

interface WelcomeComposerProps {
  onSubmit: (payload: { message: string; attachments: File[]; mode: ComposerMode }) => Promise<void> | void
  busy: boolean
  placeholder?: string
  /** Increment to refocus the input and start a fresh composer (new chat). */
  focusToken?: number
  dropActive?: boolean
}

export function WelcomeComposer({
  onSubmit,
  busy,
  placeholder = 'Ask anything...',
  focusToken,
  dropActive = true,
}: WelcomeComposerProps) {
  const [welcomeInput, setWelcomeInput] = useState('')
  // Composer mode chosen on the welcome screen, carried into the new thread.
  const [welcomeMode, setWelcomeMode] = useState<ComposerMode>(null)
  const [welcomeAttachments, setWelcomeAttachments] = useState<PendingAttachment[]>([])
  const welcomeInputRef = useRef<HTMLTextAreaElement>(null)
  const welcomeAttachmentsRef = useRef<PendingAttachment[]>([])

  const hasWelcomeAttachments = welcomeAttachments.length > 0

  useEffect(() => {
    welcomeAttachmentsRef.current = welcomeAttachments
  }, [welcomeAttachments])

  useEffect(() => {
    return () => {
      welcomeAttachmentsRef.current.forEach(revokePendingAttachment)
    }
  }, [])

  // Start each new chat with a clean composer mode and no carried-over files.
  useEffect(() => {
    setWelcomeMode(null)
    setWelcomeAttachments(prev => {
      prev.forEach(revokePendingAttachment)
      return []
    })
  }, [focusToken])

  useEffect(() => {
    if (busy) return

    const frame = window.requestAnimationFrame(() => {
      welcomeInputRef.current?.focus()
    })

    return () => window.cancelAnimationFrame(frame)
  }, [busy, focusToken])

  useEffect(() => {
    const textarea = welcomeInputRef.current
    if (!textarea) return

    textarea.style.height = 'auto'
    const styles = getComputedStyle(textarea)
    const border =
      (parseFloat(styles.borderTopWidth) || 0) +
      (parseFloat(styles.borderBottomWidth) || 0)
    textarea.style.height = `${textarea.scrollHeight + border}px`
  }, [welcomeInput])

  const handleWelcomeSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if ((!welcomeInput.trim() && welcomeAttachments.length === 0) || busy) return

    const message = welcomeInput.trim()
    const attachments = welcomeAttachments
    try {
      await onSubmit({
        message,
        attachments: attachments.map(attachment => attachment.file),
        mode: welcomeMode,
      })
    } catch {
      // The host reports the failure; keep the composer contents for a retry.
      return
    }
    setWelcomeInput('')
    setWelcomeAttachments([])
    attachments.forEach(revokePendingAttachment)
  }

  const handleWelcomeUploadFiles = useCallback((files: File[]) => {
    if (files.length === 0) return
    setWelcomeAttachments(prev => [
      ...prev,
      ...files.map(createPendingAttachment),
    ])
  }, [])

  const handleWelcomeUpload = useCallback((file: File) => {
    handleWelcomeUploadFiles([file])
  }, [handleWelcomeUploadFiles])

  const handleRemoveWelcomeAttachment = (id: string) => {
    setWelcomeAttachments(prev => {
      const attachment = prev.find(item => item.id === id)
      if (attachment) revokePendingAttachment(attachment)
      return prev.filter(item => item.id !== id)
    })
  }

  const handleWelcomePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const imageFile = getPastedImageFile(e.clipboardData)
    if (!imageFile) return

    e.preventDefault()
    if (busy) return
    handleWelcomeUpload(imageFile)
  }

  const { draggingFiles: welcomeDraggingFiles } = useFileDrop({
    active: dropActive,
    disabled: busy,
    onFiles: handleWelcomeUploadFiles,
  })

  return (
    <>
      <ChatFileDropOverlay visible={welcomeDraggingFiles} />

      <form onSubmit={handleWelcomeSubmit} className="w-full max-w-xl px-4">
        <ActiveModeChip
          activeMode={welcomeMode}
          locked={false}
          onClear={() => setWelcomeMode(null)}
        />
        <div className={`relative focus-glow rounded-3xl ${hasWelcomeAttachments ? 'border border-border/50 bg-surface-2' : ''}`}>
          <AttachmentPreviewTray
            attachments={welcomeAttachments}
            onRemove={handleRemoveWelcomeAttachment}
            disabled={busy}
          />
          <Textarea
            ref={welcomeInputRef}
            value={welcomeInput}
            onChange={(e) => setWelcomeInput(e.target.value)}
            onPaste={handleWelcomePaste}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleWelcomeSubmit(e as unknown as React.FormEvent)
              }
            }}
            placeholder={placeholder}
            disabled={busy}
            rows={1}
            className={`min-h-[48px] max-h-[50vh] resize-none overflow-y-auto rounded-3xl pl-12 pr-12 py-3 text-base leading-6 transition-colors ${
              hasWelcomeAttachments
                ? 'border-0 bg-transparent focus-visible:ring-0 focus-visible:border-transparent'
                : 'bg-surface-2 border-border/50 focus:border-primary/50'
            }`}
          />
          <div className="absolute left-1.5 bottom-1.5 flex gap-1">
            <ComposerMenu
              activeMode={welcomeMode}
              onModeChange={setWelcomeMode}
              harnessLocked={false}
              onUpload={handleWelcomeUpload}
              uploading={busy}
              showContextStats={false}
              disabled={busy}
            />
          </div>
          <Button
            type="submit"
            size="icon"
            aria-label="Send message"
            className="absolute right-1.5 bottom-1.5 rounded-full h-9 w-9 bg-primary hover:bg-primary/90 transition-all duration-200 btn-press"
            disabled={(!welcomeInput.trim() && !hasWelcomeAttachments) || busy}
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </form>
    </>
  )
}
