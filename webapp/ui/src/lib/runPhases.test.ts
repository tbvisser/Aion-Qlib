import { describe, expect, it } from 'vitest'

import { RUN_PHASES, phaseIndex, stagesComplete } from './runPhases'

describe('phaseIndex', () => {
  it('places every phase the runner reports', () => {
    RUN_PHASES.forEach((phase, i) => expect(phaseIndex(phase)).toBe(i))
  })

  it('has no position for the phases that bracket a run', () => {
    // These are real phases the server sends — they simply are not stages, and
    // guessing a position for them would move the track before work starts.
    for (const bracket of ['Queued', 'Starting', 'Done', 'Failed', 'Cancelled']) {
      expect(phaseIndex(bracket)).toBeNull()
    }
  })

  it('has no position for a stage this build has never heard of', () => {
    expect(phaseIndex('Reticulating splines')).toBeNull()
  })

  it('treats a missing phase as unknown, not as the first stage', () => {
    expect(phaseIndex(null)).toBeNull()
    expect(phaseIndex(undefined)).toBeNull()
    expect(phaseIndex('')).toBeNull()
  })
})

describe('stagesComplete', () => {
  it('counts the stages behind the current one', () => {
    expect(stagesComplete('Loading data')).toBe(0)
    expect(stagesComplete('Running backtest')).toBe(3)
  })

  it('never reads as finished while the run is still in its last stage', () => {
    expect(stagesComplete('Analysing portfolio')).toBeLessThan(RUN_PHASES.length)
  })

  it('is empty for a run that has not reached a stage yet', () => {
    expect(stagesComplete('Queued')).toBe(0)
    expect(stagesComplete(null)).toBe(0)
  })
})
