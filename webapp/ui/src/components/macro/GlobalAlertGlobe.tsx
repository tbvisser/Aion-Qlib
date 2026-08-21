import {
  forwardRef, useEffect, useMemo, useRef, useState,
} from 'react'
import type { GlobeMethods, GlobeProps } from 'react-globe.gl'
import type { Material } from 'three'
import { AlertTriangle } from 'lucide-react'
import { Panel } from '@/components/ui/panel'
import { cn } from '@/lib/utils'
import type { MacroAlertPoint } from '@/lib/macroAlerts'

interface GlobalAlertGlobeProps {
  alerts: MacroAlertPoint[]
  loading?: boolean
}

const SIZE = 320

interface HexBinLike {
  points: MacroAlertPoint[]
  sumWeight: number
  center: { lat: number; lng: number }
}

function hexFor(bin: object): HexBinLike {
  return bin as HexBinLike
}

function useWebGL() {
  return useMemo(
    () => typeof window !== 'undefined' && !!window.WebGLRenderingContext,
    [],
  )
}

/**
 * Load the WebGL globe on demand so the Macro Desk does not pay the Three.js
 * bundle cost until the widget is actually rendered.
 */
const LazyGlobe = forwardRef<GlobeMethods, GlobeProps>((props, ref) => {
  const [Globe, setGlobe] = useState<React.ComponentType<GlobeProps & React.RefAttributes<GlobeMethods>> | null>(null)
  const [globeMaterial, setGlobeMaterial] = useState<Material | null>(null)

  useEffect(() => {
    let active = true
    Promise.all([
      import('react-globe.gl'),
      import('three'),
    ]).then(([m, THREE]) => {
      if (!active) return
      setGlobe(() => m.default as React.ComponentType<GlobeProps & React.RefAttributes<GlobeMethods>>)
      // A dark base colour means the sphere is visible even if the external
      // earth texture fails to load; the texture is still applied on top when
      // it succeeds, so the familiar dark-globe look is preserved.
      setGlobeMaterial(new THREE.MeshPhongMaterial({
        color: '#111525',
        emissive: '#000000',
        shininess: 10,
      }))
    })
    return () => { active = false }
  }, [])

  if (!Globe || !globeMaterial) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        Loading globe…
      </div>
    )
  }

  return <Globe ref={ref} globeMaterial={globeMaterial} {...props} />
})
LazyGlobe.displayName = 'LazyGlobe'

function AlertList({ alerts, stale }: { alerts: MacroAlertPoint[]; stale?: boolean }) {
  return (
    <div className="space-y-1.5 p-3">
      {stale && (
        <div className="mb-2 flex items-center gap-1.5 rounded bg-clay/10 px-2 py-1 text-[10px] text-clay">
          <AlertTriangle className="h-3 w-3" />
          Showing recent cached events — data refresh is behind.
        </div>
      )}
      {alerts.slice(0, 8).map((a) => (
        <div
          key={a.country}
          className="flex items-center justify-between gap-2 text-[11px]"
        >
          <span className="font-medium">{a.country}</span>
          <span className="font-mono text-muted-foreground">
            {a.eventCount} release{a.eventCount === 1 ? '' : 's'}
          </span>
        </div>
      ))}
    </div>
  )
}

