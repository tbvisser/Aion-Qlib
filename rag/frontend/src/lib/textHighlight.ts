// Cross-node exact-text highlighting for rendered markdown/HTML/plain text.
//
// Locates a cited passage inside an already-rendered DOM subtree and wraps it in
// `<mark data-citation-target="active">`, scrolling the first match into view.
// It tolerates the differences between a stored citation quote and rendered text:
// collapsed whitespace, text split across element boundaries (bold/links), and
// markdown markers that don't survive rendering (headings, list bullets, inline
// emphasis, table pipes).
//
// Shared by the citation source viewer (text/markdown sources) and the citation
// document Text view (extracted-markdown rendering of PDF/DOCX documents) so both
// surfaces highlight identically.

interface TextEntry {
  char: string
  node: Text | null
  offset: number
}

interface NormalizedTextMap {
  text: string
  normalizedToEntry: number[]
}

interface EntryRange {
  startEntryIndex: number
  endEntryIndex: number
}

// The per-character entry list and its normalized projection for one spacing
// variant. Built once per `highlightExactText` call and reused across every
// candidate and match strategy.
interface PreparedTextMap {
  entries: TextEntry[]
  normalized: NormalizedTextMap
}

const OMITTED_TEXT_MARKER = /\[\s*(?:\.{3}|\u2026)\s*\]/g

function normalizeComparableChar(char: string): string {
  if (/[\u2018\u2019\u201B\u2032]/.test(char)) return "'"
  if (/[\u201C\u201D\u2033]/.test(char)) return '"'
  if (/[\u2010-\u2015\u2212]/.test(char)) return '-'
  return char
}

function unwrapExistingHighlights(root: HTMLElement) {
  root.querySelectorAll('mark[data-citation-target="active"]').forEach((mark) => {
    const parent = mark.parentNode
    if (!parent) return
    while (mark.firstChild) {
      parent.insertBefore(mark.firstChild, mark)
    }
    parent.removeChild(mark)
    parent.normalize()
  })
}

function collectTextEntries(root: HTMLElement, addNodeSpacing: boolean): TextEntry[] {
  const entries: TextEntry[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement
      if (!parent || parent.closest('script, style, noscript, mark[data-citation-target="active"]')) {
        return NodeFilter.FILTER_REJECT
      }
      return node.nodeValue ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
    },
  })

  let node = walker.nextNode()
  while (node) {
    const text = node.nodeValue || ''
    if (addNodeSpacing && entries.length > 0) {
      entries.push({ char: ' ', node: null, offset: -1 })
    }
    for (let offset = 0; offset < text.length; offset += 1) {
      entries.push({ char: text[offset], node: node as Text, offset })
    }
    node = walker.nextNode()
  }

  return entries
}

function normalizeEntries(entries: TextEntry[]): NormalizedTextMap {
  let text = ''
  const normalizedToEntry: number[] = []
  let lastWasWhitespace = false

  entries.forEach((entry, index) => {
    if (/\s/.test(entry.char)) {
      if (!lastWasWhitespace) {
        text += ' '
        normalizedToEntry.push(index)
        lastWasWhitespace = true
      }
      return
    }

    text += normalizeComparableChar(entry.char)
    normalizedToEntry.push(index)
    lastWasWhitespace = false
  })

  return { text, normalizedToEntry }
}

function normalizeSearchText(value: string): string {
  return Array.from(value)
    .map((char) => (/\s/.test(char) ? ' ' : normalizeComparableChar(char)))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
}

function stripInlineMarkdown(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/<[^>]+>/g, '')
}

function stripMarkdownLineMarkers(value: string): string {
  return value
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/(^|\s)#{1,6}\s+/g, '$1')
    .replace(/^>\s?/gm, '')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/^\d+[.)]\s+/gm, '')
}

