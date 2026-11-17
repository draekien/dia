// @effect-diagnostics asyncFunction:off -- React callbacks await OrgCall's Promise; components hold no Effect runtime.
import {
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Textarea,
  thinkingLevelLabel,
  thinkingLevelsFor,
  useModelCatalog,
  useProvided
} from '@dia/renderer-plugin'
import { McpServerPickerKey } from '@dia-plugin/dia-mcp/picker'
import { SkillPickerKey } from '@dia-plugin/dia-skills/picker'
import { Result } from 'effect'
import { Loader2Icon } from 'lucide-react'
import { createElement, type FormEvent, type ReactNode, useId, useState } from 'react'
import {
  CopyJobTitle,
  CreateJobTitle,
  DeleteJobTitle,
  EditJobTitle,
  SetJobTitleEnabled
} from './calls'
import { ConfirmDialog } from './confirm-dialog'
import { agentName, type JobTitle, type JobTitleEdit, type JobTitleFields } from './domain'
import { NameDialog } from './name-dialog'
import { commonFailureText, type OrgScreen, readJobTitleName, toastFailure } from './org-actions'
import { HiredAgentsView, JobTitlesView } from './org-view'

const BYPASS_CAPTION =
  'Runs tools without asking when auto mode is unavailable. Plugin changes still ask.'

const lines = (text: string): ReadonlyArray<string> =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')

const sameLines = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
  a.join('\n') === b.join('\n')

interface Draft {
  readonly name: string
  readonly jobDescription: string
  readonly skills: string
  readonly allow: string
  readonly ask: string
  readonly deny: string
  readonly mcpServers: string
  readonly bypassOptIn: boolean
  readonly model: JobTitle['model']
  readonly thinkingLevel: JobTitle['thinkingLevel']
}

const draftOf = (jobTitle: JobTitle): Draft => ({
  name: jobTitle.name,
  jobDescription: jobTitle.jobDescription,
  skills: jobTitle.skills.join('\n'),
  allow: jobTitle.permissions.allow.join('\n'),
  ask: jobTitle.permissions.ask.join('\n'),
  deny: jobTitle.permissions.deny.join('\n'),
  mcpServers: jobTitle.mcpServers.join('\n'),
  bypassOptIn: jobTitle.bypassOptIn,
  model: jobTitle.model,
  thinkingLevel: jobTitle.thinkingLevel
})

const NEW_JOB_TITLE_DRAFT: Draft = {
  name: '',
  jobDescription: '',
  skills: '',
  allow: '',
  ask: '',
  deny: '',
  mcpServers: '',
  bypassOptIn: false,
  model: null,
  thinkingLevel: 'medium'
}

const LIST_FIELDS = ['skills', 'allow', 'ask', 'deny', 'mcpServers'] as const

const sameDraft = (a: Draft, b: Draft) =>
  a.name.trim() === b.name.trim() &&
  a.jobDescription === b.jobDescription &&
  LIST_FIELDS.every((field) => sameLines(lines(a[field]), lines(b[field]))) &&
  a.bypassOptIn === b.bypassOptIn &&
  a.model === b.model &&
  a.thinkingLevel === b.thinkingLevel

interface FormErrors {
  readonly name?: string
  readonly save?: string
}

const fieldsOf = (draft: Draft): Result.Result<JobTitleFields, Omit<FormErrors, 'save'>> => {
  const name = readJobTitleName(draft.name)
  if (Result.isFailure(name)) return Result.fail({ name: name.failure })
  return Result.succeed({
    name: name.success,
    jobDescription: draft.jobDescription,
    skills: lines(draft.skills),
    permissions: { allow: lines(draft.allow), ask: lines(draft.ask), deny: lines(draft.deny) },
    mcpServers: lines(draft.mcpServers),
    bypassOptIn: draft.bypassOptIn,
    model: draft.model,
    thinkingLevel: draft.thinkingLevel
  })
}

const editOf = (jobTitle: JobTitle, fields: JobTitleFields): JobTitleEdit => {
  const permissionsChanged =
    !sameLines(fields.permissions.allow, jobTitle.permissions.allow) ||
    !sameLines(fields.permissions.ask, jobTitle.permissions.ask) ||
    !sameLines(fields.permissions.deny, jobTitle.permissions.deny)
  return {
    ...(fields.name === jobTitle.name ? {} : { name: fields.name }),
    ...(fields.jobDescription === jobTitle.jobDescription
      ? {}
      : { jobDescription: fields.jobDescription }),
    ...(sameLines(fields.skills, jobTitle.skills) ? {} : { skills: fields.skills }),
    ...(permissionsChanged ? { permissions: fields.permissions } : {}),
    ...(sameLines(fields.mcpServers, jobTitle.mcpServers) ? {} : { mcpServers: fields.mcpServers }),
    ...(fields.bypassOptIn === jobTitle.bypassOptIn ? {} : { bypassOptIn: fields.bypassOptIn }),
    ...(fields.model === jobTitle.model ? {} : { model: fields.model }),
    ...(fields.thinkingLevel === jobTitle.thinkingLevel
      ? {}
      : { thinkingLevel: fields.thinkingLevel })
  }
}

