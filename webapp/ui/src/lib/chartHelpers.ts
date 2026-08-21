export interface ChartBar {
  time: string
  open: number | null
  high: number | null
  low: number | null
  close: number | null
}

/** Turn raw bars into Heikin-Ashi candles. */
export function toHeikinAshi(bars: ChartBar[]) {
  const out: { time: string; open: number; high: number; low: number; close: number }[] = []
  let prev: { open: number; close: number } | null = null
  for (const b of bars) {
    if (b.open == null || b.high == null || b.low == null || b.close == null) continue
    const close: number = (b.open + b.high + b.low + b.close) / 4
    const open: number = prev ? (prev.open + prev.close) / 2 : b.open
    const high = Math.max(b.high, open, close)
    const low = Math.min(b.low, open, close)
    out.push({ time: b.time, open, high, low, close })
    prev = { open, close }
  }
  return out
}

/** Add an alpha channel to an `hsl(...)` colour string. */
export function withAlpha(hsl: string, alpha: number) {
  // `hsl(...)` -> `hsl(... / alpha)`
  return hsl.replace(/\)$/, ` / ${alpha})`)
}
