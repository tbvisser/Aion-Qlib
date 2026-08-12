import { useEffect, useRef, type ReactNode } from 'react'
import { ChevronDown, Search, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { PageHeader } from './PageHeader'
import { cn } from '@/lib/utils'

/**
 * The header every index page wears: title, a search that stays out of the way
 * until asked for, a filter-or-sort menu, and the primary action.
 *
 * Wraps `PageHeader` rather than replacing it — the title block, its bleed and
 * its border are the house contract, and an index page is a page like any
 * other. Everything here lands in `PageHeader`'s `actions` slot.
 *
 * The search collapses to an icon because on a page whose whole body is a list,
 * a permanently open search box reads as the page's subject rather than as a
 * tool for narrowing it.
 */

export interface IndexMenuOption<T extends string = string> {
  value: T
  label: string
}

export interface IndexMenu<T extends string = string> {
  /** The word before the value: "Filter by", "Sort by". */
  label: string
  value: T
  options: readonly IndexMenuOption<T>[]
  onChange: (value: T) => void
  testId?: string
}

export interface IndexSearch {
  value: string
  onChange: (value: string) => void
  /** Controlled open state, so a page can close search when it clears filters. */
  open: boolean
  onOpenChange: (open: boolean) => void
  placeholder?: string
}

export function IndexHeader({
  title,
  description,
  search,
  menus = [],
  actions,
}: {
  title: string
  description?: string
  search?: IndexSearch
  menus?: readonly IndexMenu[]
  actions?: ReactNode
}) {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (search?.open) inputRef.current?.focus()
  }, [search?.open])

  return (
    <PageHeader
      title={title}
      description={description}
      actions={
        <>
          {search && (search.open ? (
            <div className="relative w-56">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" />
              <Input
                ref={inputRef}
                data-testid="index-search"
                value={search.value}
                onChange={(event) => search.onChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== 'Escape') return
                  search.onChange('')
                  search.onOpenChange(false)
                }}
                placeholder={search.placeholder ?? 'Search…'}
                aria-label={search.placeholder ?? 'Search'}
                className="h-8 pl-8 pr-8 text-xs"
              />
              <button
                type="button"
                onClick={() => {
                  search.onChange('')
                  search.onOpenChange(false)
                }}
                aria-label="Close search"
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ) : (
            <button
              type="button"
              data-testid="index-search-toggle"
              onClick={() => search.onOpenChange(true)}
              aria-label={search.placeholder ?? 'Search'}
              title={search.placeholder ?? 'Search'}
              className={cn(
                'flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-foreground/[0.04] hover:text-foreground',
                // A query surviving behind a closed box would filter the list
                // with nothing on screen saying why, so say it here.
                search.value ? 'bg-foreground/[0.07] text-foreground' : 'text-muted-foreground',
              )}
            >
              <Search className="h-4 w-4" />
            </button>
          ))}

          {menus.map((menu) => {
            const current = menu.options.find((option) => option.value === menu.value)
            return (
              <DropdownMenu key={menu.label}>
                <DropdownMenuTrigger
                  data-testid={menu.testId}
                  className="flex h-8 items-center gap-1 rounded-lg border border-border/50 px-2.5 text-xs text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring/20"
                >
                  {menu.label}{' '}
                  <span className="font-medium text-foreground">{current?.label ?? menu.value}</span>
                  <ChevronDown className="h-3 w-3 shrink-0" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuRadioGroup
                    value={menu.value}
                    onValueChange={(value) => menu.onChange(value)}
                  >
                    {menu.options.map((option) => (
                      <DropdownMenuRadioItem key={option.value} value={option.value} className="text-xs">
                        {option.label}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            )
          })}

          {actions}
        </>
      }
    />
  )
}
