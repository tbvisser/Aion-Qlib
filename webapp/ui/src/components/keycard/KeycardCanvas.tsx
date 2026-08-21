import { useCallback, useMemo, useState } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  useReactFlow,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type NodePositionChange,
  type NodeRemoveChange,
  type NodeSelectionChange,
  type NodeTypes,
  type EdgeTypes,
} from '@xyflow/react'

import { KeycardEdge as KeycardEdgeComponent } from './KeycardEdge'
import { KeycardNode as KeycardNodeComponent, AddNodeMenu } from './KeycardNode'
import type { KeycardDefect, KeycardNode, KeycardNodeTypeMeta, KeycardSpec, KeycardPortType } from '@/lib/api'
import {
  addNextPosition,
  isAddNextNodeId,
  KEYCARD_ADD_NEXT_TYPE,
  KEYCARD_EDGE_TYPE,
  KEYCARD_NODE_TYPE,
  parseAddNextEdgeId,
  toFlowEdges,
  toFlowNodes,
  wouldCreateCycle,
  type KeycardFlowEdge,
  type KeycardFlowNode,
} from '@/lib/keycardGraph/keycardFlow'
import { getCompatibleInputPort } from '@/lib/keycardGraph/nodeRegistry'

import '@xyflow/react/dist/base.css'
import '@/styles/reactflow.css'

const nodeTypes: NodeTypes = {
  [KEYCARD_NODE_TYPE]: KeycardNodeComponent,
  [KEYCARD_ADD_NEXT_TYPE]: KeycardNodeComponent,
}
const edgeTypes: EdgeTypes = { [KEYCARD_EDGE_TYPE]: KeycardEdgeComponent }

interface Props {
  spec: KeycardSpec
  metaByType: Map<string, KeycardNodeTypeMeta>
  defects: KeycardDefect[]
  selectedNodeId: string | null
  onSelectNode: (id: string | null) => void
  onChange: (next: KeycardSpec) => void
  onNodeDoubleClick?: (nodeId: string) => void
}

