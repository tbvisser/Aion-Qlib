import type { MacroPlaybookResponse, PlaybookCell } from '@/lib/api'
import { type RegimeTone, marketTone, quadrantTone, riskTone } from '@/lib/regimeTone'

export interface PlaybookRow {
  state: string
  label: string
  tone: RegimeTone
  days: number
  episodes: number
  share: number
  current: boolean
  /** `runs[]` flattened, for the state cell's tooltip. */
  runsTitle: string
  /** Aligned to `assets`; null where a state lacks that column. */
  cells: (PlaybookCell | null)[]
}

export interface PlaybookMatrix {
  assets: { key: string; label: string }[]
  rows: PlaybookRow[]
}

function toneFor(lens: string, state: string): RegimeTone {
  if (lens === 'quadrant') return quadrantTone(state)
  if (lens === 'risk') {
    return riskTone(
      state === 'risk_on' ? 'Risk-On' : state === 'risk_off' ? 'Risk-Off' : 'Neutral',
    )
  }
  if (lens === 'market') return marketTone(state)
  return quadrantTone('unknown')
}

/**
 * The playbook payload as an aligned state x asset matrix.
 *
 * `states[].assets[]` is not guaranteed to carry the same keys in the same
 * order for every state, so the columns are unioned in first-seen order and a
 * state missing an asset gets a null **at the right index** — otherwise a row
 * shifts and every number in it is attributed to the wrong asset.
 */
export function playbookMatrix(payload: MacroPlaybookResponse | null): PlaybookMatrix {
  if (!payload || !payload.available) return { assets: [], rows: [] }

  const assets = payload.assets.length
    ? payload.assets
    : dedupe(payload.states.flatMap((s) => s.assets.map((a) => ({ key: a.key, label: a.label }))))

  const rows = payload.states.map((state) => {
    const byKey = new Map(state.assets.map((a) => [a.key, a] as const))
    const runs = state.runs ?? []
    return {
      state: state.state,
      label: state.label,
      tone: toneFor(payload.lens, state.state),
      days: state.days,
      episodes: state.episodes,
      share: state.share,
      current: state.current,
      runsTitle: runs.length
        ? `${runs.length} episode${runs.length === 1 ? '' : 's'}: ` +
          runs.slice(0, 8).map((r) => `${r.start} to ${r.end}`).join(', ') +
          (runs.length > 8 ? ', …' : '')
        : 'No contiguous episodes.',
      cells: assets.map((a) => byKey.get(a.key) ?? null),
    }
  })

  return { assets, rows }
}

function dedupe(items: { key: string; label: string }[]) {
  const seen = new Set<string>()
  return items.filter((i) => (seen.has(i.key) ? false : (seen.add(i.key), true)))
}
