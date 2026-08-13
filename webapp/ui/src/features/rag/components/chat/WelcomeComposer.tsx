import { useState, useRef, useEffect, useCallback } from 'react'
import { ActiveModeChip, type ComposerMode } from '@/features/rag/components/chat/ComposerMenu'
import { ComposerShell } from '@/features/rag/components/chat/ComposerShell'
import { AttachmentPreviewTray } from '@/features/rag/components/chat/AttachmentPreviewTray'
import { ChatFileDropOverlay } from '@/features/rag/components/chat/ChatFileDropOverlay'
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
  /** Fires when the composer gains or loses a draft (text or a pending file),
   *  so the host can let the page recede while the user is writing. */
  onDraftChange?: (hasDraft: boolean) => void
}

export function WelcomeComposer({
  onSubmit,
  busy,
  placeholder = 'Ask anything...',
  focusToken,
  dropActive = true,
  onDraftChange,
}: WelcomeComposerProps) {
  const [welcomeInput, setWelcomeInput] = useState('')
  // Composer mode chosen on the welcome screen, carried into the new thread.
  const [welcomeMode, setWelcomeMode] = useState<ComposerMode>(null)
  const [welcomeAttachments, setWelcomeAttachments] = useState<PendingAttachment[]>([])
  const welcomeInputRef = useRef<HTMLTextAreaElement>(null)
  const welcomeAttachmentsRef = useRef<PendingAttachment[]>([])

  const hasWelcomeAttachments = welcomeAttachments.length > 0
  const hasDraft = welcomeInput.trim().length > 0 || hasWelcomeAttachments

  useEffect(() => {
    onDraftChange?.(hasDraft)
  }, [hasDraft, onDraftChange])

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

      <form onSubmit={handleWelcomeSubmit} className="w-full max-w-2xl px-4">
        <ActiveModeChip
          activeMode={welcomeMode}
          locked={false}
          onClear={() => setWelcomeMode(null)}
        />
        <ComposerShell
          value={welcomeInput}
          onChange={setWelcomeInput}
          onPaste={handleWelcomePaste}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              handleWelcomeSubmit(e as unknown as React.FormEvent)
            }
          }}
          placeholder={placeholder}
          disabled={busy}
          inputRef={welcomeInputRef}
          attachmentsSlot={
            <AttachmentPreviewTray
              attachments={welcomeAttachments}
              onRemove={handleRemoveWelcomeAttachment}
              disabled={busy}
            />
          }
          activeMode={welcomeMode}
          onModeChange={setWelcomeMode}
          harnessLocked={false}
          onUpload={handleWelcomeUpload}
          uploading={busy}
          showContextStats={false}
          canSend={hasDraft}
        />
      </form>
    </>
  )
}
