import { useLocation } from 'react-router-dom'
import { PageHeader } from '@/components/layout/PageHeader'
import { ComingSoon } from '@/components/ComingSoon'
import { allNavSections } from '@/components/layout/NavItems'

/**
 * Stands in for the Aion Platform destinations this app carries in its sidebar
 * but does not implement. The nav is deliberately the platform's full nav, so
 * these routes exist and say so plainly rather than 404ing or being hidden.
 *
 * Where the nav entry carries a `blurb`, that is shown instead of the generic
 * line: arriving here should tell you what the page becomes and which existing
 * piece folds into it, so the sidebar reads as a roadmap rather than a wall.
 */
export function PlaceholderPage() {
  const { pathname } = useLocation()
  const item = allNavSections
    .flatMap((section) => section.items)
    .find((i) => i.route === pathname)

  return (
    <>
      <PageHeader title={item?.label ?? 'Not built yet'} />
      <div className="flex-1 overflow-y-auto p-6">
        <ComingSoon phase="Aion Platform">
          {item?.blurb ??
            `${item?.label ?? 'This page'} lives in the Aion Platform and is not part of this app yet.`}
        </ComingSoon>
      </div>
    </>
  )
}
