import { useEffect, useMemo, useRef } from 'react'
import {
  AreaSeries,
  BarSeries,
  CandlestickSeries,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type SeriesMarker,
  type Time,
} from 'lightweight-charts'
import { useTheme } from '@/hooks/useTheme'
import { toHeikinAshi, withAlpha } from '@/lib/chartHelpers'
import type { Bar } from '@/lib/api'

export type ChartType = 'candles' | 'bars' | 'line' | 'area' | 'heikin-ashi'

export interface IndicatorOverlay {
  name: string
  color: string
  data: { time: string; value: number | null }[]
}

export interface SignalMarker {
  time: string
  direction: 'long' | 'short' | 'close'
  text?: string
}

interface PriceChartProps {
  bars: Bar[]
  chartType?: ChartType
  indicators?: IndicatorOverlay[]
  signals?: SignalMarker[]
}

/**
 * TradingView-style price chart. The parent must give it an explicit height;
 * the chart then auto-sizes to the container. Supports candles, bars, line,
 * area, Heikin-Ashi, indicator overlays, and ML-run trade markers.
 */
export function PriceChart({
  bars,
  chartType = 'candles',
  indicators = [],
  signals = [],
}: PriceChartProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const { theme } = useTheme()

  const valid = useMemo(
    () => bars.filter((b) => b.open != null && b.high != null && b.low != null && b.close != null),
    [bars],
  )

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const css = getComputedStyle(document.documentElement)
    const token = (name: string) => `hsl(${css.getPropertyValue(name).trim()})`
    const muted = token('--muted-foreground')
    const grid = withAlpha(token('--border'), 0.25)
    const up = token('--primary')
    const down = token('--clay')
    const bg = token('--card')

    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { color: bg },
        textColor: muted,
        fontFamily: "'IBM Plex Mono', ui-monospace, monospace",
        fontSize: 11,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: grid },
        horzLines: { color: grid },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: grid, labelBackgroundColor: muted },
        horzLine: { color: grid, labelBackgroundColor: muted },
      },
      rightPriceScale: {
        borderColor: grid,
        scaleMargins: { top: 0.08, bottom: 0.24 },
      },
      leftPriceScale: {
        visible: false,
      },
      timeScale: {
        borderColor: grid,
        rightOffset: 4,
        timeVisible: false,
        secondsVisible: false,
      },
    })
    chartRef.current = chart

    let mainSeries: ISeriesApi<any>

    if (chartType === 'line' || chartType === 'area') {
      const lineData = valid.map((b) => ({ time: b.time, value: b.close! }))
      if (chartType === 'area') {
        mainSeries = chart.addSeries(AreaSeries, {
          lineColor: up,
          topColor: withAlpha(up, 0.28),
          bottomColor: withAlpha(up, 0.03),
          lineWidth: 2,
          priceLineColor: up,
        })
      } else {
        mainSeries = chart.addSeries(LineSeries, {
          color: up,
          lineWidth: 2,
          priceLineColor: up,
        })
      }
      mainSeries.setData(lineData)
    } else if (chartType === 'bars') {
      mainSeries = chart.addSeries(BarSeries, {
        upColor: up,
        downColor: down,
      })
      mainSeries.setData(
        valid.map((b) => ({
          time: b.time,
          open: b.open!,
          high: b.high!,
          low: b.low!,
          close: b.close!,
        })),
      )
    } else {
      // candles or heikin-ashi
      const candleData = chartType === 'heikin-ashi' ? toHeikinAshi(valid) : valid
      mainSeries = chart.addSeries(CandlestickSeries, {
        upColor: up,
        wickUpColor: up,
        borderUpColor: up,
        downColor: down,
        wickDownColor: down,
        borderDownColor: down,
        borderVisible: true,
      })
      mainSeries.setData(
        candleData.map((b) => ({
          time: b.time,
          open: b.open,
          high: b.high,
          low: b.low,
          close: b.close,
        })),
      )
    }

    const volume = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
    })
    chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } })

    const volumeData = valid.map((b, i) => {
      const prevClose = i > 0 ? valid[i - 1].close : b.open
      const isUp = chartType === 'line' || chartType === 'area'
        ? (b.close ?? 0) >= (prevClose ?? 0)
        : (b.close ?? 0) >= (b.open ?? 0)
      return {
        time: b.time,
        value: b.volume ?? 0,
        color: isUp ? withAlpha(up, 0.45) : withAlpha(down, 0.45),
      }
    })
    volume.setData(volumeData)

    // Give each indicator its own pane so it never overlaps the price candles.
    const mainPane = chart.panes()[0]
    mainPane.setStretchFactor(Math.max(1.5, 2.5 - indicators.length * 0.15))

    indicators.forEach((ind) => {
      const pane = chart.addPane()
      pane.setStretchFactor(1)
      pane.priceScale('right').applyOptions({
        borderColor: grid,
        scaleMargins: { top: 0.1, bottom: 0.05 },
      })

      const series = pane.addSeries(LineSeries, {
        color: ind.color,
        lineWidth: 2,
        priceLineVisible: false,
        title: ind.name,
      })
      series.setData(
        ind.data
          .filter((d): d is { time: string; value: number } => d.value != null)
          .map((d) => ({ time: d.time, value: d.value })),
      )
    })

    // ML-run trade markers on the main series.
    if (signals.length) {
      const markers: SeriesMarker<Time>[] = signals.map((s) => {
        if (s.direction === 'long') {
          return {
            time: s.time,
            position: 'belowBar',
            color: up,
            shape: 'arrowUp',
            size: 1,
            text: s.text,
          }
        }
        if (s.direction === 'short') {
          return {
            time: s.time,
            position: 'aboveBar',
            color: down,
            shape: 'arrowDown',
            size: 1,
            text: s.text,
          }
        }
        return {
          time: s.time,
          position: 'inBar',
          color: muted,
          shape: 'circle',
          size: 0,
          text: s.text,
        }
      })
      createSeriesMarkers(mainSeries, markers)
    }

    chart.timeScale().fitContent()

    return () => {
      chart.remove()
      chartRef.current = null
    }
  }, [bars, chartType, indicators, signals, theme, valid])

  return <div ref={containerRef} data-testid="price-chart" className="h-full w-full" />
}
