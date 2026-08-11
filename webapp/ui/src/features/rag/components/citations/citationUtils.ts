import type {
  AnswerCitation,
  CitationSupportStatus,
  CitationVerificationMode,
} from '@/features/rag/types'

// Canonical citation token is brace-wrapped: {[S<n>]}. The braces keep it
// distinct from ordinary bracketed numbers in prose/quotes (footnotes, ranges).
const ALIAS_PATTERN = /\{\[S(\d+)\]\}/g
// Combined-reference token: one brace pair carrying one or more S-numbers, in
// any grouping form models produce -- {[S1]}, {[S1, S8]}, {[S1, 2, 3]}, and the
// merged {[S1], [S5]} (separate brackets in one brace pair). Each atom is
// `[?Sn]?` separated by an optional comma; atoms never contain { or } so a match
// can't span adjacent tokens. Group 1 captures an optional leading space so a
// dropped (unresolved) marker is removed without leaving an orphaned gap.
const ALIAS_BLOCK_PATTERN = /( ?)(\{\s*\[?\s*S\s*\d+\s*\]?(?:\s*,?\s*\[?\s*S?\s*\d+\s*\]?)*\s*\})/g
const NUMBER_PATTERN = /\d+/g
const CITATION_LINK_PATTERN = /^citation:(.+)$/
const CITATION_GROUP_LINK_PATTERN = /^citation-more:(.+)$/
const COLLAPSE_GROUP_AT = 3

export function isCitationHref(href: string | undefined | null): href is string {
  return !!href && CITATION_LINK_PATTERN.test(href)
}

export function citationIdFromHref(href: string): string | null {
  const m = href.match(CITATION_LINK_PATTERN)
  return m ? m[1] : null
}

export function buildCitationHref(citationId: string): string {
  return `citation:${citationId}`
}

export function isCitationGroupHref(href: string | undefined | null): href is string {
  return !!href && CITATION_GROUP_LINK_PATTERN.test(href)
}

export function citationGroupIdFromHref(href: string): string | null {
  const m = href.match(CITATION_GROUP_LINK_PATTERN)
  return m ? m[1] : null
}

function buildCitationGroupHref(groupId: string): string {
  return `citation-more:${groupId}`
}

export function findCitation(
  citations: AnswerCitation[] | null | undefined,
  citationId: string,
): AnswerCitation | undefined {
  if (!citations) return undefined
  return citations.find((c) => c.citation_id === citationId)
}

export function findCitationByDisplayRef(
  citations: AnswerCitation[] | null | undefined,
  displayRef: string,
): AnswerCitation | undefined {
  if (!citations) return undefined
  return citations.find((c) => c.display_ref === displayRef)
}

export function findCitationByDisplayNumber(
  citations: AnswerCitation[] | null | undefined,
  n: number,
): AnswerCitation | undefined {
  if (!citations) return undefined
  return citations.find((c) => c.display_number === n)
}

export function effectiveStatus(
  status: CitationSupportStatus,
  mode: CitationVerificationMode | null | undefined,
): CitationSupportStatus {
  if (mode === 'unverified' && status === 'verified') return 'not_verified'
  return status
}

export function statusLabel(
  status: CitationSupportStatus,
  mode?: CitationVerificationMode | null,
): string {
  switch (status) {
    case 'verified':
      return 'Supported'
    case 'partially_supported':
      return 'Partially supported'
    case 'not_verified':
      return mode === 'semantic-text' ? 'Not supported' : 'Not checked'
    case 'contradicted':
      return 'Contradicted'
    case 'verification_failed':
      return 'Verification failed'
  }
}

export function citationModeLabel(
  mode: CitationVerificationMode | null | undefined,
): string {
  return mode === 'unverified' ? 'Quick Citation' : 'Checked Citation'
}

export function citationBadgeLabel(
  status: CitationSupportStatus,
  mode: CitationVerificationMode | null | undefined,
): string {
  const effective = effectiveStatus(status, mode)
  if (mode === 'unverified') return citationModeLabel(mode)
  if (effective === 'verified') return citationModeLabel(mode)
  return statusLabel(effective, mode)
}

export function statusChipClasses(
  status: CitationSupportStatus,
  mode?: CitationVerificationMode | null,
): string {
  switch (status) {
    case 'verified':
      return 'border-primary/30 bg-primary/10 text-primary hover:bg-primary/20'
    case 'partially_supported':
      return 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300 hover:bg-amber-500/20'
    case 'not_verified':
      if (mode === 'semantic-text') {
        return 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300 hover:bg-amber-500/20'
      }
      return 'border-border bg-muted/60 text-muted-foreground hover:bg-muted'
    case 'verification_failed':
      if (mode === 'semantic-text') {
        return 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300 hover:bg-amber-500/20'
      }
      return 'border-border bg-muted/60 text-muted-foreground hover:bg-muted'
    case 'contradicted':
      return 'border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/20'
  }
}

