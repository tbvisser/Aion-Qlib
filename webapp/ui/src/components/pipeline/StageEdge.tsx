/**
 * The curved connection between two stacked stage cards.
 *
 * The cards are centred on the same vertical line, so React Flow's default
 * bezier would draw a straight line down. This edge pulls the control points
 * horizontally, alternating left and right per edge, to create the gentle S-curve
 * in the reference screenshot. A small dot is drawn at the midpoint of the curve
 * to match the screenshot's connection points.
 */
import { memo } from 'react'
import { BaseEdge, type EdgeProps } from '@xyflow/react'

function cubicBezierMidpoint(
  sx: number,
  sy: number,
  c1x: number,
  c1y: number,
  c2x: number,
  c2y: number,
  tx: number,
  ty: number,
): { x: number; y: number } {
  // B(0.5) = 1/8 P0 + 3/8 P1 + 3/8 P2 + 1/8 P3
  return {
    x: 0.125 * sx + 0.375 * c1x + 0.375 * c2x + 0.125 * tx,
    y: 0.125 * sy + 0.375 * c1y + 0.375 * c2y + 0.125 * ty,
  }
}

// `memo`, like every other React Flow renderer in the builder — this was the
// only one without it.
export const StageEdge = memo(function StageEdge({
  sourceX,
  sourceY,
  targetX,
  targetY,
  markerEnd,
  style,
  data,
}: EdgeProps) {
  const sign = data?.curve === 'left' ? -1 : 1
  // Curve outward by a fixed distance; large enough to read as a curve, small
  // enough not to loop back on itself within the 16px gap between cards.
  const offset = 36 * sign
  const midY = (sourceY + targetY) / 2

  const path = `M ${sourceX} ${sourceY} C ${sourceX + offset} ${midY}, ${targetX + offset} ${midY}, ${targetX} ${targetY}`
  const dot = cubicBezierMidpoint(
    sourceX, sourceY,
    sourceX + offset, midY,
    targetX + offset, midY,
    targetX, targetY,
  )

  return (
    <>
      <BaseEdge path={path} markerEnd={markerEnd} style={style} />
      <circle
        cx={dot.x}
        cy={dot.y}
        r={3}
        className="pointer-events-none fill-muted-foreground/50"
      />
    </>
  )
})
