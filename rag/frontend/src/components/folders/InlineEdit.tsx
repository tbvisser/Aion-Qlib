import { useEffect, useRef, useState } from 'react'
import { Input } from '@/components/ui/input'

interface InlineEditProps {
  value: string
  onSave: (value: string) => void
  onCancel: () => void
  error?: string | null
}

export function InlineEdit({ value, onSave, onCancel, error }: InlineEditProps) {
  const [editValue, setEditValue] = useState(value)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    // Small delay to ensure the element is visible (e.g., after collapsible animation)
    const timeoutId = setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 50)
    return () => clearTimeout(timeoutId)
  }, [])

  const handleSave = () => {
    const trimmed = editValue.trim()
    if (trimmed && trimmed !== value) {
      onSave(trimmed)
    } else {
      onCancel()
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleSave()
    } else if (e.key === 'Escape') {
      onCancel()
    }
  }

  return (
    <div className="flex-1 min-w-0">
      <Input
        ref={inputRef}
        value={editValue}
        onChange={(e) => setEditValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={handleSave}
        className={`h-6 py-0 text-sm ${error ? 'border-destructive' : ''}`}
        onClick={(e) => e.stopPropagation()}
      />
      {error && (
        <p className="text-xs text-destructive mt-0.5 truncate" title={error}>
          {error}
        </p>
      )}
    </div>
  )
}
