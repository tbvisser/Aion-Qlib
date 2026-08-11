function MetadataValue({ fieldKey, value }: { fieldKey: string; value: unknown }) {
  if (value === null || value === undefined) return null

  if (Array.isArray(value)) {
    return (
      <div className="flex flex-wrap gap-1">
        {value.map((v, i) => (
          <span key={i} className="inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-primary/15 text-primary border border-primary/20">
            {String(v)}
          </span>
        ))}
      </div>
    )
  }

  if (typeof value === 'boolean') {
    return <span className="text-sm">{value ? 'Yes' : 'No'}</span>
  }

  if (typeof value === 'number') {
    return <span className="text-sm">{value.toLocaleString()}</span>
  }

  const strVal = String(value)
  if (strVal.length <= 30 && fieldKey === 'document_type') {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-violet-500/15 text-violet-400 border border-violet-500/20">
        {strVal}
      </span>
    )
  }

  return <span className="text-sm text-foreground">{strVal}</span>
}

export function MetadataPanel({ metadata }: { metadata: Record<string, unknown> | null }) {
  if (!metadata || Object.keys(metadata).length === 0) {
    return <p className="text-sm text-muted-foreground italic">No metadata extracted</p>
  }

  const orderedKeys = Object.keys(metadata).sort((a, b) => {
    if (a === 'title') return -1
    if (b === 'title') return 1
    if (a === 'summary') return -1
    if (b === 'summary') return 1
    return a.localeCompare(b)
  })

  return (
    <div className="space-y-4">
      {orderedKeys.map(key => (
        <div key={key} className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            {key.replace(/_/g, ' ')}
          </span>
          <MetadataValue fieldKey={key} value={metadata[key]} />
        </div>
      ))}
    </div>
  )
}
