import { FilePlus } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface EmptyFolderStateProps {
  /** Opens the upload flow. When omitted, the action button is hidden. */
  onAddFiles?: () => void
}

/**
 * Upload prompt shown whenever the current view (a folder or the Knowledgebase
 * root) contains no documents. Subfolders may still be listed above it — this
 * covers both the fully-empty case and the "folders but no loose files" case,
 * since documents can be added at any level. Mirrors the familiar Google Drive
 * "drop zone": a stacked-paper illustration, a drop hint, and a direct upload
 * action. The whole Documents page is already a drag-and-drop target, so the
 * copy nudges users toward dropping files anywhere.
 */
export function EmptyFolderState({ onAddFiles }: EmptyFolderStateProps) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center animate-fade-in">
      <EmptyFolderArt />
      <h2 className="mt-6 text-lg font-medium text-foreground">Drop files here</h2>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        Drag and drop files anywhere on this page, or add them with the button below.
      </p>
      {onAddFiles && (
        <Button onClick={onAddFiles} className="mt-5">
          <FilePlus className="mr-2 h-4 w-4" />
          Add Files
        </Button>
      )}
    </div>
  )
}

/**
 * Decorative stacked-document illustration with playful accent shapes. Purely
 * presentational — the paper cards adapt to the theme while the accent shapes
 * use fixed brand-ish colors that read on both light and dark backgrounds.
 */
function EmptyFolderArt() {
  return (
    <div className="relative h-32 w-40 select-none" aria-hidden="true">
      {/* Accent shapes peeking from behind the stack */}
      {/* Emerald triangle (top-left) */}
      <span
        className="absolute left-1 top-5 -rotate-[18deg]"
        style={{
          width: 0,
          height: 0,
          borderLeft: '9px solid transparent',
          borderRight: '9px solid transparent',
          borderBottom: '15px solid rgb(16 185 129)',
        }}
      />
      {/* Amber rounded square (top-right) */}
      <span className="absolute right-2 top-1 h-4 w-4 rotate-12 rounded-[4px] bg-amber-400" />
      {/* Rose diamond (bottom-right) */}
      <span className="absolute bottom-3 right-3 h-4 w-4 rotate-45 rounded-[3px] bg-rose-300" />

      {/* Stacked paper cards */}
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="absolute h-24 w-[72px] rotate-[10deg] rounded-lg border border-border bg-muted shadow-sm" />
        <div className="absolute h-24 w-[72px] -rotate-[7deg] rounded-lg border border-border bg-card shadow-sm" />
        <div className="absolute flex h-24 w-[72px] flex-col gap-1.5 rounded-lg border border-border bg-card p-2.5 shadow-md">
          <div className="h-1.5 w-9/12 rounded-full bg-muted-foreground/30" />
          <div className="h-1.5 w-11/12 rounded-full bg-muted-foreground/20" />
          <div className="h-1.5 w-10/12 rounded-full bg-muted-foreground/20" />
          <div className="h-1.5 w-11/12 rounded-full bg-muted-foreground/20" />
          <div className="mt-auto h-1.5 w-6/12 rounded-full bg-muted-foreground/20" />
        </div>
      </div>
    </div>
  )
}
