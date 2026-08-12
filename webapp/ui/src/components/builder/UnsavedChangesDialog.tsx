/**
 * "You have unsaved edits" — with three answers, not two.
 *
 * An `AlertDialog` rather than the two-click inline confirm the rail uses for
 * deleting a saved strategy, because the right answer here is usually the
 * *third* one — save, then carry on — and a button that toggles into "sure?"
 * cannot offer it. It also needs to open from a place with no trigger element.
 */
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import type { PendingAction } from '@/hooks/useUnsavedGuard'

export function UnsavedChangesDialog({
  pending, changed, onCancel, onDiscard, onSave, saving,
}: {
  pending: PendingAction | null
  /** The field names that differ, for the reader to recognise their own edit. */
  changed: string[]
  onCancel: () => void
  onDiscard: () => void
  /** Save, then run the pending action. Omitted hides the third button. */
  onSave?: () => void
  saving?: boolean
}) {
  return (
    <AlertDialog open={pending !== null} onOpenChange={(open) => { if (!open) onCancel() }}>
      <AlertDialogContent data-testid="unsaved-changes-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Discard changes and {pending?.label}?</AlertDialogTitle>
          <AlertDialogDescription>
            {changed.length > 0
              ? `Unsaved edits to ${changed.slice(0, 4).join(', ')}${changed.length > 4 ? `, and ${changed.length - 4} more` : ''}.`
              : 'This strategy has unsaved edits.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep editing</AlertDialogCancel>
          <Button variant="outline" onClick={onDiscard} disabled={saving}>
            Discard changes
          </Button>
          {onSave && (
            <AlertDialogAction onClick={(e) => { e.preventDefault(); onSave() }} disabled={saving}>
              {saving ? 'Saving…' : 'Save and continue'}
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
