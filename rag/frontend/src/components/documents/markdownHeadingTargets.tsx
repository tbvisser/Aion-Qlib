import { isValidElement, type ReactNode } from 'react'
import type { Components } from 'react-markdown'
import { cn } from '@/lib/utils'
import type { DocumentStructureNode } from '@/lib/api'

const HEADING_SELECTOR = '[data-doc-heading-title]'
type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6
type HeadingTag = `h${HeadingLevel}`

function headingText(children: ReactNode): string {
  if (typeof children === 'string' || typeof children === 'number') return String(children)
  if (Array.isArray(children)) return children.map(headingText).join('')
  if (isValidElement<{ children?: ReactNode }>(children)) return headingText(children.props.children)
  return ''
}

function normalizeHeadingTitle(title: string): string {
  return title.replace(/\s+/g, ' ').trim().toLowerCase()
}

function makeHeading(level: HeadingLevel): NonNullable<Components['h1']> {
  const Heading = `h${level}` as HeadingTag
  return ({ children, className, node: _node, ...props }) => {
    const title = normalizeHeadingTitle(headingText(children))
    return (
      <Heading
        {...props}
        className={cn('scroll-mt-20', className)}
        data-doc-heading-level={level}
        data-doc-heading-title={title}
      >
        {children}
      </Heading>
    )
  }
}

export const documentMarkdownComponents: Components = {
  h1: makeHeading(1),
  h2: makeHeading(2),
  h3: makeHeading(3),
  h4: makeHeading(4),
  h5: makeHeading(5),
  h6: makeHeading(6),
}

export function scrollToDocumentStructureNode(
  root: HTMLElement | null,
  targetNode?: DocumentStructureNode | null,
): boolean {
  if (!root || !targetNode || targetNode.kind !== 'section') return false

  const targetTitle = normalizeHeadingTitle(targetNode.title)
  if (!targetTitle) return false

  const headings = Array.from(root.querySelectorAll<HTMLElement>(HEADING_SELECTOR))
  const target = headings.find(heading => heading.dataset.docHeadingTitle === targetTitle)
  if (!target) return false

  target.scrollIntoView({ block: 'start', behavior: 'smooth' })
  return true
}
