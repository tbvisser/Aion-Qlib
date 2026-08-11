import { FileText, FileCode, File } from 'lucide-react'
import type { WorkspaceFile } from '@/types'

interface WorkspacePanelProps {
  files: WorkspaceFile[]
  onFileClick: (file: WorkspaceFile) => void
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function getFileIcon(filePath: string, contentType: string) {
  const ext = filePath.split('.').pop()?.toLowerCase() || ''
  if (['md', 'txt', 'log'].includes(ext) || contentType.startsWith('text/plain')) {
    return <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
  }
  if (['py', 'js', 'ts', 'json', 'html', 'css', 'yaml', 'yml', 'xml', 'sh'].includes(ext)) {
    return <FileCode className="h-4 w-4 text-muted-foreground shrink-0" />
  }
  return <File className="h-4 w-4 text-muted-foreground shrink-0" />
}

export function WorkspacePanel({ files, onFileClick }: WorkspacePanelProps) {
  const sortedFiles = [...files].sort((a, b) => a.file_path.localeCompare(b.file_path))

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3">
        <span className="text-sm font-semibold text-foreground">Files</span>
        <span className="text-xs text-muted-foreground">({files.length})</span>
      </div>

      {/* File list */}
      <div className="flex-1 overflow-y-auto px-3 py-2">
        {sortedFiles.length === 0 ? (
          <div className="flex items-center justify-center h-20">
            <span className="text-xs text-muted-foreground">No files yet</span>
          </div>
        ) : (
          <div className="space-y-0.5">
            {sortedFiles.map((file) => (
              <button
                key={file.id}
                data-testid={`workspace-file-${file.file_path}`}
                onClick={() => onFileClick(file)}
                className="flex items-center gap-2.5 w-full rounded-lg px-2.5 py-2 text-sm hover:bg-surface-2 transition-colors text-left"
              >
                {getFileIcon(file.file_path, file.content_type)}
                <div className="flex-1 min-w-0">
                  <div className="truncate text-foreground" title={file.file_path}>
                    {file.file_path}
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>{formatFileSize(file.size_bytes)}</span>
                    <span className="inline-flex items-center rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium">
                      {file.source}
                    </span>
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
