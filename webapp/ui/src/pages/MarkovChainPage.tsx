import { PageHeader } from '@/components/layout/PageHeader'
import { MarkovIndicator } from '@/components/indicators/MarkovIndicator'

/**
 * Standalone Markov Chain page. The main home for this tool is now the
 * Indicators page (/lab/indicators?tab=markov); this wrapper keeps any direct
 * /lab/markov visits working until the redirect in App.tsx takes over.
 */
export function MarkovChainPage() {
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <PageHeader
        title="Markov Chain Regime Analyzer"
        description="Quantitative regime switching, transition probabilities and walk-forward signals."
      />
      <MarkovIndicator />
    </div>
  )
}
