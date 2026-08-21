import { useEffect, useRef, useState } from 'react'

import type { MarkovAnalyzeResponse } from '@/lib/api'
import { cn } from '@/lib/utils'

interface Markov3DGraphProps {
  transition_matrix: MarkovAnalyzeResponse['transition_matrix']
  currentState: string
}

const STATE_COLORS: Record<string, number> = {
  Bull: 0x22c55e,
  Bear: 0xf97316,
  Sideways: 0x9ca3af,
}

const NODE_POSITIONS: Record<string, [number, number, number]> = {
  Bull: [1.3, 0.9, 0],
  Bear: [-1.3, 0.9, 0],
  Sideways: [0, -1.2, 0],
}

export function Markov3DGraph({ transition_matrix, currentState }: Markov3DGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const labelRefs = useRef<Record<string, HTMLDivElement | null>>({
    Bull: null,
    Bear: null,
    Sideways: null,
  })
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    let cancelled = false
    let raf = 0
    let cleanup = () => {}

    const setup = async () => {
      const THREE: any = await import('three')
      if (cancelled) return

      const scene = new THREE.Scene()
      scene.background = null

      const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 100)
      camera.position.set(0, 0, 7.2)

      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
      renderer.setSize(container.clientWidth, container.clientHeight)
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
      container.appendChild(renderer.domElement)

      const graphGroup = new THREE.Group()
      scene.add(graphGroup)

      // Soft lighting so the materials pop without harsh shadows.
      const ambient = new THREE.AmbientLight(0xffffff, 0.6)
      scene.add(ambient)
      const key = new THREE.DirectionalLight(0xffffff, 1)
      key.position.set(2, 4, 5)
      scene.add(key)
      const fill = new THREE.DirectionalLight(0xffffff, 0.35)
      fill.position.set(-4, -2, 4)
      scene.add(fill)

      // Subtle floor ring.
      const ringGeom = new THREE.RingGeometry(2.6, 2.65, 64)
      const ringMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.1, side: THREE.DoubleSide })
      const ring = new THREE.Mesh(ringGeom, ringMat)
      ring.rotation.x = -Math.PI / 2
      ring.position.y = -1.6
      graphGroup.add(ring)

      const stateNames = Object.keys(NODE_POSITIONS)
      const nodeMeshes: Record<string, any> = {}

      for (const name of stateNames) {
        const [x, y, z] = NODE_POSITIONS[name]
        const color = STATE_COLORS[name]

        // Core sphere.
        const coreGeom = new THREE.SphereGeometry(0.36, 48, 48)
        const coreMat = new THREE.MeshPhysicalMaterial({
          color,
          metalness: 0.15,
          roughness: 0.25,
          emissive: color,
          emissiveIntensity: 0.35,
          clearcoat: 0.8,
          clearcoatRoughness: 0.1,
        })
        const core = new THREE.Mesh(coreGeom, coreMat)
        core.position.set(x, y, z)
        graphGroup.add(core)
        nodeMeshes[name] = core

        // Outer glow halo.
        const haloGeom = new THREE.SphereGeometry(0.5, 48, 48)
        const haloMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.12 })
        const halo = new THREE.Mesh(haloGeom, haloMat)
        halo.position.set(x, y, z)
        graphGroup.add(halo)

        // Extra pulse for the current regime.
        if (name === currentState) {
          const pulseGeom = new THREE.SphereGeometry(0.58, 48, 48)
          const pulseMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.06 })
          const pulse = new THREE.Mesh(pulseGeom, pulseMat)
          pulse.position.set(x, y, z)
          pulse.userData = { isPulse: true }
          graphGroup.add(pulse)
        }
      }

      // Build directed edges.
      type Edge = { curve: any; from: string; to: string; prob: number }
      const edges: Edge[] = []

      for (const row of transition_matrix) {
        const fromPos = new THREE.Vector3(...NODE_POSITIONS[row.from])
        for (const [toName, probValue] of Object.entries(row.to)) {
          const prob = probValue ?? 0
          if (prob < 0.02) continue
          const toPos = new THREE.Vector3(...NODE_POSITIONS[toName])

          let curve: any
          if (row.from === toName) {
            // Small self-loop arc above the node.
            const center = fromPos.clone().add(new THREE.Vector3(0, 0.55, 0))
            const points: any[] = []
            for (let i = 0; i <= 32; i++) {
              const a = (i / 32) * Math.PI * 2
              points.push(new THREE.Vector3(center.x + Math.cos(a) * 0.35, center.y + Math.sin(a) * 0.22, center.z))
            }
            curve = new THREE.CatmullRomCurve3(points, true)
          } else {
            const mid = new THREE.Vector3().addVectors(fromPos, toPos).multiplyScalar(0.5)
            const dir = new THREE.Vector3().subVectors(toPos, fromPos).normalize()
            const up = new THREE.Vector3(0, 0, 1)
            const lift = 0.5 + prob * 0.3
            // Offset perpendicular to the edge so forward and reverse arcs separate.
            const perp = new THREE.Vector3().crossVectors(dir, up).normalize()
            const control = mid.add(perp.multiplyScalar(lift)).add(new THREE.Vector3(0, 0, lift * 0.4))
            curve = new THREE.QuadraticBezierCurve3(fromPos, control, toPos)
          }

          const radius = 0.015 + prob * 0.035
          const tubeGeom = new THREE.TubeGeometry(curve, 48, radius, 8, false)
          const tubeMat = new THREE.MeshStandardMaterial({
            color: STATE_COLORS[toName],
            transparent: true,
            opacity: 0.6,
            emissive: STATE_COLORS[toName],
            emissiveIntensity: 0.25,
          })
          const tube = new THREE.Mesh(tubeGeom, tubeMat)
          graphGroup.add(tube)

          // Arrowhead.
          const t = 0.9
          const point = curve.getPoint(t)
          const tangent = curve.getTangent(t).normalize()
          const coneGeom = new THREE.ConeGeometry(0.06 + prob * 0.04, 0.18, 16)
          const coneMat = new THREE.MeshStandardMaterial({ color: STATE_COLORS[toName], emissive: STATE_COLORS[toName], emissiveIntensity: 0.3 })
          const cone = new THREE.Mesh(coneGeom, coneMat)
          cone.position.copy(point)
          cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tangent)
          graphGroup.add(cone)

          edges.push({ curve, from: row.from, to: toName, prob })
        }
      }

      // Traveller dot on the strongest transition.
      let traveller: any
      if (edges.length > 0) {
        const top = edges.reduce((a, b) => (a.prob >= b.prob ? a : b))
        const tGeom = new THREE.SphereGeometry(0.07, 16, 16)
        const tMat = new THREE.MeshBasicMaterial({ color: 0xffffff })
        traveller = new THREE.Mesh(tGeom, tMat)
        traveller.userData = { edge: top }
        graphGroup.add(traveller)
      }

      const clock = new THREE.Clock()

      // Mouse interaction: drag to rotate, wheel to zoom.
      let isDragging = false
      let startX = 0
      let startY = 0
      let baseRotY = 0
      let baseRotX = 0
      let userRotY = 0
      let userRotX = 0

      const onMouseDown = (e: MouseEvent) => {
        isDragging = true
        startX = e.clientX
        startY = e.clientY
        baseRotY = userRotY
        baseRotX = userRotX
      }
      const onMouseMove = (e: MouseEvent) => {
        if (!isDragging) return
        userRotY = baseRotY + (e.clientX - startX) * 0.008
        userRotX = baseRotX + (e.clientY - startY) * 0.008
      }
      const onMouseUp = () => {
        isDragging = false
      }
      const onWheel = (e: WheelEvent) => {
        camera.position.z += e.deltaY * 0.003
        camera.position.z = Math.max(3, Math.min(9, camera.position.z))
      }

      container.addEventListener('mousedown', onMouseDown)
      window.addEventListener('mousemove', onMouseMove)
      window.addEventListener('mouseup', onMouseUp)
      container.addEventListener('wheel', onWheel)

      const updateLabels = () => {
        for (const name of stateNames) {
          const div = labelRefs.current[name]
          if (!div) continue
          const [x, y, z] = NODE_POSITIONS[name]
          const pos = new THREE.Vector3(x, y, z)
          pos.applyMatrix4(graphGroup.matrixWorld)
          pos.project(camera)
          const px = (pos.x * 0.5 + 0.5) * container.clientWidth
          const py = (-pos.y * 0.5 + 0.5) * container.clientHeight
          div.style.transform = `translate(-50%, -50%) translate(${px}px, ${py}px)`
          div.style.display = pos.z < 1 ? 'block' : 'none'
        }
      }

      const animate = () => {
        const elapsed = clock.getElapsedTime()
        const autoRot = elapsed * 0.08
        graphGroup.rotation.y = autoRot + userRotY
        graphGroup.rotation.x = Math.sin(elapsed * 0.15) * 0.05 + userRotX

        // Pulse the current-regime halo.
        graphGroup.traverse((obj: any) => {
          if (obj.userData?.isPulse) {
            const s = 1 + Math.sin(elapsed * 2.5) * 0.08
            obj.scale.set(s, s, s)
          }
        })

        if (traveller && traveller.userData.edge) {
          const edge = traveller.userData.edge as Edge
          const t = (elapsed % 2.5) / 2.5
          const pt = edge.curve.getPoint(t)
          traveller.position.copy(pt)
        }

        graphGroup.updateMatrixWorld()
        updateLabels()
        renderer.render(scene, camera)
        raf = requestAnimationFrame(animate)
      }
      animate()
      setReady(true)

      const onResize = () => {
        camera.aspect = container.clientWidth / container.clientHeight
        camera.updateProjectionMatrix()
        renderer.setSize(container.clientWidth, container.clientHeight)
      }
      window.addEventListener('resize', onResize)

      cleanup = () => {
        window.removeEventListener('resize', onResize)
        container.removeEventListener('mousedown', onMouseDown)
        window.removeEventListener('mousemove', onMouseMove)
        window.removeEventListener('mouseup', onMouseUp)
        container.removeEventListener('wheel', onWheel)
        cancelAnimationFrame(raf)
        renderer.dispose()
        if (renderer.domElement.parentNode === container) {
          container.removeChild(renderer.domElement)
        }
        scene.traverse((obj: any) => {
          if (obj.geometry) obj.geometry.dispose()
          const mat = obj.material
          if (mat) {
            if (Array.isArray(mat)) mat.forEach((m: any) => m.dispose())
            else mat.dispose()
          }
        })
      }
    }

    setup()

    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      cleanup()
    }
  }, [transition_matrix, currentState])

  return (
    <div
      ref={containerRef}
      className="relative h-80 w-full cursor-move overflow-hidden rounded-lg bg-background"
      title="Drag to rotate, scroll to zoom"
    >
      {!ready && (
        <div className="absolute inset-0 flex items-center justify-center text-[11px] text-muted-foreground">
          Loading 3D scene…
        </div>
      )}
      {['Bull', 'Bear', 'Sideways'].map((name) => (
        <div
          key={name}
          ref={(el) => {
            labelRefs.current[name] = el
          }}
          className={cn(
            'pointer-events-none absolute left-0 top-0 whitespace-nowrap rounded-full border border-border/40 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider shadow-sm backdrop-blur',
            name === 'Bull' && 'bg-primary/10 text-primary',
            name === 'Bear' && 'bg-clay/10 text-clay',
            name === 'Sideways' && 'bg-muted text-muted-foreground',
          )}
        >
          {name}
        </div>
      ))}
    </div>
  )
}
