/**
 * The builder's whole verdict on a spec, derived in one pass.
 *
 * This is the chain that used to live inline in `StrategyBuilderPage`:
 * canvas issues → merge with the preview's answer → route to stages → fold
 * into badges. It is pure — canvas snapshot and preview answer in, verdict
 * out — so a test can hold the composition the same way the pieces are
 * already held by their own tests.
 *
 * The inputs change together in practice: the preview answer arrives as one
 * response, and the canvas snapshot is one object per edit. One function per
 * change is therefore the same amount of work as the six separate memos it
 * replaces, without six dependency lists to keep honest.
 */
import type { SpecDefect, StrategyCoverage } from '@/lib/api'
import { mergeBlockers, mergeDefects } from '@/lib/blockers'
import {
  blocking, type FeatureDraft, type FeatureIssue,
} from '@/lib/factorExpr/featureSet'
import { fieldOf } from '@/lib/strategyOptions'
import {
  routeDefects, routeWarnings, unroutedWarnings, type RoutedWarning,
} from './routeWarning'
import { stageStatus, type StageBadge } from './stageStatus'
import type { StageId } from './stages'

export interface DeriveStatusInput {
  /** Every canvas column, finished or not — `FeatureSetSnapshot.features`. */
  features: readonly FeatureDraft[]
  /** The canvas's own findings — `FeatureSetSnapshot.issues`. */
  issues: FeatureIssue[]
  /**
   * The typed half of the preview's answer. `undefined` means the server did
   * not send any — an older build — and routing falls back to inferring
   * severity and placement from `warnings`. An empty array is a real answer
   * and must not be confused with that.
   */
  defects: SpecDefect[] | undefined
  /** The preview's plain-string warnings, the pre-defect wire format. */
  warnings: readonly string[]
  /** Advisory store facts from the same preview call. Never a blocker. */
  coverage: StrategyCoverage | undefined
}

export interface DerivedStatus {
  /** Canvas columns still being built. Advisory; not in the spec yet. */
  unfinished: FeatureDraft[]
  /** Every problem, each with the stage it belongs on and its severity. */
  routed: RoutedWarning[]
  /**
   * The blocking tier only, for the header chip and the run dialog. An
   * advisory describes a run that will finish and mean nothing, and a chip
   * reading "3 blocking" on a strategy that runs fine is how a reader learns
   * to ignore the chip. Both tiers still route to a card.
   */
  blockers: string[]
  /** The badge each stage card wears. */
  status: Record<StageId, StageBadge>
  /**
   * Warnings no routing rule claimed. Rendered page-level so a string a
   * future server invents cannot vanish.
   */
  unrouted: string[]
}

export function deriveStatus(input: DeriveStatusInput): DerivedStatus {
  const unfinished = input.features.filter((f) => !f.complete)

  // The client and the server check the same feature rules, on purpose: the
  // client so the message lands while the name is being typed, the server
  // because it is the authority and cannot be bypassed. That means both report
  // a collision, in near-identical words, at the same moment.
  //
  // One list, nothing said twice. The rules and the reasons for them live in
  // `lib/blockers`, where a test can hold them: this used to be inline, and the
  // live server-validation wiring quietly made the old rule insufficient.
  const canvasIssues = blocking(input.issues).map((i) => ({
    message: i.message,
    columnName: input.features.find((f) => f.id === i.columnId)?.name,
  }))

  // Two roads to the same shape. When the server sends `defects` — a code, the
  // field it is about, and its severity — routing is a lookup and the tier is
  // read off the wire. When it does not, the old prefix tables infer both from
  // the message text; that path is what every server before this shipped, and
  // it cannot mention an unknown universe or benchmark at all.
  //
  // Merged before routing either way, because saying the same thing twice is
  // what `lib/blockers` exists to prevent.
  const routed = input.defects
    ? routeDefects(mergeDefects(input.defects, canvasIssues), input.features)
    : routeWarnings(mergeBlockers(input.warnings, canvasIssues), input.features)

  return {
    unfinished,
    routed,
    blockers: routed.filter((r) => !r.advisory).map((r) => r.message),
    status: stageStatus(routed, { coverage: input.coverage, unfinished: unfinished.length }),
    unrouted: unroutedWarnings(routed),
  }
}

/**
 * The blocking messages the inspector prints at the top of its rail.
 *
 * Everything routed to the stage *except* what the field's own control now
 * shows beneath itself. The notice is what guarantees no message is lost, so
 * it keeps everything it is not certain is already on screen — including
 * every message from the legacy `warnings` path, which carries no field.
 *
 * The set of fields whose controls self-report is passed in (`COMPAT_FIELDS`
 * from the inspectors) rather than imported: it is a component-layer fact,
 * and this module must stay below that layer.
 */
export function stageBlockingMessages(
  routed: readonly RoutedWarning[],
  stage: StageId | null,
  shownByControls: ReadonlySet<string>,
): string[] {
  if (!stage) return []
  return routed
    .filter((r) => r.stage === stage && !r.advisory
                   && !shownByControls.has(fieldOf(r.path ?? '')))
    .map((r) => r.message)
}
