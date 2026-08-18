import type { KeycardNodeTypeMeta } from '@/lib/api'
import { NODE_TYPE_INFO, normaliseCategory, type NodeCategory } from './nodeRegistry'

export const QUANT_REQUIRED_CATEGORIES = [
  'Data',
  'Features',
  'Model',
  'Portfolio',
  'Output',
] as const satisfies NodeCategory[]

export const RULE_REQUIRED_CATEGORIES = [
  'Schedule',
  'Rules',
  'Execution',
  'Portfolio',
  'Output',
] as const satisfies NodeCategory[]

// Categories that only exist in rule-based workflows. Execution is excluded
// because the quant pipeline's "costs" node also belongs to Execution.
export const RULE_UNIQUE_CATEGORIES = [
  'Schedule',
  'Rules',
  'Management',
  'Variables',
  'Chart Drawings',
] as const satisfies NodeCategory[]

export interface KeycardNodeSummary {
  type: string
}

/**
 * Return the list of required categories that are missing from the given nodes.
 *
 * The function auto-detects whether the keycard follows a classic quant pipeline
 * (Data -> Features -> Model -> Portfolio -> Output) or an Aion-style rule
 * workflow (Schedule -> Rules -> Execution -> Portfolio -> Output).
 */
export function missingRequiredCategories(
  nodes: KeycardNodeSummary[],
  metaByType: Map<string, KeycardNodeTypeMeta>,
): NodeCategory[] {
  const categories = new Set<NodeCategory>(
    nodes
      .map((n) => {
        const raw = (metaByType.get(n.type) ?? NODE_TYPE_INFO[n.type])?.category
        return normaliseCategory(raw)
      })
      .filter((c): c is NodeCategory => Boolean(c)),
  )

  const isRuleBased = RULE_UNIQUE_CATEGORIES.some((c) => categories.has(c))
  const required = isRuleBased ? RULE_REQUIRED_CATEGORIES : QUANT_REQUIRED_CATEGORIES
  return required.filter((c) => !categories.has(c))
}