export function KeycardCanvas({
  spec,
  metaByType,
  defects,
  selectedNodeId,
  onSelectNode,
  onChange,
  onNodeDoubleClick,
}: Props) {
  const { screenToFlowPosition } = useReactFlow()
  const [edgeMenu, setEdgeMenu] = useState<{
    sourceNodeId: string
    sourcePortId: string
    x: number
    y: number
  } | null>(null)

  const handleReplaceStartNode = useCallback((type: string) => {
    const meta = metaByType.get(type)
    if (!meta) return
    const startNode = spec.nodes.find((n) => n.type === 'start')
    const id = `${type}-${Date.now()}`
    const newNode: KeycardNode = {
      id,
      type,
      position: startNode ? { ...startNode.position } : { x: 0, y: 0 },
      config: defaultConfig(meta),
      notes: '',
    }
    onChange({
      ...spec,
      nodes: [...spec.nodes.filter((n) => n.type !== 'start'), newNode],
      edges: [],
    })
    onSelectNode(id)
  }, [spec, metaByType, onChange, onSelectNode])

  const addBlock = useCallback((
    sourceNodeId: string,
    sourcePortId: string,
    type: string,
    position?: { x: number; y: number },
  ) => {
    const sourceNode = spec.nodes.find((n) => n.id === sourceNodeId)
    const sourceMeta = metaByType.get(sourceNode?.type ?? '')
    const sourcePort = sourceMeta?.ports.find((p) => p.id === sourcePortId)
    const targetMeta = metaByType.get(type)
    if (!sourceNode || !sourcePort || !targetMeta) return null

    const outgoingCount = spec.edges.filter(
      (e) => e.source === sourceNodeId && e.source_port === sourcePortId,
    ).length
    const id = `${type}-${Date.now()}`
    const defaults = defaultConfig(targetMeta)
    const newNode: KeycardNode = {
      id,
      type,
      position: position ?? addNextPosition(sourceNode, sourcePortId, metaByType, outgoingCount),
      config: defaults,
      notes: '',
    }

    const targetPort = getCompatibleInputPort(type, sourcePort.type)
    const canConnect = targetPort !== undefined

    const nextSpec: KeycardSpec = {
      ...spec,
      nodes: [...spec.nodes, newNode],
      edges: canConnect
        ? [
            ...spec.edges,
            {
              id: `e-${sourceNodeId}-${sourcePortId}-${id}-${targetPort.id}`,
              source: sourceNodeId,
              source_port: sourcePortId,
              target: id,
              target_port: targetPort.id,
            },
          ]
        : spec.edges,
    }
    onChange(nextSpec)
    return id
  }, [spec, metaByType, onChange])

  const handleCreateNode = useCallback((sourceNodeId: string, sourcePortId: string, type: string) => {
    addBlock(sourceNodeId, sourcePortId, type)
  }, [addBlock])

  const handleReplaceAddNext = useCallback((sourceNodeId: string, sourcePortId: string, type: string) => {
    const newId = addBlock(sourceNodeId, sourcePortId, type)
    if (newId) onSelectNode(newId)
  }, [addBlock, onSelectNode])

  const nodes = useMemo(
    () => toFlowNodes(
      spec,
      metaByType,
      defects,
      selectedNodeId,
      onNodeDoubleClick,
      handleCreateNode,
      handleReplaceStartNode,
      handleReplaceAddNext,
    ),
    [spec, metaByType, defects, selectedNodeId, onNodeDoubleClick, handleCreateNode, handleReplaceStartNode, handleReplaceAddNext],
  )
  const edges = useMemo<KeycardFlowEdge[]>(() => {
    const routed = new Map<string, KeycardDefect[]>()
    for (const d of defects) {
      const match = /^edges\[([^\]]+)\]/.exec(d.path)
      if (!match) continue
      const list = routed.get(match[1]) ?? []
      list.push(d)
      routed.set(match[1], list)
    }
    return toFlowEdges(spec, metaByType).map((e) => ({
      ...e,
      animated: (routed.get(e.id) ?? []).length === 0,
      data: { keycardEdge: e.data!.keycardEdge, defects: routed.get(e.id) ?? [] },
    }))
  }, [spec, metaByType, defects])

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    const removedIds = new Set(
      changes
        .filter((c): c is NodeRemoveChange => c.type === 'remove')
        .filter((c) => !isAddNextNodeId(c.id))
        .map((c) => c.id),
    )
    if (removedIds.size > 0) {
      onChange({
        ...spec,
        nodes: spec.nodes.filter((n) => !removedIds.has(n.id)),
        edges: spec.edges.filter(
          (e) => !removedIds.has(e.source) && !removedIds.has(e.target),
        ),
      })
      return
    }

    const positionChanges = changes.filter(
      (c): c is NodePositionChange & { position: { x: number; y: number } } =>
        c.type === 'position' &&
        !!c.position &&
        typeof c.position.x === 'number' &&
        typeof c.position.y === 'number' &&
        !isAddNextNodeId(c.id),
    )
    if (positionChanges.length > 0) {
      onChange({
        ...spec,
        nodes: spec.nodes.map((n) => {
          const change = positionChanges.find((c) => c.id === n.id)
          return change ? { ...n, position: { x: change.position.x, y: change.position.y } } : n
        }),
      })
      return
    }

    const selectChanges = changes.filter(
      (c): c is NodeSelectionChange => c.type === 'select' && !isAddNextNodeId(c.id),
    )
    if (selectChanges.length === 1) {
      const c = selectChanges[0]
      const node = spec.nodes.find((n) => n.id === c.id)
      if (node?.type === 'start') return
      onSelectNode(c.selected ? c.id : null)
    }
  }, [spec, onChange, onSelectNode])

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    const removedIds = new Set(
      changes
        .filter((c) => c.type === 'remove')
        .map((c) => ((c as unknown) as { item: { id: string } }).item.id)
        .filter((id) => !id.startsWith('__edge-addNext-')),
    )
    if (removedIds.size === 0) return
    onChange({
      ...spec,
      edges: spec.edges.filter((e) => !removedIds.has(e.id)),
    })
  }, [spec, onChange])

  const onConnect = useCallback((connection: Connection) => {
    if (!connection.source || !connection.target || !connection.sourceHandle || !connection.targetHandle) return
    if (isAddNextNodeId(connection.source) || isAddNextNodeId(connection.target)) return

    const sourceMeta = metaByType.get(spec.nodes.find((n) => n.id === connection.source)?.type ?? '')
    const targetMeta = metaByType.get(spec.nodes.find((n) => n.id === connection.target)?.type ?? '')
    const sourcePort = sourceMeta?.ports.find((p) => p.id === connection.sourceHandle)
    const targetPort = targetMeta?.ports.find((p) => p.id === connection.targetHandle)
    if (!sourcePort || !targetPort) return
    if (sourcePort.type !== targetPort.type) return
    if (sourcePort.direction !== 'out' || targetPort.direction !== 'in') return

    const existing = spec.edges.find(
      (e) => e.target === connection.target && e.target_port === connection.targetHandle,
    )
    if (existing && !targetPort.multiple) return

    const id = `e-${connection.source}-${connection.sourceHandle}-${connection.target}-${connection.targetHandle}`
    const candidate = {
      id,
      source: connection.source,
      source_port: connection.sourceHandle,
      target: connection.target,
      target_port: connection.targetHandle,
    }
    if (wouldCreateCycle(spec, candidate)) return

    onChange({
      ...spec,
      edges: [...spec.edges, candidate],
    })
  }, [spec, metaByType, onChange])

  const onEdgeClick = useCallback((event: React.MouseEvent, edge: KeycardFlowEdge) => {
    const parsed = parseAddNextEdgeId(edge.id)
    if (!parsed) return
    event.stopPropagation()
    setEdgeMenu({ ...parsed, x: event.clientX, y: event.clientY })
  }, [])

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }, [])

  const onDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault()
    const raw = event.dataTransfer.getData('application/aion-keycard-node')
    if (!raw) return
    let payload: { type: string } | null = null
    try {
      payload = JSON.parse(raw) as { type: string }
    } catch {
      return
    }
    if (!payload?.type) return

    const meta = metaByType.get(payload.type)
    if (!meta) return

    const position = screenToFlowPosition({ x: event.clientX, y: event.clientY })
    const id = `${payload.type}-${Date.now()}`
    const defaults = defaultConfig(meta)

    onChange({
      ...spec,
      nodes: [
        ...spec.nodes,
        {
          id,
          type: payload.type,
          position: { x: position.x - 118, y: position.y - 50 },
          config: defaults,
          notes: '',
        },
      ],
    })
  }, [spec, metaByType, screenToFlowPosition, onChange])

  return (
    <div className="relative min-h-0 min-w-0 flex-1" data-testid="keycard-canvas">
      <ReactFlow<KeycardFlowNode, KeycardFlowEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onEdgeClick={onEdgeClick}
        onPaneClick={() => onSelectNode(null)}
        onNodeClick={(_, node) => {
          if (!isAddNextNodeId(node.id)) onSelectNode(node.id)
        }}
        onNodeDoubleClick={(_, node) => {
          if (!isAddNextNodeId(node.id)) onNodeDoubleClick?.(node.id)
        }}
        onDragOver={onDragOver}
        onDrop={onDrop}
        fitView
        fitViewOptions={{ padding: 0.15, maxZoom: 1, duration: 200 }}
        minZoom={0.25}
        maxZoom={1.5}
        deleteKeyCode={['Backspace', 'Delete']}
        proOptions={{ hideAttribution: false }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="hsl(var(--border) / 0.6)" />
        <Controls showInteractive={false} position="top-left" />
      </ReactFlow>
      {edgeMenu && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setEdgeMenu(null)}
            aria-hidden="true"
          />
          <div
            className="fixed z-50 w-60 rounded-md border bg-popover p-2 shadow-md"
            style={{ left: edgeMenu.x + 8, top: edgeMenu.y + 8 }}
          >
            <AddNodeMenu
              title="Add next block"
              metaByType={metaByType}
              sourcePortType={edgeMenu.sourcePortId as KeycardPortType}
              onSelect={(type) => {
                handleReplaceAddNext(edgeMenu.sourceNodeId, edgeMenu.sourcePortId, type)
                setEdgeMenu(null)
              }}
            />
          </div>
        </>
      )}
    </div>
  )
}

function defaultConfig(meta: KeycardNodeTypeMeta): Record<string, unknown> {
  const schema = meta.config_schema as {
    properties?: Record<string, { type?: string; enum?: unknown[]; default?: unknown }>
    required?: string[]
  } | undefined
  const out: Record<string, unknown> = {}
  if (!schema?.properties) return out
  for (const [key, prop] of Object.entries(schema.properties)) {
    if (prop.default !== undefined) {
      out[key] = prop.default
    } else if (prop.enum && prop.enum.length > 0) {
      out[key] = prop.enum[0]
    } else if (prop.type === 'boolean') {
      out[key] = false
    } else if (prop.type === 'number' || prop.type === 'integer') {
      // Leave required numeric fields unset so the node starts grey and only
      // turns coloured once the user supplies a real value.
      out[key] = undefined
    } else if (prop.type === 'array') {
      out[key] = []
    } else {
      out[key] = ''
    }
  }
  return out
}
