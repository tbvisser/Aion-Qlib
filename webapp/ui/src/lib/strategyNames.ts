/**
 * Naming a duplicate without colliding with what is already saved.
 *
 * Small, but it is the difference between a strategy list that reads as a
 * history and one with four rows called "Momentum v3 copy".
 */

/** How long a `StrategySpec.name` may be, mirroring the Pydantic constraint. */
const MAX_NAME = 80

/** Strips a trailing ` copy` / ` copy N` so copies of copies do not stack. */
function base(name: string): string {
  return name.replace(/ copy(?: \d+)?$/, '')
}

/**
 * The next free `<name> copy` / `<name> copy N`.
 *
 * Truncates rather than overflowing the server's 80-character limit — a
 * duplicate that 422s is a worse answer than one with a shortened name.
 */
export function nextCopyName(name: string, existing: readonly string[]): string {
  const taken = new Set(existing.map((n) => n.trim()))
  const root = base(name.trim()) || 'New strategy'

  const fit = (candidate: string) =>
    candidate.length <= MAX_NAME ? candidate : candidate.slice(0, MAX_NAME).trimEnd()

  const first = fit(`${root} copy`)
  if (!taken.has(first)) return first

  for (let n = 2; n < 1000; n += 1) {
    const candidate = fit(`${root} copy ${n}`)
    if (!taken.has(candidate)) return candidate
  }
  return first
}
