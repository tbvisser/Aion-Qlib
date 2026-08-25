import { useEffect, useState } from 'react'
import { X } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { MicroLabel } from '@/components/ui/micro-label'
import { Notice } from '@/components/ui/notice'
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table'
import { SourceBadge } from '@/components/database/CatalogBrowser'
import { api, type RegistryEntity } from '@/lib/api'

/**
 * One swarm, agent, skill or tool, opened from the table.
 *
 * The Database's `AlphaDetail` twin, sharing its markup and its class strings so
 * the two pages read as one app — but not its content, because an alpha has an
 * expression to measure and none of these do.
 *
 * The section this file exists for is `Missing`. Three of the four collections
 * carry less than their source actually holds, and each gap has a specific
 * cause that a reader would otherwise spend an afternoon rediscovering: a swarm
 * has 4 member agents with roles and prompts that v0.1.13 stopped serving, a
 * Vibe skill has a body and a category the sidecar projects away, a playbook is
 * listed but cannot be scheduled from here. The rail names each one.
 */
export function RosterDetail({ uid, onClose }: { uid: string; onClose: () => void }) {
  const [entity, setEntity] = useState<RegistryEntity | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setEntity(null)
    setError(null)
    api.registryEntity(uid)
      .then((r) => { if (!cancelled) setEntity(r) })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load')
      })
    return () => { cancelled = true }
  }, [uid])

  if (error) {
    return (
      <aside className="w-[420px] shrink-0 overflow-y-auto border-l border-border/50 p-4">
        <Notice tone="destructive">{error}</Notice>
      </aside>
    )
  }

  if (!entity) {
    return (
      <aside className="w-[420px] shrink-0 border-l border-border/50 p-4 text-caption text-muted-foreground">
        Loading…
      </aside>
    )
  }

  const payload = entity.payload as Record<string, unknown>
  const description = str(payload.description)

  return (
    <aside className="flex w-[420px] shrink-0 flex-col overflow-y-auto border-l border-border/50">
      <div className="flex items-start justify-between gap-2 border-b border-border/50 p-4">
        <div className="min-w-0">
          <div className="truncate font-mono text-sm">{entity.title || entity.name}</div>
          <div className="mt-1 flex flex-wrap items-center gap-1">
            <SourceBadge source={entity.source} />
            {entity.family && (
              <Badge variant="outline" className="font-normal">{entity.family}</Badge>
            )}
            {entity.tags.slice(0, 4).map((tag) => (
              <Badge key={tag} className="font-normal">{tag}</Badge>
            ))}
          </div>
        </div>
        <Button variant="ghost" size="sm" className="h-6 w-6 shrink-0 p-0" onClick={onClose}>
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="space-y-4 p-4">
        {description && <p className="text-caption text-muted-foreground">{description}</p>}

        {entity.kind === 'swarm' && <SwarmBody payload={payload} />}
        {entity.kind === 'agent' && <AgentBody payload={payload} />}
        {entity.kind === 'skill' && <SkillBody payload={payload} />}
        {entity.kind === 'tool' && <ToolBody payload={payload} />}

        <Missing kind={entity.kind} payload={payload} />
      </div>
    </aside>
  )
}

// --- shared idioms --------------------------------------------------------

function Label({ children }: { children: React.ReactNode }) {
  return (
    <MicroLabel as="div">
      {children}
    </MicroLabel>
  )
}

