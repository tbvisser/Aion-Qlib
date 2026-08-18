import { useMemo } from 'react'
import { Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Notice } from '@/components/ui/notice'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import type { KeycardDefect, KeycardNodeTypeMeta, KeycardSpec } from '@/lib/api'

interface Props {
  spec: KeycardSpec
  selectedNodeId: string | null
  metaByType: Map<string, KeycardNodeTypeMeta>
  defects: KeycardDefect[]
  onChange: (next: Partial<KeycardSpec> | ((prev: KeycardSpec) => KeycardSpec)) => void
  onChangeNode: (nodeId: string, patch: Partial<KeycardSpec['nodes'][number]>) => void
}

function getConfigSchema(meta: KeycardNodeTypeMeta | undefined) {
  return (meta?.config_schema ?? {}) as {
    type?: string
    properties?: Record<string, unknown>
    required?: string[]
  }
}

function isRequired(meta: KeycardNodeTypeMeta | undefined, key: string): boolean {
  const schema = getConfigSchema(meta)
  return schema.required?.includes(key) ?? false
}

function schemaProperty(meta: KeycardNodeTypeMeta | undefined, key: string) {
  const schema = getConfigSchema(meta)
  return (schema.properties?.[key] ?? {}) as {
    type?: string
    enum?: unknown[]
    description?: string
    minimum?: number
    maximum?: number
    items?: { type?: string; properties?: Record<string, unknown>; required?: string[] }
  }
}

export function NodeInspector({
  spec,
  selectedNodeId,
  metaByType,
  defects,
  onChange,
  onChangeNode,
}: Props) {
  const routed = useMemo(() => {
    const map = new Map<string, KeycardDefect[]>()
    for (const d of defects) {
      const match = /^nodes\[([^\]]+)\]/.exec(d.path)
      if (!match) continue
      const key = match[1]
      const list = map.get(key) ?? []
      list.push(d)
      map.set(key, list)
    }
    return map
  }, [defects])

  if (!selectedNodeId) {
    return (
      <aside className="flex h-full min-h-0 flex-col bg-card">
        <div className="border-b border-border/50 px-3 py-2 text-sm font-medium">Keycard</div>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
          <Field label="Name">
            <Input
              value={spec.name}
              onChange={(e) => onChange({ name: e.target.value })}
              placeholder="Keycard name"
            />
          </Field>
          <Field label="Description">
            <Textarea
              value={spec.description}
              onChange={(e) => onChange({ description: e.target.value })}
              placeholder="What this workflow does"
              rows={3}
            />
          </Field>
          <Field label="Tags">
            <Input
              value={spec.tags.join(', ')}
              onChange={(e) =>
                onChange({ tags: e.target.value.split(',').map((t) => t.trim()).filter(Boolean) })}
              placeholder="comma, separated, tags"
            />
          </Field>
          <Field label="Template family">
            <Input
              value={spec.template_family ?? ''}
              onChange={(e) =>
                onChange({ template_family: e.target.value.trim() || null })}
              placeholder="e.g. momentum"
            />
          </Field>
          <div className="flex items-center gap-2">
            <Switch
              id="is-template"
              checked={spec.is_template}
              onCheckedChange={(checked) => onChange({ is_template: checked })}
            />
            <Label htmlFor="is-template" className="text-xs font-normal">
              Save as template
            </Label>
          </div>
          <WindowsEditor windows={spec.windows} onChange={(w) => onChange({ windows: w })} />
        </div>
      </aside>
    )
  }

  const node = spec.nodes.find((n) => n.id === selectedNodeId)
  const meta = node ? metaByType.get(node.type) : undefined
  const nodeDefects = node ? routed.get(node.id) ?? [] : []

  if (!node) {
    return (
      <aside className="flex h-full min-h-0 flex-col bg-card p-3">
        <p className="text-sm text-muted-foreground">Selected node not found.</p>
      </aside>
    )
  }

  // Show every schema property plus any key currently in the node's config.
  const keysToRender = Array.from(new Set([
    ...Object.keys((meta?.config_schema as Record<string, unknown> | undefined)?.properties ?? {}),
    ...Object.keys(node.config),
  ]))

  return (
    <aside className="flex h-full min-h-0 flex-col bg-card">
      <div className="border-b border-border/50 px-3 py-2">
        <div className="text-sm font-medium">{meta?.label ?? node.type}</div>
        <div className="text-[10px] text-muted-foreground">{node.id}</div>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
        {nodeDefects.length > 0 && (
          <Notice tone="destructive" icon={false}>
            {nodeDefects.map((d) => (
              <p key={d.code}>{d.message}</p>
            ))}
          </Notice>
        )}

        {keysToRender.map((key) => (
          <ConfigField
            key={key}
            propKey={key}
            prop={schemaProperty(meta, key)}
            required={isRequired(meta, key)}
            value={node.config[key]}
            onChange={(value) =>
              onChangeNode(node.id, { config: { ...node.config, [key]: value } })}
          />
        ))}

        <Field label="Notes">
          <Textarea
            value={node.notes}
            onChange={(e) => onChangeNode(node.id, { notes: e.target.value })}
            placeholder="Notes for this node"
            rows={3}
          />
        </Field>
      </div>
    </aside>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  )
}

