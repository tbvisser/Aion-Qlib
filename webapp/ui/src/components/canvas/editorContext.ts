/**
 * The editor, reachable from inside a React Flow node.
 *
 * Node components are rendered by the library from `data`, and putting callbacks
 * in `data` would change its identity every render and defeat the memo on every
 * card. A context is the one channel that lets a card write back without
 * becoming un-memoisable.
 */
import { createContext, useContext } from 'react'

import type { ExpressionEditor } from '@/hooks/useFeatureSet'

export const EditorContext = createContext<ExpressionEditor | null>(null)

export function useEditor(): ExpressionEditor {
  const editor = useContext(EditorContext)
  if (!editor) throw new Error('useEditor must be used inside the canvas')
  return editor
}
