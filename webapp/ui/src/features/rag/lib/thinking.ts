export type ParsedThinkingSegment =
  | { type: 'thinking'; content: string; isComplete: boolean }
  | { type: 'text'; content: string }

const THINK_OPEN_TAG = /<think\b[^>]*>/i
const THINK_CLOSE_TAG = /<\/think\s*>/i

function stripPartialThinkTagPrefix(text: string): string {
  const lower = text.toLowerCase()
  const partials = [
    '<',
    '</',
    '</t',
    '</th',
    '</thi',
    '</thin',
    '</think',
    '</think>',
    '<t',
    '<th',
    '<thi',
    '<thin',
    '<think',
  ]

  for (const partial of partials) {
    if (lower.endsWith(partial)) {
      return text.slice(0, -partial.length)
    }
  }

  return text
}

function stripStrayThinkClosers(text: string): string {
  return text.replace(/<\/think\s*>\s*/gi, '')
}

export function stripThinkTags(text: string): string {
  let result = text.replace(/<think\b[^>]*>[\s\S]*?<\/think\s*>\s*/gi, '')
  result = result.replace(/<think\b[^>]*>[\s\S]*$/gi, '')
  result = result.replace(/<\/think\s*>\s*/gi, '')
  return result.trim()
}

export function parseTextWithThinking(text: string): ParsedThinkingSegment[] {
  const segments: ParsedThinkingSegment[] = []
  let remaining = text

  while (remaining.length > 0) {
    const openMatch = remaining.match(THINK_OPEN_TAG)

    if (!openMatch || openMatch.index === undefined) {
      const visibleText = stripPartialThinkTagPrefix(stripStrayThinkClosers(remaining))
      if (visibleText.trim()) {
        segments.push({ type: 'text', content: visibleText })
      }
      break
    }

    if (openMatch.index > 0) {
      const beforeText = stripPartialThinkTagPrefix(stripStrayThinkClosers(remaining.slice(0, openMatch.index)))
      if (beforeText.trim()) {
        segments.push({ type: 'text', content: beforeText })
      }
    }

    const afterOpen = remaining.slice(openMatch.index + openMatch[0].length)
    const closeMatch = afterOpen.match(THINK_CLOSE_TAG)

    if (!closeMatch || closeMatch.index === undefined) {
      segments.push({
        type: 'thinking',
        content: afterOpen,
        isComplete: false,
      })
      break
    }

    const thinkContent = afterOpen.slice(0, closeMatch.index)
    segments.push({
      type: 'thinking',
      content: thinkContent.trim(),
      isComplete: true,
    })

    remaining = afterOpen.slice(closeMatch.index + closeMatch[0].length)
  }

  return segments
}
