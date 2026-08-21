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
  type NodeDimensionChange,
  type NodePositionChange,
  type NodeRemoveChange,
  type NodeSelectionChange,
  type NodeTypes,
  type EdgeTypes,
  type OnConnectStartParams,
} from '@xyflow/react'

import { KeycardEdge as KeycardEdgeComponent } from './KeycardEdge'
import { KeycardNode as KeycardNodeComponent } from './KeycardNode'
import type { KeycardDefect, KeycardEdge as KeycardEdgeSpec, KeycardNode, KeycardNodeTypeMeta, KeycardSpec, KeycardPortType } from '@/lib/api'
import {
  addNextPosition,
  KEYCARD_EDGE_TYPE,
  KEYCARD_NODE_TYPE,
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
  const [connecting, setConnecting] = useState<{ portType: KeycardPortType; seeking: 'source' | 'target' } | null>(null)
  const [nodeDimensions, setNodeDimensions] = useState<Map<string, { width: number; height: number }>>(new Map())

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
    () => {
      const flowNodes = toFlowNodes(
        spec,
        metaByType,
        defects,
        selectedNodeId,
        onNodeDoubleClick,
        handleCreateNode,
        handleReplaceStartNode,
        handleReplaceAddNext,
        connecting?.portType ?? null,
        connecting?.seeking ?? null,
      )
      // Preserve the measured dimensions React Flow reports back. Without this,
      // every state update creates brand-new node objects and React Flow has to
      // re-adopt and re-measure them, which can blank the canvas during fast or
      // far drags (viewport culling / auto-pan lose the size information).
      return flowNodes.map((n) => {
        const dim = nodeDimensions.get(n.id)
        if (!dim) return n
        return { ...n, measured: { width: dim.width, height: dim.height } }
      })
    },
    [spec, metaByType, defects, selectedNodeId, onNodeDoubleClick, handleCreateNode, handleReplaceStartNode, handleReplaceAddNext, connecting, nodeDimensions],
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
        .map((c) => c.id),
    )
    if (removedIds.size > 0) {
      setNodeDimensions((prev) => {
        const next = new Map(prev)
        for (const id of removedIds) next.delete(id)
        return next
      })
      onChange({
        ...spec,
        nodes: spec.nodes.filter((n) => !removedIds.has(n.id)),
        edges: spec.edges.filter(
          (e) => !removedIds.has(e.source) && !removedIds.has(e.target),
        ),
      })
      return
    }

    const dimensionChanges = changes.filter(
      (c): c is NodeDimensionChange & { dimensions: { width: number; height: number } } =>
        c.type === 'dimensions' &&
        !!c.dimensions &&
        typeof c.dimensions.width === 'number' &&
        typeof c.dimensions.height === 'number',
    )
    if (dimensionChanges.length > 0) {
      setNodeDimensions((prev) => {
        const next = new Map(prev)
        for (const c of dimensionChanges) {
          next.set(c.id, { width: c.dimensions.width, height: c.dimensions.height })
        }
        return next
      })
    }

    const positionChanges = changes.filter(
      (c): c is NodePositionChange & { position: { x: number; y: number } } =>
        c.type === 'position' &&
        !!c.position &&
        typeof c.position.x === 'number' &&
        typeof c.position.y === 'number',
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
      (c): c is NodeSelectionChange => c.type === 'select',
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
        .map((c) => ((c as unknown) as { item: { id: string } }).item.id),
    )
    if (removedIds.size === 0) return
    onChange({
      ...spec,
      edges: spec.edges.filter((e) => !removedIds.has(e.id)),
    })
  }, [spec, onChange])

  const validateConnection = useCallback((
    connection: { source?: string | null; target?: string | null; sourceHandle?: string | null; targetHandle?: string | null },
    ignoreEdgeId?: string,
  ): boolean => {
    const { source, target, sourceHandle, targetHandle } = connection
    if (!source || !target || !sourceHandle || !targetHandle) return false

    const sourceMeta = metaByType.get(spec.nodes.find((n) => n.id === source)?.type ?? '')
    const targetMeta = metaByType.get(spec.nodes.find((n) => n.id === target)?.type ?? '')
    const sourcePort = sourceMeta?.ports.find((p) => p.id === sourceHandle)
    const targetPort = targetMeta?.ports.find((p) => p.id === targetHandle)
    if (!sourcePort || !targetPort) return false
    if (sourcePort.type !== targetPort.type) return false
    if (sourcePort.direction !== 'out' || targetPort.direction !== 'in') return false

    const existing = spec.edges.find(
      (e) => e.target === target && e.target_port === targetHandle && e.id !== ignoreEdgeId,
    )
    if (existing && !targetPort.multiple) return false

    const candidate = {
      id: `e-${source}-${sourceHandle}-${target}-${targetHandle}`,
      source,
      source_port: sourceHandle,
      target,
      target_port: targetHandle,
    }
    return !wouldCreateCycle(spec, candidate)
  }, [spec, metaByType])

  const onConnect = useCallback((connection: Connection) => {
    if (!validateConnection(connection)) return

    const id = `e-${connection.source}-${connection.sourceHandle}-${connection.target}-${connection.targetHandle}`
    onChange({
      ...spec,
      edges: [
        ...spec.edges,
        {
          id,
          source: connection.source,
          source_port: connection.sourceHandle,
          target: connection.target,
          target_port: connection.targetHandle,
        } as KeycardEdgeSpec,
      ],
    })
  }, [spec, validateConnection, onChange])

  const isValidConnection = useCallback((connection: Connection | KeycardFlowEdge) => validateConnection(connection), [validateConnection])

  const onConnectStart = useCallback((_: MouseEvent | TouchEvent, params: OnConnectStartParams) => {
    if (!params.nodeId || !params.handleId) return
    const sourceNode = spec.nodes.find((n) => n.id === params.nodeId)
    const sourceMeta = metaByType.get(sourceNode?.type ?? '')
    const sourcePort = sourceMeta?.ports.find((p) => p.id === params.handleId)
    if (sourcePort?.type) {
      setConnecting({ portType: sourcePort.type, seeking: 'target' })
    }
  }, [spec, metaByType])

  const onConnectEnd = useCallback(() => {
    setConnecting(null)
  }, [])

  const onReconnect = useCallback((oldEdge: KeycardFlowEdge, newConnection: Connection) => {
    if (!validateConnection(newConnection, oldEdge.id)) return
    const keycardEdge = oldEdge.data?.keycardEdge
    if (!keycardEdge) return
    const id = `e-${newConnection.source}-${newConnection.sourceHandle}-${newConnection.target}-${newConnection.targetHandle}`
    onChange({
      ...spec,
      edges: spec.edges.map((e) =>
        e.id === keycardEdge.id
          ? {
              ...e,
              id,
              source: newConnection.source!,
              source_port: newConnection.sourceHandle!,
              target: newConnection.target!,
              target_port: newConnection.targetHandle!,
            }
          : e,
      ),
    })
  }, [spec, validateConnection, onChange])

  const onReconnectStart = useCallback((_: unknown, edge: KeycardFlowEdge, handleType: 'source' | 'target') => {
    const keycardEdge = edge.data?.keycardEdge
    if (!keycardEdge) return
    if (handleType === 'target') {
      const sourceNode = spec.nodes.find((n) => n.id === keycardEdge.source)
      const sourceMeta = metaByType.get(sourceNode?.type ?? '')
      const sourcePort = sourceMeta?.ports.find((p) => p.id === keycardEdge.source_port)
      if (sourcePort?.type) {
        setConnecting({ portType: sourcePort.type, seeking: 'target' })
      }
    } else {
      const targetNode = spec.nodes.find((n) => n.id === keycardEdge.target)
      const targetMeta = metaByType.get(targetNode?.type ?? '')
      const targetPort = targetMeta?.ports.find((p) => p.id === keycardEdge.target_port)
      if (targetPort?.type) {
        setConnecting({ portType: targetPort.type, seeking: 'source' })
      }
    }
  }, [spec, metaByType])

  const onReconnectEnd = useCallback(() => {
    setConnecting(null)
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
          position: { x: position.x - 80, y: position.y - 28 },
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
        onConnectStart={onConnectStart}
        onConnectEnd={onConnectEnd}
        isValidConnection={isValidConnection}
        edgesReconnectable
        onReconnect={onReconnect}
        onReconnectStart={onReconnectStart}
        onReconnectEnd={onReconnectEnd}
        onPaneClick={() => onSelectNode(null)}
        onNodeClick={(_, node) => onSelectNode(node.id)}
        onNodeDoubleClick={(_, node) => onNodeDoubleClick?.(node.id)}
        onDragOver={onDragOver}
        onDrop={onDrop}
        fitView
        fitViewOptions={{ padding: 0.15, maxZoom: 1, duration: 200 }}
        minZoom={0.25}
        maxZoom={1.5}
        deleteKeyCode={['Backspace', 'Delete']}
        reconnectRadius={16}
        proOptions={{ hideAttribution: false }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="hsl(var(--border) / 0.6)" />
        <Controls showInteractive={false} position="top-left" />
      </ReactFlow>
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
