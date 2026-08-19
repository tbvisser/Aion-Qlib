import { BaseEdge, Position, getBezierPath } from '@xyflow/react'

import { cn } from '@/lib/utils'
import type { KeycardEdgeData } from '@/lib/keycardGraph/keycardFlow'

export function KeycardEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: {
  id: string
  sourceX: number
  sourceY: number
  targetX: number
  targetY: number
  sourcePosition: Position
  targetPosition: Position
  data?: KeycardEdgeData
}) {
  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  })

  const blocking = (data?.defects ?? []).filter((d) => d.severity === 'blocking')
  const hasDefect = blocking.length > 0
  const isAddNext = id.startsWith('__edge-addNext-')

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        className={cn('aion-keycard-edge', hasDefect && 'aion-keycard-edge-defect')}
        style={{
          stroke: hasDefect ? 'hsl(var(--destructive))' : undefined,
          strokeWidth: hasDefect ? 2 : undefined,
        }}
      />
      {isAddNext && (
        <path
          d={edgePath}
          fill="none"
          stroke="transparent"
          strokeWidth={22}
          style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
        />
      )}
    </>
  )
}