const nameTakenText = (jobTitleName: string) => `A job title named "${jobTitleName}" already exists`

function Field({
  label,
  caption,
  error,
  children
}: {
  readonly label: ReactNode
  readonly caption?: string
  readonly error?: string
  readonly children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      {label}
      {children}
      {caption === undefined ? null : <p className="text-xs text-ink-muted">{caption}</p>}
      {error === undefined ? null : <p className="text-xs text-error">{error}</p>}
    </div>
  )
}

function ModelFields({
  id,
  model,
  thinkingLevel,
  onModelChange,
  onThinkingLevelChange
}: {
  readonly id: string
  readonly model: JobTitle['model']
  readonly thinkingLevel: JobTitle['thinkingLevel']
  readonly onModelChange: (model: JobTitle['model']) => void
  readonly onThinkingLevelChange: (level: JobTitle['thinkingLevel']) => void
}) {
  const { state } = useModelCatalog()
  const models = state?._tag === 'Ready' ? state.models : []
  const option = model === null ? models[0] : models.find((candidate) => candidate.value === model)
  const offered = thinkingLevelsFor(option)
  const levels = offered.includes(thinkingLevel) ? offered : [thinkingLevel, ...offered]
  const modelName = (value: string | null) =>
    value === null
      ? `Default${models[0] === undefined ? '' : ` (${models[0].displayName})`}`
      : (models.find((candidate) => candidate.value === value)?.displayName ?? value)

  return (
    <div className="grid gap-4 @2xl:grid-cols-2 @3xl:grid-cols-1 @5xl:grid-cols-2">
      <Field
        label={<Label id={`${id}-model-label`}>Model</Label>}
        caption="Default follows the first model Claude Code lists."
      >
        <Select<string | null> value={model} onValueChange={(next) => onModelChange(next)}>
          <SelectTrigger aria-labelledby={`${id}-model-label`}>
            <SelectValue>{modelName(model)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value={null}>{modelName(null)}</SelectItem>
              {model !== null && !models.some((candidate) => candidate.value === model) ? (
                <SelectItem value={model} className="font-mono">
                  {model}
                </SelectItem>
              ) : null}
              {models.map((candidate) => (
                <SelectItem key={candidate.value} value={candidate.value}>
                  {candidate.displayName}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
      <Field label={<Label id={`${id}-thinking-label`}>Thinking</Label>}>
        <Select
          value={thinkingLevel}
          onValueChange={(next) => {
            if (next !== null) onThinkingLevelChange(next)
          }}
        >
          <SelectTrigger aria-labelledby={`${id}-thinking-label`}>
            <SelectValue>{thinkingLevelLabel(thinkingLevel)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {levels.map((level) => (
                <SelectItem key={level} value={level}>
                  {thinkingLevelLabel(level)}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
    </div>
  )
}

function JobTitleForm({
  initial,
  nameEditable,
  onSave,
  onCancel,
  snapshot
}: Pick<OrgScreen, 'snapshot'> & {
  readonly initial: Draft
  readonly nameEditable: boolean
  readonly onSave: (fields: JobTitleFields) => Promise<FormErrors>
  readonly onCancel?: () => void
}) {
  const [draft, setDraft] = useState(initial)
  const [errors, setErrors] = useState<FormErrors>({})
  const [busy, setBusy] = useState(false)
  const id = useId()
  const McpServerPicker = useProvided(McpServerPickerKey)
  const SkillPicker = useProvided(SkillPickerKey)
  const changed = !sameDraft(draft, initial)
  const set = (field: keyof Draft) => (value: string | boolean | null) => {
    setDraft((current) => ({ ...current, [field]: value }))
    setErrors({})
  }

  const save = async (event: FormEvent) => {
    event.preventDefault()
    const fields = fieldsOf(draft)
    if (Result.isFailure(fields)) return setErrors(fields.failure)
    setBusy(true)
    setErrors(await onSave(fields.success).finally(() => setBusy(false)))
  }

  const textarea = (
    field: Exclude<keyof Draft, 'bypassOptIn' | 'model' | 'thinkingLevel'>,
    label: string,
    mono: boolean,
    caption?: string,
    error?: string
  ) => (
    <Field
      label={<Label htmlFor={`${id}-${field}`}>{label}</Label>}
      caption={caption}
      error={error}
    >
      <Textarea
        id={`${id}-${field}`}
        value={draft[field]}
        spellCheck={!mono}
        aria-invalid={error !== undefined}
        onChange={(event) => set(field)(event.target.value)}
        className={mono ? 'min-h-16 font-mono text-xs md:text-xs' : 'min-h-28'}
      />
    </Field>
  )

  return (
    <form className="flex flex-col gap-5" onSubmit={(event) => void save(event)}>
      {nameEditable ? (
        <Field label={<Label htmlFor={`${id}-name`}>Name</Label>} error={errors.name}>
          <Input
            id={`${id}-name`}
            value={draft.name}
            autoComplete="off"
            aria-invalid={errors.name !== undefined}
            onChange={(event) => set('name')(event.target.value)}
          />
        </Field>
      ) : errors.name === undefined ? null : (
        <p className="text-xs text-error">{errors.name}</p>
      )}
      {textarea(
        'jobDescription',
        'Job description',
        false,
        "Added to the system prompt of this job title's sessions."
      )}
      {SkillPicker === undefined ? (
        textarea('skills', 'Skills', true, 'One skill name per line. None means every skill.')
      ) : (
        <Field label={<Label>Skills</Label>}>
          {createElement(SkillPicker, {
            label: 'Skills',
            value: lines(draft.skills),
            onChange: (next) => set('skills')(next.join('\n'))
          })}
        </Field>
      )}
      <ModelFields
        id={id}
        model={draft.model}
        thinkingLevel={draft.thinkingLevel}
        onModelChange={set('model')}
        onThinkingLevelChange={set('thinkingLevel')}
      />
      <div className="grid gap-4 @2xl:grid-cols-3 @3xl:grid-cols-1 @5xl:grid-cols-3">
        {textarea('allow', 'Allow', true)}
        {textarea('ask', 'Ask', true)}
        {textarea('deny', 'Deny', true)}
      </div>
      {McpServerPicker === undefined ? (
        textarea('mcpServers', 'MCP servers', true, 'One MCP server name per line.')
      ) : (
        <Field label={<Label>MCP servers</Label>}>
          {createElement(McpServerPicker, {
            label: 'MCP servers',
            value: lines(draft.mcpServers),
            onChange: (next) => set('mcpServers')(next.join('\n'))
          })}
        </Field>
      )}
      {snapshot.bypassAvailable ? (
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${id}-bypass`}>Bypass approvals</Label>
            <p className="text-xs text-ink-muted">{BYPASS_CAPTION}</p>
          </div>
          <Switch
            id={`${id}-bypass`}
            checked={draft.bypassOptIn}
            onCheckedChange={(checked) => set('bypassOptIn')(checked)}
          />
        </div>
      ) : null}
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={busy || !changed}>
          {busy ? (
            <Loader2Icon data-icon="inline-start" className="motion-safe:animate-spin" />
          ) : null}
          Save
        </Button>
        {onCancel === undefined ? null : (
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        )}
        {errors.save === undefined ? null : (
          <p role="alert" className="text-xs text-error">
            {errors.save}
          </p>
        )}
      </div>
    </form>
  )
}

type Dialog = 'copy' | 'delete' | undefined

const plural = (count: number) => (count === 1 ? 'its hired agent' : `its ${count} hired agents`)

/**
 * The selected job title on the Job titles page: its name, `Built in` caption and enabled switch,
 * `Copy…`, `Hire…` and, on a copy, `Delete…`; the edit form, whose `Save` sends the fields that
 * changed; and the names of its hired agents, each of which shows that agent on Hired agents.
 */
export function JobTitleEditor({
  jobTitle,
  snapshot,
  call,
  show,
  openHire
}: OrgScreen & { readonly jobTitle: JobTitle }) {
  const [dialog, setDialog] = useState<Dialog>(undefined)
  const hires = snapshot.hiredAgents.filter((agent) => agent.jobTitleId === jobTitle.id)

  const setEnabled = async (enabled: boolean) => {
    const result = await call(SetJobTitleEnabled, { jobTitleId: jobTitle.id, enabled }, jobTitle.id)
    if (Result.isFailure(result)) {
      toastFailure(`Could not ${enabled ? 'enable' : 'disable'} ${jobTitle.name}`, result.failure)
    }
  }

  const copy = async (text: string): Promise<string | undefined> => {
    const name = readJobTitleName(text)
    if (Result.isFailure(name)) return name.failure
    const result = await call(
      CopyJobTitle,
      { jobTitleId: jobTitle.id, name: name.success },
      jobTitle.id
    )
    if (Result.isSuccess(result)) {
      show(JobTitlesView.make({ jobTitleId: result.success.id }))
      return undefined
    }
    const failure = result.failure
    return failure._tag === 'JobTitleNameTaken'
      ? nameTakenText(failure.jobTitleName)
      : commonFailureText(failure)
  }

  const remove = async (): Promise<string | undefined> => {
    const result = await call(DeleteJobTitle, { jobTitleId: jobTitle.id }, jobTitle.id)
    if (Result.isSuccess(result)) return undefined
    const failure = result.failure
    switch (failure._tag) {
      case 'JobTitleNotFound':
        return undefined
      case 'JobTitleHasHires':
        return `Dismiss ${plural(failure.hires)} first`
      case 'BuiltInJobTitleDeleted':
        return 'A built-in job title can only be disabled'
      default:
        return commonFailureText(failure)
    }
  }

  const saveEdit = async (fields: JobTitleFields): Promise<FormErrors> => {
    const result = await call(
      EditJobTitle,
      { jobTitleId: jobTitle.id, edit: editOf(jobTitle, fields) },
      jobTitle.id
    )
    if (Result.isSuccess(result)) return {}
    const failure = result.failure
    switch (failure._tag) {
      case 'JobTitleNameTaken':
        return { name: nameTakenText(failure.jobTitleName) }
      case 'BuiltInJobTitleRenamed':
        return { name: 'A built-in job title keeps its name' }
      default:
        return { save: commonFailureText(failure) }
    }
  }

  const editKey = JSON.stringify({ ...jobTitle, enabled: undefined })
  const hireable = jobTitle.builtIn !== 'executive-assistant'

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h3 className="text-base font-semibold text-ink">{jobTitle.name}</h3>
        {jobTitle.builtIn === null ? null : (
          <span className="text-xs text-ink-muted">Built in</span>
        )}
        <span className="flex items-center gap-2 text-xs text-ink-muted">
          <span aria-hidden="true">Enabled</span>
          <Switch
            checked={jobTitle.enabled}
            aria-label="Enabled"
            onCheckedChange={(enabled) => void setEnabled(enabled)}
          />
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setDialog('copy')}>
            Copy…
          </Button>
          {hireable ? (
            <Button
              size="sm"
              variant="outline"
              disabled={!jobTitle.enabled}
              onClick={() => openHire(jobTitle.id)}
            >
              Hire…
            </Button>
          ) : null}
          {jobTitle.builtIn === null ? (
            <Button size="sm" variant="outline" onClick={() => setDialog('delete')}>
              Delete…
            </Button>
          ) : null}
        </div>
      </div>
      <JobTitleForm
        key={editKey}
        initial={draftOf(jobTitle)}
        nameEditable={jobTitle.builtIn === null}
        onSave={saveEdit}
        snapshot={snapshot}
      />
      {hireable ? (
        <section className="flex flex-col gap-2 border-t pt-5" aria-labelledby="org-hired-as">
          <h4 id="org-hired-as" className="text-sm font-medium text-ink">
            {`Hired as ${jobTitle.name}`}
          </h4>
          {hires.length === 0 ? (
            <p className="text-sm text-ink-muted">No agent is hired as {jobTitle.name}.</p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {hires.map((agent) => (
                <li key={agent.id}>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => show(HiredAgentsView.make({ hireId: agent.id }))}
                  >
                    {agentName(agent, snapshot.jobTitles)}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
      {dialog === 'copy' ? (
        <NameDialog
          title={`Copy ${jobTitle.name}`}
          initial=""
          placeholder="Name of the copy"
          submitLabel="Copy"
          onSubmit={copy}
          onClose={() => setDialog(undefined)}
        />
      ) : null}
      {dialog === 'delete' ? (
        <ConfirmDialog
          title={`Delete ${jobTitle.name}?`}
          description="dia deletes this job title and its job description, skills, permissions and MCP servers."
          confirmLabel="Delete"
          onConfirm={remove}
          onClose={() => setDialog(undefined)}
        />
      ) : null}
    </div>
  )
}

/**
 * The empty job title editor the Job titles page shows after "New job title": a `New job title`
 * heading and the job title form with the default fields. `Save` creates the job title, shows it
 * and then calls `onClose`; `Cancel` calls `onClose`.
 */
export function NewJobTitleEditor({
  snapshot,
  call,
  show,
  onClose
}: Pick<OrgScreen, 'snapshot' | 'call' | 'show'> & { readonly onClose: () => void }) {
  const create = async (fields: JobTitleFields): Promise<FormErrors> => {
    const result = await call(CreateJobTitle, fields, fields.name)
    if (Result.isSuccess(result)) {
      show(JobTitlesView.make({ jobTitleId: result.success.id }))
      onClose()
      return {}
    }
    const failure = result.failure
    return failure._tag === 'JobTitleNameTaken'
      ? { name: nameTakenText(failure.jobTitleName) }
      : { save: commonFailureText(failure) }
  }

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <h3 className="text-base font-semibold text-ink">New job title</h3>
      <JobTitleForm
        initial={NEW_JOB_TITLE_DRAFT}
        nameEditable
        onSave={create}
        onCancel={onClose}
        snapshot={snapshot}
      />
    </div>
  )
}