function Pairs({ rows }: { rows: [string, React.ReactNode][] }) {
  const present = rows.filter(([, value]) => value !== null && value !== undefined && value !== '')
  if (!present.length) return null
  return (
    <dl className="grid grid-cols-2 gap-2 text-label">
      {present.map(([label, value]) => (
        <div key={label}>
          <MicroLabel as="dt">
            {label}
          </MicroLabel>
          <dd className="font-mono">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

function TagList({ label, values }: { label: string; values: string[] }) {
  if (!values.length) return null
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      <div className="flex flex-wrap gap-1">
        {values.map((value) => (
          <Badge key={value} variant="outline" className="font-normal">{value}</Badge>
        ))}
      </div>
    </div>
  )
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null)
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : [])

// --- per-kind bodies ------------------------------------------------------

function SwarmBody({ payload }: { payload: Record<string, unknown> }) {
  const variables = Array.isArray(payload.variables) ? payload.variables : []
  return (
    <>
      <Pairs rows={[['Agents', num(payload.agent_count)], ['Preset', str(payload.preset_source)]]} />
      {variables.length > 0 && (
        <div className="space-y-1">
          <Label>Takes</Label>
          {variables.map((raw) => {
            const variable = raw as { name?: string; description?: string; required?: boolean }
            return (
              <div key={variable.name} className="text-label">
                <span className="font-mono">{variable.name}</span>
                {variable.required === false && (
                  <span className="ml-1 text-muted-foreground/60">optional</span>
                )}
                {variable.description && (
                  <div className="text-muted-foreground">{variable.description}</div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}

function AgentBody({ payload }: { payload: Record<string, unknown> }) {
  const tools = list(payload.tools)
  const capabilities = list(payload.data_capabilities)
  const scope = str(payload.tool_scope)
  const prompt = str(payload.system_prompt)

  return (
    <>
      <Pairs rows={[
        ['Model', str(payload.model)],
        ['Phases', num(payload.phase_count)],
        ['Schedule', str(payload.suggested_schedule)],
        ['Timezone', str(payload.suggested_timezone)],
        ['Max rounds', num(payload.max_rounds)],
      ]} />
      {str(payload.availability) && (
        <p className="text-label text-muted-foreground">{payload.availability as string}</p>
      )}
      <TagList label="Tools" values={tools} />
      {scope && (
        <div className="space-y-1">
          <Label>Tool scope</Label>
          <p className="text-label text-muted-foreground">{scope}</p>
        </div>
      )}
      {capabilities.length > 0 && (
        <div className="space-y-1">
          <Label>Reads</Label>
          <ul className="space-y-0.5 text-label text-muted-foreground">
            {capabilities.map((line) => <li key={line}>· {line}</li>)}
          </ul>
        </div>
      )}
      {prompt && <Collapsible label="System prompt" body={prompt} />}
    </>
  )
}

function SkillBody({ payload }: { payload: Record<string, unknown> }) {
  const body = str(payload.body)
  return (
    <>
      <Pairs rows={[['Scope', str(payload.scope)], ['Path', str(payload.path)]]} />
      {str(payload.loaded_by) && (
        <p className="text-label text-muted-foreground">
          Loaded on demand by the <span className="font-mono">{payload.loaded_by as string}</span>{' '}
          tool — it is not in the assistant's prompt until it is needed.
        </p>
      )}
      {body && <Collapsible label="Instructions" body={body} />}
    </>
  )
}

function ToolBody({ payload }: { payload: Record<string, unknown> }) {
  const schema = payload.input_schema as { properties?: Record<string, unknown>; required?: string[] } | undefined
  const properties = schema?.properties ?? {}
  const required = new Set(schema?.required ?? [])
  const names = Object.keys(properties)
  const profiles = list(payload.profiles)

  return (
    <>
      <Pairs rows={[
        ['Transport', str(payload.transport)],
        ['Loading', str(payload.loading)],
      ]} />
      {profiles.length > 0 && <TagList label="In profiles" values={profiles} />}
      {names.length > 0 && (
        <div className="space-y-1">
          <Label>Parameters</Label>
          <Table>
            <TableBody>
              {names.map((name) => {
                const spec = properties[name] as { type?: string; description?: string }
                return (
                  <TableRow key={name}>
                    <TableCell className="py-1 pr-2 align-top">
                      <span className="font-mono text-label">{name}</span>
                      {required.has(name) && (
                        <span className="ml-1 font-mono text-tiny uppercase text-clay">req</span>
                      )}
                    </TableCell>
                    <TableCell className="py-1 align-top text-label text-muted-foreground">
                      {spec?.type && <span className="font-mono">{spec.type}</span>}
                      {spec?.description && <div>{spec.description}</div>}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}
      {names.length === 0 && (
        <p className="text-label text-muted-foreground">Takes no parameters.</p>
      )}
    </>
  )
}

function Collapsible({ label, body }: { label: string; body: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="font-mono text-micro uppercase tracking-wider text-muted-foreground/70 hover:text-foreground"
      >
        {open ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
      </button>
      {open && (
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded border border-border/50 p-2 font-mono text-micro leading-relaxed">
          {body}
        </pre>
      )}
    </div>
  )
}

/**
 * What this row does not carry, and why.
 *
 * Every line here is a question someone would otherwise answer by reading
 * upstream source and reaching the wrong conclusion — the swarm member route in
 * particular exists in the version on GitHub and not in the one deployed.
 */
function Missing({ kind, payload }: { kind: string; payload: Record<string, unknown> }) {
  const notes: string[] = []

  if (kind === 'swarm' && payload.members_available === false) {
    notes.push(
      "The member agents' roles, prompts and task graph are not served by the sidecar's API "
      + 'on the deployed version, so this team is listed but cannot be opened up. They live '
      + 'inside the sidecar itself.',
    )
  }
  if (kind === 'skill' && payload.body_available === false) {
    notes.push(
      'The sidecar serves each skill as a name and a description only — no body and no '
      + 'category — so this is everything there is to show.',
    )
  }
  if (payload.runnable_here === false) {
    notes.push(
      'Listed, not runnable from here: scheduling one is a write, and this app reaches the '
      + 'sidecar over a read-only proxy.',
    )
  }
  if (kind === 'agent' && payload.phases_available === false) {
    notes.push(
      'Phase names and descriptions only leave the RAG backend attached to a concrete run, '
      + 'so the count is all a listing can carry.',
    )
  }
  if (typeof payload.catalogue_withheld === 'number' && payload.catalogue_withheld > 0) {
    notes.push(
      `This is one of ${payload.catalogue_total} tools the sidecar exposes; `
      + `${payload.catalogue_withheld} are withheld by the proxy — file, shell and `
      + 'order-shaped paths this app may not call.',
    )
  }

  if (!notes.length) return null

  return (
    <div className="space-y-2 border-t border-border/50 pt-4">
      <Label>Not shown here</Label>
      {notes.map((note) => (
        <p key={note} className="text-label text-muted-foreground">{note}</p>
      ))}
    </div>
  )
}
