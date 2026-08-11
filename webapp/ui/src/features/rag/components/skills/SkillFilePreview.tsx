import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { getSkillFileContent } from '@/features/rag/lib/api'
import type { SkillFile, SkillFileContent } from '@/features/rag/types'
import { X, Copy, Download, Check, Loader2, FileWarning } from 'lucide-react'

interface SkillFilePreviewProps {
  file: SkillFile
  skillId: string
  onClose: () => void
}

export function SkillFilePreview({ file, skillId, onClose }: SkillFilePreviewProps) {
  const [data, setData] = useState<SkillFileContent | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setData(null)
    setCopied(false)

    async function load() {
      try {
        const result = await getSkillFileContent(skillId, file.id)
        if (!cancelled) setData(result)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load file')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => { cancelled = true }
  }, [skillId, file.id])

  const handleCopy = async () => {
    if (!data?.content) return
    try {
      await navigator.clipboard.writeText(data.content)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Fallback for older browsers
    }
  }

  const handleDownload = () => {
    if (!data?.download_url) return
    window.open(data.download_url, '_blank')
  }

  return (
    <div data-testid="skill-file-preview" className="flex flex-col h-full border-l border-border/50 bg-background">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 border-b border-border/50 px-4 py-3 shrink-0">
        <h3 className="text-sm font-medium truncate">{file.filename}</h3>
        <div className="flex items-center gap-1 shrink-0">
          {data?.content !== null && data?.content !== undefined && (
            <Button variant="ghost" size="sm" onClick={handleCopy} className="h-10 w-10 p-0 lg:h-7 lg:w-7">
              {copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
            </Button>
          )}
          {data?.download_url && (
            <Button variant="ghost" size="sm" onClick={handleDownload} className="h-10 w-10 p-0 lg:h-7 lg:w-7">
              <Download className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onClose} className="h-10 w-10 p-0 lg:h-7 lg:w-7">
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto p-4">
        {loading && (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        )}

        {error && (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground">
            <FileWarning className="h-8 w-8" />
            <p className="text-sm">{error}</p>
          </div>
        )}

        {!loading && !error && data && (
          data.content !== null ? (
            <pre className="text-sm font-mono whitespace-pre-wrap break-words text-foreground/90 leading-relaxed">
              {data.content}
            </pre>
          ) : (
            <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
              <FileWarning className="h-8 w-8" />
              <p className="text-sm">Binary file — cannot preview</p>
              <Button variant="outline" size="sm" onClick={handleDownload}>
                <Download className="mr-2 h-3.5 w-3.5" />
                Download
              </Button>
            </div>
          )
        )}
      </div>
    </div>
  )
}
