import { useCallback, useRef, useState } from 'react'
import { Upload, FileUp, Info } from 'lucide-react'
import {
  DOCUMENT_UPLOAD_ACCEPT,
  DOCUMENT_UPLOAD_FORMAT_LABEL,
  useDocumentUpload,
} from '@/features/rag/hooks/useDocumentUpload'

interface DocumentUploadProps {
  onUploadComplete: () => void | Promise<void>
  onSkipped?: () => void | Promise<void>
  folderId?: string | null
}

export function DocumentUpload({ onUploadComplete, onSkipped, folderId }: DocumentUploadProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [isDragging, setIsDragging] = useState(false)
  const { uploading, error, feedback, handleUpload } = useDocumentUpload({
    folderId,
    onUploadComplete,
    onSkipped,
  })

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    if (e.dataTransfer.files.length > 0) {
      handleUpload(e.dataTransfer.files)
    }
  }, [handleUpload])

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      handleUpload(e.target.files)
      e.target.value = ''
    }
  }, [handleUpload])

  return (
    <div className="space-y-4">
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`relative border-2 border-dashed rounded-2xl p-8 text-center transition-all duration-300 cursor-pointer group ${
          isDragging
            ? 'border-primary bg-primary/5 scale-[1.02]'
            : 'border-border/50 hover:border-primary/50 hover:bg-muted/30'
        }`}
        onClick={() => fileInputRef.current?.click()}
      >
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          accept={DOCUMENT_UPLOAD_ACCEPT}
          multiple
          onChange={handleFileInput}
        />
        <div className="space-y-3">
          <div className={`mx-auto w-12 h-12 rounded-2xl flex items-center justify-center transition-all duration-300 ${
            isDragging ? 'bg-primary/20' : 'bg-muted/50 group-hover:bg-primary/10'
          }`}>
            {uploading ? (
              <FileUp className="w-6 h-6 text-primary animate-bounce" />
            ) : (
              <Upload className={`w-6 h-6 transition-colors duration-300 ${
                isDragging ? 'text-primary' : 'text-muted-foreground group-hover:text-primary'
              }`} />
            )}
          </div>
          <div>
            <p className="text-sm font-medium">
              {uploading ? 'Uploading...' : 'Drop files here or click to upload'}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {DOCUMENT_UPLOAD_FORMAT_LABEL}
            </p>
          </div>
        </div>
      </div>

      {feedback && (
        <div className={`flex items-center gap-2 text-sm rounded-lg px-3 py-2 animate-fade-in ${
          feedback.type === 'info'
            ? 'text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/50'
            : 'text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800/50'
        }`}>
          {feedback.type === 'info' ? (
            <Info className="w-4 h-4 flex-shrink-0" />
          ) : (
            <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 flex-shrink-0" />
          )}
          {feedback.message}
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 text-sm text-destructive animate-fade-in">
          <div className="w-1.5 h-1.5 rounded-full bg-destructive" />
          {error}
        </div>
      )}
    </div>
  )
}
