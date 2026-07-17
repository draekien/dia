import type { PermissionResponse } from '@main/domain/attention'
import type { PanePermissionRequested } from '@main/ipc/contract'
import { useMemo, useState } from 'react'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { Switch } from './ui/switch'
import { Textarea } from './ui/textarea'

type FieldKind = 'text' | 'number' | 'boolean' | 'json'

interface EditableField {
  readonly key: string
  readonly kind: FieldKind
}

function fieldKind(value: unknown): FieldKind {
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'number') return 'number'
  if (typeof value === 'string') return 'text'
  return 'json'
}

function editableFields(input: Record<string, unknown>): ReadonlyArray<EditableField> {
  return Object.entries(input)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => ({ key, kind: fieldKind(value) }))
}

function humanizeKey(key: string): string {
  const spaced = key
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
  return spaced.length === 0 ? spaced : spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

function toDraft(value: unknown, kind: FieldKind): string {
  return kind === 'json' ? JSON.stringify(value, null, 2) : String(value)
}

type Reconstruction =
  | { readonly ok: true; readonly value: Record<string, unknown>; readonly changed: boolean }
  | { readonly ok: false; readonly invalidKeys: ReadonlyArray<string> }

function reconstructInput(
  input: Record<string, unknown>,
  fields: ReadonlyArray<EditableField>,
  drafts: Record<string, string>,
  bools: Record<string, boolean>
): Reconstruction {
  const edits: Record<string, unknown> = {}
  const invalidKeys: string[] = []

  for (const field of fields) {
    if (field.kind === 'boolean') {
      edits[field.key] = bools[field.key] ?? false
      continue
    }
    const raw = drafts[field.key] ?? ''
    if (field.kind === 'number') {
      const parsed = Number(raw)
      if (raw.trim() === '' || Number.isNaN(parsed)) invalidKeys.push(field.key)
      else edits[field.key] = parsed
    } else if (field.kind === 'json') {
      try {
        edits[field.key] = JSON.parse(raw)
      } catch {
        invalidKeys.push(field.key)
      }
    } else {
      edits[field.key] = raw
    }
  }

  if (invalidKeys.length > 0) return { ok: false, invalidKeys }

  const changed = fields.some(
    (field) => JSON.stringify(edits[field.key]) !== JSON.stringify(input[field.key])
  )
  return { ok: true, value: { ...input, ...edits }, changed }
}

/**
 * Inline card that prompts the user to resolve a pane's pending tool-permission request.
 * Renders the tool's proposed input as an editable per-field form (top-level primitives
 * inline, nested values as JSON), an "always allow" toggle when the SDK offered suggestions,
 * and a required note when denying. Pass the pane's {@link PanePermissionRequested} as
 * `request`; `onResolve` is called once with the user's {@link PermissionResponse}. The card
 * is non-blocking, so the user may instead redirect the pane via the composer, superseding it.
 */
export function PermissionRequestCard({
  request,
  onResolve
}: {
  request: PanePermissionRequested
  onResolve: (response: PermissionResponse) => void
}) {
  const fields = useMemo(() => editableFields(request.input), [request.input])

  const [drafts, setDrafts] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {}
    for (const field of fields) {
      if (field.kind !== 'boolean')
        initial[field.key] = toDraft(request.input[field.key], field.kind)
    }
    return initial
  })
  const [bools, setBools] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {}
    for (const field of fields) {
      if (field.kind === 'boolean') initial[field.key] = request.input[field.key] === true
    }
    return initial
  })
  const [denyMessage, setDenyMessage] = useState('')
  const [remember, setRemember] = useState(false)

  const canRemember = request.suggestions !== undefined && request.suggestions.length > 0
  const reconstruction = reconstructInput(request.input, fields, drafts, bools)
  const invalidKeys = reconstruction.ok ? [] : reconstruction.invalidKeys
  const canDeny = denyMessage.trim().length > 0

  function allow(): void {
    if (!reconstruction.ok) return
    const response: PermissionResponse = {
      _tag: 'Allow',
      ...(reconstruction.changed ? { updatedInput: reconstruction.value } : {}),
      ...(remember && canRemember ? { updatedPermissions: [...request.suggestions] } : {})
    }
    onResolve(response)
  }

  function deny(): void {
    if (!canDeny) return
    onResolve({ _tag: 'Deny', message: denyMessage.trim() })
  }

  return (
    <section className="mt-2 flex flex-col gap-4 rounded-md border bg-muted/40 p-3">
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium text-foreground">Permission requested</p>
        <p className="text-xs text-muted-foreground">
          Wants to run{' '}
          <span className="rounded border bg-muted px-1.5 py-0.5 font-mono text-foreground">
            {request.toolName}
          </span>
          . Review or edit the parameters before allowing.
        </p>
      </div>

      <div className="flex max-h-64 flex-col gap-4 overflow-y-auto">
        {fields.length === 0 ? (
          <p className="text-sm text-muted-foreground">This tool takes no parameters.</p>
        ) : (
          fields.map((field) => (
            <div key={field.key} className="flex flex-col gap-1.5">
              <Label htmlFor={`field-${field.key}`} className="text-muted-foreground">
                {humanizeKey(field.key)}
              </Label>
              {field.kind === 'boolean' ? (
                <Switch
                  id={`field-${field.key}`}
                  checked={bools[field.key] ?? false}
                  onCheckedChange={(checked) =>
                    setBools((prev) => ({ ...prev, [field.key]: checked }))
                  }
                />
              ) : field.kind === 'json' ? (
                <Textarea
                  id={`field-${field.key}`}
                  aria-invalid={invalidKeys.includes(field.key)}
                  className="max-h-40 font-mono text-xs"
                  value={drafts[field.key] ?? ''}
                  onChange={(event) =>
                    setDrafts((prev) => ({ ...prev, [field.key]: event.target.value }))
                  }
                />
              ) : (
                <Input
                  id={`field-${field.key}`}
                  inputMode={field.kind === 'number' ? 'decimal' : undefined}
                  aria-invalid={invalidKeys.includes(field.key)}
                  className="font-mono text-xs"
                  value={drafts[field.key] ?? ''}
                  onChange={(event) =>
                    setDrafts((prev) => ({ ...prev, [field.key]: event.target.value }))
                  }
                />
              )}
              {invalidKeys.includes(field.key) && (
                <p className="text-xs text-destructive">
                  {field.kind === 'number' ? 'Enter a valid number.' : 'Enter valid JSON.'}
                </p>
              )}
            </div>
          ))
        )}

        {canRemember && (
          <label
            htmlFor="permission-remember"
            className="flex items-center justify-between gap-3 rounded-md border bg-background px-3 py-2"
          >
            <span className="text-sm text-foreground">
              Always allow {request.toolName} in this pane
            </span>
            <Switch id="permission-remember" checked={remember} onCheckedChange={setRemember} />
          </label>
        )}

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="permission-deny-message" className="text-muted-foreground">
            Note to Claude
          </Label>
          <Textarea
            id="permission-deny-message"
            className="max-h-32"
            placeholder="Explain what you'd prefer instead (required to deny)"
            value={denyMessage}
            onChange={(event) => setDenyMessage(event.target.value)}
          />
        </div>
      </div>

      <div className="flex justify-end gap-2">
        <Button size="sm" variant="destructive" disabled={!canDeny} onClick={deny}>
          Deny
        </Button>
        <Button size="sm" disabled={!reconstruction.ok} onClick={allow}>
          {reconstruction.ok && reconstruction.changed ? 'Allow edited' : 'Allow'}
        </Button>
      </div>
    </section>
  )
}
