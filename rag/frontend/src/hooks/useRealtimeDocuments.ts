import { useEffect, useState, useCallback } from 'react'
import { supabase } from '@/lib/supabase'
import { listDocuments } from '@/lib/api'
import type { Document } from '@/types'

function hasDocumentSummary(doc: Partial<Document>): doc is Document {
  return (
    typeof doc.id === 'string' &&
    typeof doc.user_id === 'string' &&
    typeof doc.filename === 'string' &&
    typeof doc.file_type === 'string' &&
    typeof doc.file_size === 'number' &&
    typeof doc.storage_path === 'string' &&
    typeof doc.status === 'string' &&
    typeof doc.created_at === 'string' &&
    typeof doc.updated_at === 'string'
  )
}

function mergeDocumentUpdate(existing: Document, update: Partial<Document>): Document {
  return {
    ...existing,
    ...update,
    id: existing.id,
    filename: update.filename ?? existing.filename,
    file_type: update.file_type ?? existing.file_type,
    file_size: update.file_size ?? existing.file_size,
    storage_path: update.storage_path ?? existing.storage_path,
    user_id: update.user_id ?? existing.user_id,
    folder_id: update.folder_id ?? existing.folder_id,
    created_at: update.created_at ?? existing.created_at,
    updated_at: update.updated_at ?? existing.updated_at,
  }
}

export function useRealtimeDocuments(userId: string | undefined, folderId?: string | null) {
  const [documents, setDocuments] = useState<Document[]>([])
  const [loading, setLoading] = useState(true)

  const fetchDocuments = useCallback(async () => {
    if (!userId) return
    setLoading(true)
    try {
      const response = await listDocuments({ folderId })
      setDocuments(response.documents)
    } catch (error) {
      console.error('Failed to fetch documents:', error)
    } finally {
      setLoading(false)
    }
  }, [userId, folderId])

  useEffect(() => {
    fetchDocuments()
  }, [fetchDocuments])

  // Helper to check if a document matches the current folder filter
  const matchesFolder = useCallback((doc: Document) => {
    if (folderId === undefined) return true // No filter - show all
    if (folderId === null) return doc.folder_id === null // Knowledgebase
    return doc.folder_id === folderId // Specific folder
  }, [folderId])

  useEffect(() => {
    if (!userId) return

    const channel = supabase
      .channel('documents-changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'documents',
          filter: `user_id=eq.${userId}`,
        },
        (payload) => {
          if (payload.eventType === 'INSERT') {
            const newDoc = payload.new as Partial<Document>
            if (!hasDocumentSummary(newDoc)) return
            if (matchesFolder(newDoc)) {
              setDocuments(prev => [newDoc, ...prev])
            }
          } else if (payload.eventType === 'UPDATE') {
            const updatedDoc = payload.new as Partial<Document>
            if (typeof updatedDoc.id !== 'string') return
            setDocuments(prev => {
              const existingDoc = prev.find(doc => doc.id === updatedDoc.id)
              const mergedDoc = existingDoc
                ? mergeDocumentUpdate(existingDoc, updatedDoc)
                : hasDocumentSummary(updatedDoc)
                  ? updatedDoc
                  : null

              if (!mergedDoc) return prev

              // If the document no longer matches the filter, remove it
              if (!matchesFolder(mergedDoc)) {
                return prev.filter(doc => doc.id !== updatedDoc.id)
              }
              // If document matches filter, update or add it
              if (existingDoc) {
                return prev.map(doc => doc.id === updatedDoc.id ? mergedDoc : doc)
              }
              // Document was moved into this folder - add it
              return [mergedDoc, ...prev]
            })
          } else if (payload.eventType === 'DELETE') {
            setDocuments(prev =>
              prev.filter(doc => doc.id !== (payload.old as { id: string }).id)
            )
          }
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [userId, matchesFolder])

  return { documents, loading, refetch: fetchDocuments }
}