function stripSyntheticPartHeadings(value: string): string {
  // Drop synthetic "(Part N)" heading lines the chunker injected. The leading
  // markdown "#" is optional: some older citations stored the heading with the
  // "##" already stripped (e.g. "STATEMENT OF THE CASE 1 (Part 24)"), so match a
  // short heading-like line that simply ENDS in "(Part N)". Only used to build a
  // fallback candidate, so an over-eager match is harmless.
  return value
    .split(/\r?\n/)
    .filter((line) => !/^#{0,6}\s*\S.*\s\(Part\s+\d+\)\s*$/i.test(line.trim()))
    .join('\n')
}

// Expand one base string into the markdown-tolerant variants we try to match:
// the raw text, a table-row form (pipes flattened to spaces), and a fully
// marker-stripped form.
function tolerantVariants(base: string): string[] {
  const trimmed = base.trim()
  if (!trimmed) return []
  const variants = [trimmed]

  if (trimmed.includes('|')) {
    const tableText = trimmed
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => stripInlineMarkdown(cell).trim())
      .filter(Boolean)
      .join(' ')
    variants.push(tableText)
  }

  variants.push(stripInlineMarkdown(stripMarkdownLineMarkers(trimmed)))
  return variants
}

function markdownTargetCandidates(exact: string): string[] {
  const trimmed = exact.trim()
  const candidates = tolerantVariants(trimmed)
  const withoutSyntheticHeadings = stripSyntheticPartHeadings(trimmed).trim()
  if (withoutSyntheticHeadings && withoutSyntheticHeadings !== trimmed) {
    candidates.push(...tolerantVariants(withoutSyntheticHeadings))
  }
  return Array.from(new Set(candidates.map(normalizeSearchText).filter(Boolean)))
}

function nodeRangesForEntryRange(
  entries: TextEntry[],
  startEntryIndex: number,
  endEntryIndex: number,
): Array<[Text, { start: number; end: number }]> {
  const nodeRanges = new Map<Text, { start: number; end: number }>()

  for (let index = startEntryIndex; index <= endEntryIndex; index += 1) {
    const entry = entries[index]
    if (!entry?.node) continue
    const current = nodeRanges.get(entry.node)
    if (current) {
      current.start = Math.min(current.start, entry.offset)
      current.end = Math.max(current.end, entry.offset + 1)
    } else {
      nodeRanges.set(entry.node, { start: entry.offset, end: entry.offset + 1 })
    }
  }

  return Array.from(nodeRanges.entries()).filter(([node, range]) =>
    node.nodeValue?.slice(range.start, range.end).trim(),
  )
}

function highlightNodeRanges(ranges: Array<[Text, { start: number; end: number }]>): boolean {
  const sortedRanges = [...ranges].sort(([nodeA, rangeA], [nodeB, rangeB]) => {
    if (nodeA === nodeB) return rangeB.start - rangeA.start
    const position = nodeA.compareDocumentPosition(nodeB)
    if (position & Node.DOCUMENT_POSITION_FOLLOWING) return 1
    if (position & Node.DOCUMENT_POSITION_PRECEDING) return -1
    return 0
  })
  const marks: HTMLElement[] = []

  for (const [node, rangeOffsets] of sortedRanges) {
    const nodeValue = node.nodeValue || ''
    const start = Math.min(rangeOffsets.start, nodeValue.length)
    const end = Math.min(rangeOffsets.end, nodeValue.length)
    if (end <= start || !nodeValue.slice(start, end).trim()) continue
    const range = document.createRange()
    range.setStart(node, start)
    range.setEnd(node, end)
    const mark = document.createElement('mark')
    mark.className = 'citation-highlight rounded-sm bg-amber-200/70 dark:bg-amber-500/30 px-0.5'
    mark.setAttribute('data-citation-target', 'active')
    range.surroundContents(mark)
    marks.unshift(mark)
  }

  marks[0]?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  return marks.length > 0
}

function highlightEntryRanges(entries: TextEntry[], entryRanges: EntryRange[]): boolean {
  const nodeRanges = entryRanges.flatMap(({ startEntryIndex, endEntryIndex }) =>
    nodeRangesForEntryRange(entries, startEntryIndex, endEntryIndex),
  )
  return highlightNodeRanges(nodeRanges)
}

