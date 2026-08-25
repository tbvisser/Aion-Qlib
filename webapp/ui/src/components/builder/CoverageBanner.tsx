/**
 * What the target store cannot compute, said before the run rather than after.
 *
 * The single most expensive silent failure in this app is a linear model on a
 * store with a dead handler column: `LinearModel.fit` calls `dropna()` across
 * every feature, so one all-NaN column drops *every* training row and the run
 * dies twenty minutes in with "Empty data from dataset". Nothing on screen
 * predicted it.
 *
 * This never blocks. The generated config already drops those columns, so the
 * run is correct — and a banner that only cries danger about a case that is
 * already handled is a banner people learn to skip. Each message therefore says
 * both halves: what is wrong with the data, and what the config does about it.
 */
import { Notice } from '@/components/ui/notice'
import type { StrategyCoverage } from '@/lib/api'

const LIST = (names: string[], max = 6) =>
  names.length <= max
    ? names.join(', ')
    : `${names.slice(0, max).join(', ')} and ${names.length - max} more`

export function CoverageBanner({ coverage }: { coverage?: StrategyCoverage }) {
  if (!coverage?.checked) return null

  const dead = coverage.dead_columns
  const partial = coverage.partial_columns

  // The proxy sentence is deliberately *not* here. Both stores carry a proxy
  // column, so it would be a banner on every strategy forever — which is the
  // failure this component's docblock warns about. `StoreInspector` renders it
  // as a footnote underneath instead: it is a fact about the store, and there
  // it is read only by someone who opened the store.
  if (!dead.length && !partial.length) return null

  // Worst first. The linear case is the only one that would have cost a run.
  const linear = coverage.model === 'linear'

  return (
    <Notice tone={dead.length && linear ? 'clay' : 'muted'} icon={dead.length > 0}>
      {dead.length > 0 && (
        <p className="text-body-sm leading-relaxed">
          <span className="font-mono">{LIST(dead)}</span>{' '}
          {dead.length === 1 ? 'is a column' : 'are columns'} {coverage.handler} trains on,
          and this store cannot compute {dead.length === 1 ? 'it' : 'them'} —{' '}
          {dead.length === 1 ? 'it would be' : 'they would be'} NaN at every row.
          {linear ? (
            <>
              {' '}A linear model drops every row with a gap, so{' '}
              {dead.length === 1 ? 'one dead column' : 'dead columns'} would empty the
              training set entirely. The generated config drops{' '}
              {dead.length === 1 ? 'it' : 'them'} before training, so this run is safe.
            </>
          ) : (
            <>
              {' '}The generated config drops {dead.length === 1 ? 'it' : 'them'} before
              training. A tree model would have tolerated{' '}
              {dead.length === 1 ? 'it' : 'them'} either way; a linear one would not.
            </>
          )}
        </p>
      )}

      {partial.length > 0 && (
        <p className="text-body-sm leading-relaxed text-muted-foreground">
          <span className="font-mono">{LIST(partial.map((c) => `$${c}`))}</span> is present
          for some instruments in this store and not others. An expression reading it is not
          broken — the names that lack it simply drop out of the cross-section, without an
          error.
        </p>
      )}
    </Notice>
  )
}
