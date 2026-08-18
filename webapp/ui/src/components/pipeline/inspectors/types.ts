/**
 * What every stage inspector is handed.
 *
 * One prop bag rather than seven bespoke signatures: the inspectors are
 * rendered by a single switch in `StageInspector`, and a per-stage signature
 * would put that switch in the business of knowing which stage needs what.
 */
import type {
  DataStore, FieldOptions, ModelsResponse, SpecDefect, StrategyCoverage, StrategyExplain,
  StrategySpec,
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
  /**
   * What each field may be set to, judged against the rest of the spec.
   *
   * Optional: `undefined` means the server sent none, and every control falls
   * back to the list it built for itself. That is what the builder did before
   * this existed, so an older server degrades to it rather than to an empty
   * dropdown.
   */
  options?: Record<string, FieldOptions>
  /** Every defect, typed, with the field each is about. Undefined as above. */
  defects?: SpecDefect[]
  /**
   * Take one of a field's resolutions.
   *
   * A patch rather than a `setSpec` call because a resolution may change the
   * *store*, and that has to go through `applyStore`'s cascade — setting
   * `data_store` alone leaves the universe and the end date pointing at the
   * store it just left.
   */
  applyPatch: (patch: Record<string, unknown>) => void
}

export type InspectorComponent = (props: InspectorProps) => JSX.Element

/** null means nothing is selected, and the rail is not rendered at all. */
export type SelectedStage = StageId | null
