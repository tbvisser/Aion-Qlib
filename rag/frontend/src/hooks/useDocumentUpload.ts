import { useCallback, useEffect, useState } from 'react'
import { uploadDocument } from '@/lib/api'

export const DOCUMENT_UPLOAD_ACCEPT = '.txt,.md,.pdf,.docx,.pptx,.xlsx,.html,.htm,.png,.jpg,.jpeg,.tiff'
export const DOCUMENT_UPLOAD_FORMAT_LABEL = 'PDF, DOCX, PPTX, XLSX, TXT, MD, HTML, Images (max 50 MB)'

const ALLOWED_EXTENSIONS = ['.txt', '.md', '.pdf', '.docx', '.pptx', '.xlsx', '.html', '.htm', '.png', '.jpg', '.jpeg', '.tiff']

interface UseDocumentUploadOptions {
  onUploadComplete: () => void | Promise<void>
  onSkipped?: () => void | Promise<void>
  folderId?: string | null
}

export interface DocumentUploadFeedback {
  message: string
  type: 'success' | 'info'
}

function validateFile(file: File): string | null {
  const ext = '.' + file.name.split('.').pop()?.toLowerCase()
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    return `Unsupported file type. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`
  }
  if (file.size > 50 * 1024 * 1024) {
    return 'File too large. Maximum size is 50 MB.'
  }
  return null
}

export function useDocumentUpload({ onUploadComplete, onSkipped, folderId }: UseDocumentUploadOptions) {
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<DocumentUploadFeedback | null>(null)

  useEffect(() => {
    if (!feedback) return
    const timer = window.setTimeout(() => setFeedback(null), 5000)
    return () => window.clearTimeout(timer)
  }, [feedback])

  const reset = useCallback(() => {
    setError(null)
    setFeedback(null)
  }, [])

  const handleUpload = useCallback(async (files: FileList | File[]) => {
    setError(null)
    setFeedback(null)
    const fileArray = Array.from(files)

    if (fileArray.length === 0) return

    for (const file of fileArray) {
      const validationError = validateFile(file)
      if (validationError) {
        setError(validationError)
        return
      }
    }

    setUploading(true)
    try {
      let allSkipped = true
      for (const file of fileArray) {
        const result = await uploadDocument(file, folderId)
        if (result.action === 'skipped') {
          setFeedback({ message: `"${file.name}" already exists with identical content - processing skipped.`, type: 'info' })
        } else {
          allSkipped = false
          if (result.action === 'updated') {
            setFeedback({ message: `"${file.name}" updated, re-processing...`, type: 'success' })
          } else {
            setFeedback({ message: `"${file.name}" uploaded and processing...`, type: 'success' })
          }
        }
      }
      if (allSkipped) {
        await onSkipped?.()
      } else {
        await onUploadComplete()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setUploading(false)
    }
  }, [folderId, onUploadComplete, onSkipped])

  return {
    uploading,
    error,
    feedback,
    handleUpload,
    reset,
  }
}
