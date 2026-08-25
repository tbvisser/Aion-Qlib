import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Plus } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Notice } from '@/components/ui/notice'
import { TabNav } from '@/components/ui/tab-nav'
import { PageHeader } from '@/components/layout/PageHeader'
import { PortfolioDialog } from '@/components/portfolio/PortfolioDialog'
import { BookOverview } from '@/components/book/BookOverview'
import { PortfolioListTab } from '@/components/book/PortfolioListTab'
import { StrategyListTab } from '@/components/book/StrategyListTab'
import { usePortfolios } from '@/hooks/usePortfolios'
import { api, type Run, type StoredStrategy } from '@/lib/api'

const TABS: readonly { key: BookTab; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'portfolios', label: 'Portfolios' },
  { key: 'strategies', label: 'Strategies' },
]

export function PortfoliosPage() {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const tab = tabFromParam(params.get('tab'))

  const {
    portfolios, loading: portfoliosLoading, error: portfoliosError, save,
  } = usePortfolios()

  const [strategies, setStrategies] = useState<StoredStrategy[]>([])
  const [strategiesLoading, setStrategiesLoading] = useState(true)
  const [strategiesError, setStrategiesError] = useState<string | null>(null)

  const [runs, setRuns] = useState<Run[]>([])

  useEffect(() => {
    let cancelled = false
    setStrategiesLoading(true)
    void api.listStrategies()
      .then((r) => { if (!cancelled) setStrategies(r.strategies) })
      .catch((e) => { if (!cancelled) setStrategiesError(e instanceof Error ? e.message : 'Could not load strategies') })
      .finally(() => { if (!cancelled) setStrategiesLoading(false) })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    let cancelled = false
    void api.listRuns(200)
      .then((r) => { if (!cancelled) setRuns(r.runs) })
      .catch(() => { if (!cancelled) setRuns([]) })
    return () => { cancelled = true }
  }, [])

  const [dialogOpen, setDialogOpen] = useState(false)

  const setTab = useCallback((next: BookTab) => {
    setParams((prev) => {
      const updated = new URLSearchParams(prev)
      if (next === 'overview') {
        updated.delete('tab')
      } else {
        updated.set('tab', next)
      }
      return updated
    }, { replace: true })
  }, [setParams])

  const error = portfoliosError ?? strategiesError

  return (
    <>
      <PageHeader
        title="Portfolios & Strategies"
        description="Real NAV from real bars, and the research behind it."
        actions={
          <Button size="sm" onClick={() => setDialogOpen(true)}>
            <Plus className="mr-1 h-3.5 w-3.5" /> New portfolio
          </Button>
        }
      />

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <TabNav tabs={TABS} active={tab} onChange={setTab} />

        <div className="p-6">
          {error && <Notice tone="destructive">{error}</Notice>}

          {tab === 'overview' && (
            <BookOverview
              portfolios={portfolios}
              strategies={strategies}
              runs={runs}
            />
          )}

          {tab === 'portfolios' && (
            <PortfolioListTab portfolios={portfolios} loading={portfoliosLoading} />
          )}

          {tab === 'strategies' && (
            <StrategyListTab strategies={strategies} loading={strategiesLoading} />
          )}
        </div>
      </div>

      <PortfolioDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSave={async (spec, id) => {
          const saved = await save(spec, id)
          setDialogOpen(false)
          navigate(`/book/portfolios/${saved.id}`)
        }}
      />
    </>
  )
}

type BookTab = 'overview' | 'portfolios' | 'strategies'

function tabFromParam(raw: string | null): BookTab {
  return raw && TABS.some((t) => t.key === raw) ? (raw as BookTab) : 'overview'
}
