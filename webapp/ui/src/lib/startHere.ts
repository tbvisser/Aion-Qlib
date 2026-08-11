/**
 * What an empty Strategy Builder offers you.
 *
 * Two things, both pure so a test can hold them: the phrasings that show what
 * the describe box accepts, and the rule that picks which template cards get a
 * seat on the front door.
 *
 * `EXAMPLES` lives here rather than in either component because two surfaces
 * render it — the front door and the assistant dock's empty state — and two
 * hardcoded arrays on one screen is how they end up giving different advice.
 */
import type { TemplateEntry } from './api'

/**
 * Plain-language phrasings, each demonstrating a different thing the builder
 * can be told: an asset class, a turnover preference, a change to what is
 * already on screen, and a cost concern.
 *
 * Deliberately not prefixed with "Try:" or wrapped in quotes — they are sent
 * verbatim when clicked, so what you read is what the model receives.
 */
export const EXAMPLES = [
  'Start me from a low-turnover baseline',
  'Momentum on US large caps, rebalanced weekly',
  'Make this more conservative',
  'What would you change to cut trading costs?',
] as const

/**
 * Families that answer a question this page is not asking.
 *
 * `model-comparison` is every template of the form "CatBoost, same everything
 * else" — a learner swapped into a strategy that already exists. That is ML
 * Studio's question now, asked there across several models at once rather than
 * one saved copy at a time, and offering it as somewhere to *start* would put
 * the choice of model back in front of the idea. The family stays in the rail,
 * where it is browsable beside every other one; it just does not get one of the
 * four seats on the front door.
 */
const NOT_A_STARTING_POINT = new Set(['model-comparison'])

/**
 * The cards on the front door.
 *
 * Three rules, in this order:
 *
 * 1. **Runnable first.** A card that cannot run on this machine is a worse
 *    first click than one that can, so the runnable ones are considered before
 *    anything else.
 * 2. **One per family**, so four cards are four different ideas rather than
 *    four momentum variants. The rail is where you go to see every member of a
 *    family; this is the front door, and its job is breadth.
 * 3. **Backfill rather than hide.** Once every family has contributed, the
 *    remaining slots are filled from what is left — including unrunnable
 *    templates. A short list of runnable cards beats a full list that lies,
 *    but an *empty* front door is worse than one showing a card that explains
 *    on click why it cannot run. That explanation is the whole reason
 *    `TemplateRail` shows unrunnable rows rather than filtering them out.
 *
 * Server order is preserved throughout — the backend decides which family a
 * beginner should meet first (`strategy_templates.FAMILIES`) and a second
 * opinion here would fight it.
 */
export function pickStarters(all: readonly TemplateEntry[], n: number): TemplateEntry[] {
  if (n <= 0) return []

  const templates = all.filter((t) => !NOT_A_STARTING_POINT.has(t.family))
  const picked: TemplateEntry[] = []
  const seenFamily = new Set<string>()

  // Pass one: the best card from each family, runnable families first.
  for (const pool of [templates.filter((t) => t.runnable),
                      templates.filter((t) => !t.runnable)]) {
    for (const template of pool) {
      if (picked.length >= n) return picked
      if (seenFamily.has(template.family)) continue
      seenFamily.add(template.family)
      picked.push(template)
    }
  }

  // Pass two: backfill from whatever is left, still runnable-first.
  const taken = new Set(picked.map((t) => t.id))
  for (const pool of [templates.filter((t) => t.runnable),
                      templates.filter((t) => !t.runnable)]) {
    for (const template of pool) {
      if (picked.length >= n) return picked
      if (taken.has(template.id)) continue
      taken.add(template.id)
      picked.push(template)
    }
  }

  return picked
}
