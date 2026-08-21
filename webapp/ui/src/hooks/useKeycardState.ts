import { useCallback, useReducer } from 'react'

import type { KeycardNode, KeycardSpec } from '@/lib/api'
import { layoutTree } from '@/lib/keycardGraph/keycardFlow'

type Action =
  | { type: 'replace'; spec: KeycardSpec }
  | { type: 'update'; patch: Partial<KeycardSpec> | ((prev: KeycardSpec) => KeycardSpec) }
  | { type: 'updateNode'; nodeId: string; patch: Partial<KeycardNode> }
  | { type: 'selectNode'; id: string | null }
  | { type: 'autoLayout' }

interface State {
  spec: KeycardSpec
  selectedNodeId: string | null
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'replace':
      return { spec: action.spec, selectedNodeId: null }
    case 'update': {
      const patch = typeof action.patch === 'function' ? action.patch(state.spec) : action.patch
      return { ...state, spec: { ...state.spec, ...patch } }
    }
    case 'updateNode': {
      const nodes = state.spec.nodes.map((n) =>
        n.id === action.nodeId ? { ...n, ...action.patch } : n,
      )
      return { ...state, spec: { ...state.spec, nodes } }
    }
    case 'selectNode':
      return { ...state, selectedNodeId: action.id }
    case 'autoLayout': {
      const positions = layoutTree(state.spec)
      const nodes = state.spec.nodes.map((n) => ({
        ...n,
        position: positions.get(n.id) ?? n.position,
      }))
      return { ...state, spec: { ...state.spec, nodes } }
    }
    default:
      return state
  }
}

export interface UseKeycardState {
  spec: KeycardSpec
  selectedNodeId: string | null
  setSpec: (spec: KeycardSpec) => void
  updateSpec: (patch: Partial<KeycardSpec> | ((prev: KeycardSpec) => KeycardSpec)) => void
  updateNode: (nodeId: string, patch: Partial<KeycardNode>) => void
  selectNode: (id: string | null) => void
  autoLayout: () => void
}

export function useKeycardState(initial: KeycardSpec): UseKeycardState {
  const [state, dispatch] = useReducer(reducer, { spec: initial, selectedNodeId: null })

  const setSpec = useCallback((spec: KeycardSpec) => {
    dispatch({ type: 'replace', spec })
  }, [])

  const updateSpec = useCallback((patch: Partial<KeycardSpec> | ((prev: KeycardSpec) => KeycardSpec)) => {
    dispatch({ type: 'update', patch })
  }, [])

  const updateNode = useCallback((nodeId: string, patch: Partial<KeycardNode>) => {
    dispatch({ type: 'updateNode', nodeId, patch })
  }, [])

  const selectNode = useCallback((id: string | null) => {
    dispatch({ type: 'selectNode', id })
  }, [])

  const autoLayout = useCallback(() => {
    dispatch({ type: 'autoLayout' })
  }, [])

  return {
    spec: state.spec,
    selectedNodeId: state.selectedNodeId,
    setSpec,
    updateSpec,
    updateNode,
    selectNode,
    autoLayout,
  }
}
