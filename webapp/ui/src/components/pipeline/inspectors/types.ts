/**
 * What every stage inspector is handed.
 *
 * One prop bag rather than seven bespoke signatures: the inspectors are
 * rendered by a single switch in `StageInspector`, and a per-stage signature
 * would put that switch in the business of knowing which stage needs what.
 */
import type {
  DataStore, ModelsResponse, StrategyCoverage, StrategyExplain, StrategySpec,
} from '@/lib/api'
import type { StageId } from '@/lib/strategyGraph/stages'

export interface InspectorProps {
  spec: StrategySpec
  setSpec: React.Dispatch<React.SetStateAction<StrategySpec>>
  stores: DataStore[]
  models: ModelsResponse | null
  explain?: StrategyExplain
  coverage?: StrategyCoverage
  /** Refetch `/data-stores` after an ingest builds one. */
  onStoresChanged: () => void
  /** Leave the pipeline for the factor canvas. */
  onOpenFeatureCanvas: () => void
  /** Canvas columns still being built — shown, but not in the spec. */
  unfinished: number
  /** Blockers and advisories already routed to this stage. */
  notes: string[]
}

export type InspectorComponent = (props: InspectorProps) => JSX.Element

/** null means nothing is selected, and the rail is not rendered at all. */
export type SelectedStage = StageId | null