/**
 * Convert {[S#]} / {[S1, S8]} citation tokens inside markdown text into
 * clickable citation: markdown links, e.g. `[1](citation:cite_abc)`.
 *
 * Combined tokens like `{[S1, S8]}` are expanded into adjacent chips. Longer
 * adjacent runs collapse behind a local "more" chip until expanded. Unknown
 * numbers are dropped; if no number in a token resolves, the whole token (and
 * its leading space) is removed so an invalid/invented marker never renders as
 * raw `{[S#]}` text.
 */
export function injectCitationLinks(
  text: string,
  citations: AnswerCitation[] | null | undefined,
  options?: { expandedGroups?: ReadonlySet<string> },
): string {
  type CitationTokenBlock = {
    start: number
    end: number
    lead: string
    numbers: number[]
  }

  const blocks = Array.from(text.matchAll(ALIAS_BLOCK_PATTERN)).map((match) => ({
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
    lead: match[1] || '',
    numbers: (match[2].match(NUMBER_PATTERN) || []).map((n) => parseInt(n, 10)),
  }))

  if (blocks.length === 0) return text
  if (!citations || citations.length === 0) return text

  const renderRun = (run: CitationTokenBlock[], runIndex: number): string => {
    const rawNumbers = run.flatMap((block) => block.numbers)
    const entries: Array<{ number: number; href: string }> = []
    const seenHrefs = new Set<string>()

    for (const number of rawNumbers) {
      const cite = findCitationByDisplayNumber(citations, number)
      if (!cite) continue
      const href = buildCitationHref(cite.citation_id)
      if (seenHrefs.has(href)) continue
      seenHrefs.add(href)
      entries.push({ number, href })
    }

    if (entries.length === 0) return ''

    const lead = run[0]?.lead || ''
    if (entries.length < COLLAPSE_GROUP_AT) {
      return `${lead}${entries.map((entry) => `[${entry.number}](${entry.href})`).join('')}`
    }

    const groupId = `${run[0].start}-${rawNumbers.join('-')}-${runIndex}`
    const first = entries[0]
    const rest = entries.slice(1)
    const expanded = options?.expandedGroups?.has(groupId) ?? false
    const toggle = `[${expanded ? 'x' : '...'}](${buildCitationGroupHref(groupId)})`
    if (!expanded) {
      return `${lead}[${first.number}](${first.href})${toggle}`
    }
    return `${lead}[${first.number}](${first.href})${toggle}${rest
      .map((entry) => `[${entry.number}](${entry.href})`)
      .join('')}`
  }

  let out = ''
  let cursor = 0
  let run: CitationTokenBlock[] = []
  let runIndex = 0

  const flushRun = () => {
    if (run.length === 0) return
    out += renderRun(run, runIndex)
    runIndex += 1
    cursor = run[run.length - 1].end
    run = []
  }

  for (const block of blocks) {
    if (run.length === 0) {
      out += text.slice(cursor, block.start)
      run = [block]
      cursor = block.end
      continue
    }

    const between = text.slice(cursor, block.start)
    if (between.trim() === '') {
      run.push(block)
      cursor = block.end
      continue
    }

    flushRun()
    out += text.slice(cursor, block.start)
    run = [block]
    cursor = block.end
  }

  flushRun()
  out += text.slice(cursor)
  return out
}

export function parseAliasIntegers(text: string): number[] {
  const out: number[] = []
  for (const m of text.matchAll(ALIAS_PATTERN)) {
    const n = parseInt(m[1], 10)
    if (!Number.isNaN(n)) out.push(n)
  }
  return out
}

/**
 * Only http(s) URLs are safe to put in an href or iframe src. Anything else
 * (javascript:, data:, blob:, file:, vbscript:) can run script in the app
 * origin. Web-citation source URIs are attacker-influenced (captured from web
 * search / page content), so every place that renders one as a link or frame
 * must pass it through here first. Returns the normalized URL, or null when it
 * isn't a safe absolute http(s) URL.
 */
export function safeWebUrl(uri: string | null | undefined): string | null {
  if (!uri) return null
  try {
    const u = new URL(uri)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null
  } catch {
    return null
  }
}