function highlightEntryRange(entries: TextEntry[], startEntryIndex: number, endEntryIndex: number): boolean {
  return highlightEntryRanges(entries, [{ startEntryIndex, endEntryIndex }])
}

function findAndHighlight({ entries, normalized }: PreparedTextMap, candidate: string): boolean {
  const index = normalized.text.indexOf(candidate)
  if (index === -1) return false

  const startEntryIndex = normalized.normalizedToEntry[index]
  const endEntryIndex = normalized.normalizedToEntry[index + candidate.length - 1]
  if (startEntryIndex == null || endEntryIndex == null) return false

  return highlightEntryRange(entries, startEntryIndex, endEntryIndex)
}

function findAndHighlightWithOmittedText({ entries, normalized }: PreparedTextMap, candidate: string): boolean {
  if (!OMITTED_TEXT_MARKER.test(candidate)) return false
  OMITTED_TEXT_MARKER.lastIndex = 0

  const segments = candidate
    .split(OMITTED_TEXT_MARKER)
    .map(normalizeSearchText)
    .filter(Boolean)
  if (segments.length < 2) return false

  let cursor = 0
  const orderedRanges: EntryRange[] = []
  let ordered = true

  for (const segment of segments) {
    const index = normalized.text.indexOf(segment, cursor)
    if (index === -1) {
      ordered = false
      break
    }
    const startEntryIndex = normalized.normalizedToEntry[index]
    const endEntryIndex = normalized.normalizedToEntry[index + segment.length - 1]
    if (startEntryIndex == null || endEntryIndex == null) {
      ordered = false
      break
    }
    orderedRanges.push({ startEntryIndex, endEntryIndex })
    cursor = index + segment.length
  }

  if (ordered) {
    return highlightEntryRanges(entries, orderedRanges)
  }

  const unorderedRanges: EntryRange[] = []
  for (const segment of segments) {
    const index = normalized.text.indexOf(segment)
    if (index === -1) return false
    const startEntryIndex = normalized.normalizedToEntry[index]
    const endEntryIndex = normalized.normalizedToEntry[index + segment.length - 1]
    if (startEntryIndex == null || endEntryIndex == null) return false
    unorderedRanges.push({ startEntryIndex, endEntryIndex })
  }

  return highlightEntryRanges(entries, unorderedRanges)
}

/**
 * Highlight `exact` inside `root`, returning whether a match was found and
 * marked. Any previously applied citation highlight in `root` is removed first,
 * so this is safe to call repeatedly as the cited passage changes.
 */
export function highlightExactText(root: HTMLElement, exact: string | undefined | null): boolean {
  unwrapExistingHighlights(root)
  if (!exact) return false
  const candidates = markdownTargetCandidates(exact)
  if (candidates.length === 0) return false

  // Build the per-character entry map + normalized text once per spacing variant
  // and reuse it across every candidate and strategy. Each map allocates one
  // object per rendered character, so rebuilding it per candidate (~12x on a
  // miss) froze the main thread on large documents. `unwrapExistingHighlights`
  // ran above and we return on the first match, so the DOM is stable while these
  // maps are live.
  const prepared: Array<PreparedTextMap | null> = [null, null]
  const getMap = (addNodeSpacing: boolean): PreparedTextMap => {
    const slot = addNodeSpacing ? 1 : 0
    let map = prepared[slot]
    if (!map) {
      const entries = collectTextEntries(root, addNodeSpacing)
      map = { entries, normalized: normalizeEntries(entries) }
      prepared[slot] = map
    }
    return map
  }

  for (const candidate of candidates) {
    if (
      findAndHighlight(getMap(false), candidate) ||
      findAndHighlight(getMap(true), candidate) ||
      findAndHighlightWithOmittedText(getMap(false), candidate) ||
      findAndHighlightWithOmittedText(getMap(true), candidate)
    ) {
      return true
    }
  }

  return false
}