export function GlobalAlertGlobe({ alerts, loading }: GlobalAlertGlobeProps) {
  const globeRef = useRef<GlobeMethods>(null)
  const [ready, setReady] = useState(false)
  const hasWebGL = useWebGL()

  useEffect(() => {
    if (!ready) return
    const controls = globeRef.current?.controls?.()
    if (!controls) return
    controls.autoRotate = true
    controls.autoRotateSpeed = 0.8
  }, [ready])

  // Bright, high-contrast heat colours so the markers read against the dark globe.
  const heatColor = (weight: number) => {
    const t = Math.min(1, weight)
    return `hsl(17 95% 58% / ${0.55 + t * 0.45})`
  }

  const heatTopColor = (weight: number) => {
    const t = Math.min(1, weight)
    return `hsl(25 100% 65% / ${0.75 + t * 0.25})`
  }

  const pointColor = () => 'hsl(25 100% 68%)'
  const ringColor = () => 'hsl(25 100% 65% / 0.65)'

  const topAlerts = useMemo(() => alerts.slice(0, 5), [alerts])
  const empty = alerts.length === 0 && !loading
  const stale = alerts.some((a) => a.stale)
  const totalReleases = useMemo(
    () => alerts.reduce((sum, a) => sum + a.eventCount, 0),
    [alerts],
  )

  return (
    <Panel
      title="Global alert heatmap"
      hint="Next 14 days of macro releases"
      className="w-80"
      bodyClassName="h-80 p-0 overflow-hidden"
      loading={loading}
    >
      {loading ? (
        <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
          Loading alert map…
        </div>
      ) : empty ? (
        <div className="flex h-full items-center justify-center p-4 text-center text-xs text-muted-foreground">
          No upcoming macro releases in the next 14 days.
        </div>
      ) : !hasWebGL ? (
        <AlertList alerts={alerts} stale={stale} />
      ) : (
        <div className={cn('relative h-80 w-80', !ready && 'animate-subtle-pulse')}>
          <LazyGlobe
            ref={globeRef}
            width={SIZE}
            height={SIZE}
            backgroundColor="rgba(0,0,0,0)"
            globeImageUrl="https://unpkg.com/three-globe/example/img/earth-dark.jpg"
            showAtmosphere
            atmosphereColor="hsl(138 61% 68%)"
            atmosphereAltitude={0.15}
            showGraticules
            // Hex-bin heat layer: bigger, brighter, taller bins.
            hexBinPointsData={alerts}
            hexBinPointLat="lat"
            hexBinPointLng="lng"
            hexBinPointWeight="score"
            hexBinResolution={3}
            hexMargin={0.08}
            hexAltitude={(d) => Math.min(0.8, 0.18 + hexFor(d).sumWeight * 0.55)}
            hexTopColor={(d) => heatTopColor(hexFor(d).sumWeight)}
            hexSideColor={(d) => heatColor(hexFor(d).sumWeight)}
            hexLabel={(d) => {
              const pts = hexFor(d).points
              const total = pts.reduce((sum, p) => sum + p.eventCount, 0)
              const names = pts.map((p) => p.country).join(', ')
              return `<div style="font-family:sans-serif;font-size:11px;line-height:1.4;color:#fff;background:rgba(0,0,0,0.75);padding:4px 6px;border-radius:4px">
                <b>${names}</b><br/>
                ${total} release${total === 1 ? '' : 's'}<br/>
                top: ${pts[0]?.topEvent ?? '—'}
              </div>`
            }}
            // Per-country point markers.
            pointsData={alerts}
            pointLat="lat"
            pointLng="lng"
            pointAltitude={0.05}
            pointRadius={(d: object) => 0.55 + (d as MacroAlertPoint).score * 1.1}
            pointColor={pointColor}
            pointLabel={(d: object) => {
              const pt = d as MacroAlertPoint
              return `<div style="font-family:sans-serif;font-size:11px;line-height:1.4;color:#fff;background:rgba(0,0,0,0.75);padding:4px 6px;border-radius:4px">
                <b>${pt.country}</b><br/>
                ${pt.eventCount} release${pt.eventCount === 1 ? '' : 's'}<br/>
                top: ${pt.topEvent}
              </div>`
            }}
            // Pulsing rings on the top alert countries.
            ringsData={topAlerts}
            ringLat="lat"
            ringLng="lng"
            ringColor={ringColor}
            ringMaxRadius={(d: object) => 1.6 + (d as MacroAlertPoint).score * 4}
            ringPropagationSpeed={1.4}
            ringRepeatPeriod={1200}
            onGlobeReady={() => setReady(true)}
          />

          {/* Persistent data overlay: count, top country, and stale warning. */}
          <div className="pointer-events-none absolute left-2 top-2 flex flex-col gap-1">
            <div className="rounded-md border border-border/40 bg-background/85 px-2 py-1 text-[10px] backdrop-blur">
              <span className="font-mono uppercase tracking-wider text-muted-foreground">Total</span>
              {' '}
              <span className="font-semibold">{totalReleases}</span>
            </div>
            {alerts[0] && (
              <div className="rounded-md border border-border/40 bg-background/85 px-2 py-1 text-[10px] backdrop-blur">
                <span className="font-mono uppercase tracking-wider text-muted-foreground">Top</span>
                {' '}
                <span className="font-semibold">{alerts[0].country}</span>
              </div>
            )}
            {stale && (
              <div className="flex items-center gap-1 rounded-md border border-clay/30 bg-clay/10 px-2 py-1 text-[10px] text-clay backdrop-blur">
                <AlertTriangle className="h-3 w-3" />
                Stale cache
              </div>
            )}
          </div>

          {/* Legend */}
          <div className="pointer-events-none absolute bottom-2 right-2 rounded-md border border-border/40 bg-background/85 px-2 py-1.5 backdrop-blur">
            <div className="space-y-1">
              <div className="text-[9px] font-mono uppercase tracking-wider text-muted-foreground">Intensity</div>
              <div className="flex h-1.5 w-20 rounded-full bg-gradient-to-r from-[hsl(17_85%_60%_/_.55)] to-[hsl(25_100%_65%_/_.9)]" />
              <div className="flex justify-between text-[9px] text-muted-foreground">
                <span>Low</span>
                <span>High</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </Panel>
  )
}