function ConfigField({
  propKey,
  prop,
  required,
  value,
  onChange,
}: {
  propKey: string
  prop: {
    type?: string
    enum?: unknown[]
    description?: string
    minimum?: number
    maximum?: number
    items?: { type?: string; properties?: Record<string, unknown>; required?: string[] }
  }
  required: boolean
  value: unknown
  onChange: (value: unknown) => void
}) {
  const label = `${propKey}${required ? ' *' : ''}`

  if (prop.enum && Array.isArray(prop.enum)) {
    return (
      <Field label={label}>
        <select
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
          className="flex h-9 w-full rounded-md border border-border/50 bg-background px-2 text-sm"
        >
          {!required && <option value="">—</option>}
          {prop.enum.map((opt) => (
            <option key={String(opt)} value={String(opt)}>
              {String(opt)}
            </option>
          ))}
        </select>
        {prop.description && <p className="text-[10px] text-muted-foreground">{prop.description}</p>}
      </Field>
    )
  }

  if (prop.type === 'boolean') {
    return (
      <div className="flex items-center gap-2">
        <Switch
          id={`config-${propKey}`}
          checked={typeof value === 'boolean' ? value : false}
          onCheckedChange={onChange}
        />
        <Label htmlFor={`config-${propKey}`} className="text-xs font-normal">
          {label}
        </Label>
      </div>
    )
  }

  if (prop.type === 'number') {
    return (
      <Field label={label}>
        <Input
          type="number"
          value={typeof value === 'number' ? value : ''}
          min={prop.minimum}
          max={prop.maximum}
          onChange={(e) => {
            const v = e.target.value === '' ? null : Number(e.target.value)
            onChange(v)
          }}
        />
        {prop.description && <p className="text-[10px] text-muted-foreground">{prop.description}</p>}
      </Field>
    )
  }

  if (prop.type === 'array' && prop.items?.type === 'object') {
    const items = Array.isArray(value) ? (value as Record<string, unknown>[]) : []
    const subProps = prop.items.properties ?? {}
    const subRequired = prop.items.required ?? []
    return (
      <Field label={label}>
        <div className="space-y-2">
          {items.map((item, i) => (
            <div key={i} className="rounded-md border border-border/50 p-2">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[10px] font-medium">Item {i + 1}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-5 w-5"
                  onClick={() => {
                    const next = items.filter((_, idx) => idx !== i)
                    onChange(next)
                  }}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
              <div className="space-y-2">
                {Object.keys(subProps).map((subKey) => (
                  <div key={subKey} className="space-y-1">
                    <Label className="text-[10px]">
                      {subKey}{subRequired.includes(subKey) ? ' *' : ''}
                    </Label>
                    <Input
                      value={typeof item[subKey] === 'string' ? item[subKey] : ''}
                      onChange={(e) => {
                        const next = [...items]
                        next[i] = { ...next[i], [subKey]: e.target.value }
                        onChange(next)
                      }}
                      className="h-7 text-xs"
                    />
                  </div>
                ))}
              </div>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full text-xs"
            onClick={() => {
              const next = [...items, {}]
              onChange(next)
            }}
          >
            Add {propKey}
          </Button>
        </div>
      </Field>
    )
  }

  return (
    <Field label={label}>
      <Input
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder={prop.description}
      />
      {prop.description && <p className="text-[10px] text-muted-foreground">{prop.description}</p>}
    </Field>
  )
}

function WindowsEditor({
  windows,
  onChange,
}: {
  windows: KeycardSpec['windows']
  onChange: (windows: KeycardSpec['windows']) => void
}) {
  const keys: (keyof KeycardSpec['windows'])[] = [
    'train_start', 'train_end', 'valid_start', 'valid_end', 'test_start', 'test_end',
  ]
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">Windows</Label>
      <div className="grid grid-cols-2 gap-2">
        {keys.map((k) => (
          <div key={k} className="space-y-1">
            <Label className="text-[10px] text-muted-foreground">{k.replace(/_/g, ' ')}</Label>
            <Input
              type="date"
              value={windows[k]}
              onChange={(e) => onChange({ ...windows, [k]: e.target.value })}
              className="h-8 text-xs"
            />
          </div>
        ))}
      </div>
    </div>
  )
}
