import { useCallback, useEffect, useRef, useState, forwardRef } from 'react'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { CitationPreviewPopover } from './CitationPreviewPopover'
import { effectiveStatus, statusChipClasses } from './citationUtils'
import type {
  AnswerCitation,
  CitationVerificationMode,
} from '@/types'
import { cn } from '@/lib/utils'

interface CitationButtonProps {
  citation?: AnswerCitation
  fallbackLabel?: string
  verificationMode?: CitationVerificationMode | null
  active?: boolean
  onView?: (citation: AnswerCitation) => void
}

export const CitationButton = forwardRef<HTMLButtonElement, CitationButtonProps>(
  function CitationButton({ citation, fallbackLabel, verificationMode, active, onView }, ref) {
    const [open, setOpen] = useState(false)
    const triggerRef = useRef<HTMLButtonElement | null>(null)
    const contentRef = useRef<HTMLDivElement | null>(null)
    const closeTimerRef = useRef<number | null>(null)
    const pinnedOpenRef = useRef(false)
    const pointerInsideRef = useRef(false)

    const setTriggerRefs = useCallback(
      (node: HTMLButtonElement | null) => {
        triggerRef.current = node
        if (typeof ref === 'function') {
          ref(node)
        } else if (ref) {
          ref.current = node
        }
      },
      [ref],
    )

    const clearCloseTimer = () => {
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current)
        closeTimerRef.current = null
      }
    }

    const openPreview = () => {
      clearCloseTimer()
      setOpen(true)
    }

    const scheduleClosePreview = () => {
      if (pinnedOpenRef.current) return
      clearCloseTimer()
      closeTimerRef.current = window.setTimeout(() => {
        setOpen(false)
        closeTimerRef.current = null
      }, 120)
    }

    const handlePreviewEnter = () => {
      pointerInsideRef.current = true
      openPreview()
    }

    const handlePreviewLeave = () => {
      pointerInsideRef.current = false
      scheduleClosePreview()
    }

    // Interacting *inside* the popover (pressing down on it, hitting "View
    // source") "pins" it open so it stays put while you scroll/select within
    // it, closing only on an outside click / Escape (via handleOpenChange).
    // Clicking the chip itself does NOT pin — it opens the source in the
    // sidecar and lets the preview dismiss on pointer-leave, just like hover.
    const pinPreview = () => {
      pinnedOpenRef.current = true
      clearCloseTimer()
    }

    const handleOpenChange = (nextOpen: boolean) => {
      if (!nextOpen) {
        pinnedOpenRef.current = false
        clearCloseTimer()
      }
      setOpen(nextOpen)
    }

    useEffect(() => {
      return () => {
        clearCloseTimer()
      }
    }, [])

    useEffect(() => {
      if (!open) return

      const handleScroll = (event: Event) => {
        if (pinnedOpenRef.current) return
        // Scrolling within the popover itself (e.g. a long quote) must not
        // dismiss it — only page/chat scrolls that move the anchor should.
        const target = event.target as Node | null
        if (target && contentRef.current?.contains(target)) return
        pointerInsideRef.current = false
        clearCloseTimer()
        setOpen(false)
      }

      window.addEventListener('scroll', handleScroll, true)
      return () => window.removeEventListener('scroll', handleScroll, true)
    }, [open])

    if (!citation) {
      // Unknown citation id - render a muted, disabled chip per spec fallback.
      return (
        <span
          ref={ref as React.Ref<HTMLSpanElement> as any}
          className="inline-flex items-center justify-center align-baseline mx-0.5 h-[1.25em] min-w-[1.25em] px-1 rounded-full border border-dashed border-border bg-muted/40 text-[0.7em] leading-none text-muted-foreground"
          title="Citation reference is missing or expired"
        >
          {fallbackLabel ?? '?'}
        </span>
      )
    }

    const status = effectiveStatus(citation.status, verificationMode)
    const chipClasses = statusChipClasses(status, verificationMode)

    return (
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverAnchor asChild>
          <button
            ref={setTriggerRefs}
            type="button"
            data-citation-id={citation.citation_id}
            data-citation-active={active ? 'true' : undefined}
            aria-label={`Citation ${citation.display_number}: ${citation.source.title}`}
            title={`Open citation ${citation.display_number}`}
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              // Behave like hover: keep the preview open while the pointer is
              // still on the chip, but don't pin it — moving away dismisses it.
              // The real interaction target is the sidecar opened by onView.
              pointerInsideRef.current = true
              setOpen(true)
              onView?.(citation)
            }}
            onMouseEnter={handlePreviewEnter}
            onMouseLeave={handlePreviewLeave}
            onPointerEnter={handlePreviewEnter}
            onPointerLeave={handlePreviewLeave}
            onFocus={openPreview}
            className={cn(
              'inline-flex items-center justify-center align-baseline mx-0.5 h-[1.25em] min-w-[1.25em] px-1 rounded-full border text-[0.7em] leading-none font-medium transition-colors cursor-pointer',
              chipClasses,
              active && 'ring-2 ring-primary/40 ring-offset-1 ring-offset-background',
            )}
          >
            {citation.display_number}
          </button>
        </PopoverAnchor>
        <PopoverContent
          ref={contentRef}
          className="w-80 p-0"
          align="start"
          sideOffset={6}
          onMouseEnter={handlePreviewEnter}
          onMouseLeave={handlePreviewLeave}
          onPointerEnter={handlePreviewEnter}
          onPointerLeave={handlePreviewLeave}
          onPointerDown={pinPreview}
          onFocus={openPreview}
        >
          <CitationPreviewPopover
            citation={citation}
            verificationMode={verificationMode}
            onView={() => {
              pinPreview()
              setOpen(true)
              onView?.(citation)
            }}
          />
        </PopoverContent>
      </Popover>
    )
  },
)
