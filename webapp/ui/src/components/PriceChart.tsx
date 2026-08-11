import { useEffect, useRef } from 'react'
import { CandlestickSeries, HistogramSeries, createChart, type IChartApi } from 'lightweight-charts'
import { useTheme } from '@/hooks/useTheme'
import type { Bar } from '@/lib/api'

/**
 * Candles + volume, themed off the CSS custom properties rather than hardcoded
 * hexes, so the chart follows the app's light/dark tokens exactly.
 *
 * lightweight-charts renders the price series.
 */
export function PriceChart({ bars, height = 420 }: { bars: Bar[]; height?: number }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const { theme } = useTheme()

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const css = getComputedStyle(document.documentElement)
    const token = (name: string) => `hsl(${css.getPropertyValue(name).trim()})`
    const text = token('--muted-foreground')
    const grid = `hsl(${css.getPropertyValue('--border').trim()} / 0.4)`
    const up = token('--primary')
    // Losses use clay, the brand's "negative verdict" accent — not
    // --destructive, which means "something went wrong".
    const down = token('--clay')

    const chart = createChart(el, {
      height,
      layout: {
        background: { color: 'transparent' },
        textColor: text,
        fontFamily: "'IBM Plex Mono', ui-monospace, monospace",
        fontSize: 11,
        attributionLogo: false,
      },
      grid: { vertLines: { color: grid }, horzLines: { color: grid } },
      rightPriceScale: { borderColor: grid, scaleMargins: { top: 0.08, bottom: 0.26 } },
      timeScale: { borderColor: grid, rightOffset: 4 },
      crosshair: { mode: 0 },
    })
    chartRef.current = chart

    const candles = chart.addSeries(CandlestickSeries, {
      upColor: up,
      downColor: down,
      borderUpColor: up,
      borderDownColor: down,
      wickUpColor: up,
      wickDownColor: down,
    })
    const volume = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
    })
    chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } })

    const valid = bars.filter(
      (b) => b.open != null && b.high != null && b.low != null && b.close != null,
    )
    candles.setData(
      valid.map((b) => ({
        time: b.time,
        open: b.open!,
        high: b.high!,
        low: b.low!,
        close: b.close!,
      })),
    )
    volume.setData(
      valid.map((b) => ({
        time: b.time,
        value: b.volume ?? 0,
        color: (b.close ?? 0) >= (b.open ?? 0) ? `${up.slice(0, -1)} / 0.35)` : `${down.slice(0, -1)} / 0.35)`,
      })),
    )
    chart.timeScale().fitContent()

    const observer = new ResizeObserver(() => chart.applyOptions({ width: el.clientWidth }))
    observer.observe(el)
    chart.applyOptions({ width: el.clientWidth })

    return () => {
      observer.disconnect()
      chart.remove()
      chartRef.current = null
    }
    // theme is a dependency because the colours are read once at build time.
  }, [bars, height, theme])

  return <div ref={containerRef} className="w-full" />
}
