import { useEffect, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { getFolderAncestors, type FolderAncestor } from '@/features/rag/lib/api'

interface FolderBreadcrumbsProps {
  folderId: string | null
  folderName: string | null
  onNavigate: (folderId: string | null, folderName: string | null) => void
  onFolderNameLoaded?: (name: string) => void
}

export function FolderBreadcrumbs({ folderId, folderName, onNavigate, onFolderNameLoaded }: FolderBreadcrumbsProps) {
  const [ancestors, setAncestors] = useState<FolderAncestor[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!folderId) {
      setAncestors([])
      return
    }

    setLoading(true)
    getFolderAncestors(folderId)
      .then(result => {
        setAncestors(result)
        // If folderName not provided and we have ancestors, provide the current folder name
        if (!folderName && result.length > 0 && onFolderNameLoaded) {
          onFolderNameLoaded(result[result.length - 1].name)
        }
      })
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [folderId, folderName, onFolderNameLoaded])

  // At root level - just show "Knowledgebase" as title
  if (!folderId) {
    return (
      <h1 className="text-2xl font-semibold tracking-tight">
        Knowledgebase
      </h1>
    )
  }

  if (loading) {
    return (
      <h1 className="text-2xl font-semibold tracking-tight text-muted-foreground">
        Loading...
      </h1>
    )
  }

  // Display all ancestors except the last one (current folder) as clickable
  const parentAncestors = ancestors.slice(0, -1)
  // Use the last ancestor's name as fallback if folderName is not provided
  const currentFolderName = folderName || ancestors[ancestors.length - 1]?.name || ''

  return (
    <nav className="flex flex-wrap items-center gap-y-1 text-2xl font-semibold tracking-tight text-muted-foreground">
      {/* Always show root link */}
      <a
        href="/documents"
        onClick={(e) => {
          if (e.ctrlKey || e.metaKey || e.shiftKey) return
          e.preventDefault()
          onNavigate(null, null)
        }}
        className="hover:text-foreground transition-colors no-underline text-muted-foreground"
      >
        Knowledgebase
      </a>
      {parentAncestors.map((ancestor) => (
        <span key={ancestor.id} className="flex items-center">
          <ChevronRight className="h-5 w-5 mx-2 text-muted-foreground/50" />
          <a
            href={`/documents/${ancestor.id}`}
            onClick={(e) => {
              if (e.ctrlKey || e.metaKey || e.shiftKey) return
              e.preventDefault()
              onNavigate(ancestor.id, ancestor.name)
            }}
            className="hover:text-foreground transition-colors no-underline text-muted-foreground"
          >
            {ancestor.name}
          </a>
        </span>
      ))}
      <ChevronRight className="h-5 w-5 mx-2 text-muted-foreground/50" />
      <span className="text-foreground">{currentFolderName}</span>
    </nav>
  )
}
