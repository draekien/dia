// @effect-diagnostics asyncFunction:off -- React callbacks await OrgCall's Promise; components hold no Effect runtime.
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
  ToggleGroup,
  ToggleGroupItem
} from '@dia/renderer-plugin'
import { Option, Result } from 'effect'
import { Loader2Icon, MinusIcon, PlusIcon } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { type OrgSnapshot, StaffTeam } from './calls'
import { type HiredAgent, type JobTitle, type JobTitleId, jobSummary, TeamPlan } from './domain'
import { commonFailureText, hireFailureText, type OrgCall } from './org-actions'
import { planOf, TEAM_PRESETS, type TeamPreset } from './team-presets'

const MAX_PER_JOB_TITLE = 10
const NO_LEAD = 'none'

type Counts = Readonly<Record<string, number>>

const countsOf = (members: ReadonlyArray<JobTitleId>): Counts =>
  members.reduce<Record<string, number>>((counts, id) => {
    counts[id] = (counts[id] ?? 0) + 1
    return counts
  }, {})

interface Draft {
  readonly preset: string | null
  readonly lead: JobTitleId | null
  readonly counts: Counts
}

const draftOf = (preset: TeamPreset, plan: TeamPlan): Draft => ({
  preset: preset.id,
  lead: plan.lead,
  counts: countsOf(plan.members)
})

function MemberRow({
  jobTitle,
  count,
  onChange
}: {
  readonly jobTitle: JobTitle
  readonly count: number
  readonly onChange: (count: number) => void
}) {
  const summary = jobSummary(jobTitle)
  return (
    <li className="flex items-center gap-3 py-2">
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm text-ink">{jobTitle.name}</span>
        {summary === '' ? null : <span className="truncate text-xs text-ink-muted">{summary}</span>}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          type="button"
          size="icon-xs"
          variant="outline"
          aria-label={`Fewer ${jobTitle.name}`}
          disabled={count === 0}
          onClick={() => onChange(count - 1)}
        >
          <MinusIcon />
        </Button>
        <output
          aria-label={`${jobTitle.name} count`}
          className="w-6 text-center text-sm tabular-nums text-ink"
        >
          {count}
        </output>
        <Button
          type="button"
          size="icon-xs"
          variant="outline"
          aria-label={`More ${jobTitle.name}`}
          disabled={count === MAX_PER_JOB_TITLE}
          onClick={() => onChange(count + 1)}
        >
          <PlusIcon />
        </Button>
      </div>
    </li>
  )
}

const hireLabel = (hires: number): string =>
  hires === 0 ? 'Hire' : hires === 1 ? 'Hire 1 agent' : `Hire ${hires} agents`

/**
 * The Staff the org dialog: a preset, a `Lead` job title or `None`, a member count per enabled job
 * title other than the Executive assistant, and `Hire N agents`, which sends `StaffTeam`. The lead
 * reports to the user and the members to the lead, or to the user with no lead. It offers only the
 * presets whose job titles are all enabled and starts on the first. On success `onStaffed` gets the
 * hires once `snapshot` has been re-read; a failure shows above the buttons and hires nobody.
 */
export function StaffDialog({
  snapshot,
  call,
  onStaffed,
  onClose
}: {
  readonly snapshot: OrgSnapshot
  readonly call: OrgCall
  readonly onStaffed: (hires: ReadonlyArray<HiredAgent>) => void
  readonly onClose: () => void
}) {
  const presets = TEAM_PRESETS.flatMap((preset) =>
    Option.match(planOf(preset, snapshot.jobTitles), {
      onNone: () => [],
      onSome: (plan) => [{ preset, plan }]
    })
  )
  const hireable = snapshot.jobTitles.filter(
    (jobTitle) => jobTitle.enabled && jobTitle.builtIn !== 'executive-assistant'
  )
  const [draft, setDraft] = useState<Draft>(() => {
    const [first] = presets
    return first === undefined
      ? { preset: null, lead: null, counts: {} }
      : draftOf(first.preset, first.plan)
  })
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const members = hireable.flatMap((jobTitle) =>
    Array.from({ length: draft.counts[jobTitle.id] ?? 0 }, () => jobTitle.id)
  )
  const hires = members.length + (draft.lead === null ? 0 : 1)
  const leadTitle = hireable.find((jobTitle) => jobTitle.id === draft.lead)

  const edit = (next: Omit<Draft, 'preset'>) => {
    setDraft({ ...next, preset: null })
    setError(undefined)
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (hires === 0) return
    setBusy(true)
    const plan = TeamPlan.make({ lead: draft.lead, members })
    const result = await call(StaffTeam, { plan }, `${hires} hires`).finally(() => setBusy(false))
    if (Result.isSuccess(result)) return onStaffed(result.success)
    setError(hireFailureText(result.failure) ?? commonFailureText(result.failure))
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Staff the org</DialogTitle>
          <DialogDescription>
            Hire a team in one step. The members report to the lead, and the lead reports to you.
            Name agents later under Hired agents.
          </DialogDescription>
        </DialogHeader>
        <form className="flex min-w-0 flex-col gap-4" onSubmit={(event) => void submit(event)}>
          {presets.length === 0 ? null : (
            <div className="flex flex-col gap-1.5">
              <Label>Start from</Label>
              <ToggleGroup
                value={draft.preset === null ? [] : [draft.preset]}
                onValueChange={([value]) => {
                  const chosen = presets.find((entry) => entry.preset.id === value)
                  if (chosen === undefined) return
                  setDraft(draftOf(chosen.preset, chosen.plan))
                  setError(undefined)
                }}
                variant="outline"
                size="sm"
                aria-label="Team preset"
              >
                {presets.map(({ preset }) => (
                  <ToggleGroupItem key={preset.id} value={preset.id}>
                    {preset.label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <Label>Lead</Label>
            <Select
              value={draft.lead ?? NO_LEAD}
              onValueChange={(value) =>
                edit({
                  lead: value === NO_LEAD || value === null ? null : (value as JobTitleId),
                  counts: draft.counts
                })
              }
            >
              <SelectTrigger aria-label="Lead" className="w-full">
                <SelectValue>{leadTitle?.name ?? 'No lead'}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value={NO_LEAD}>No lead</SelectItem>
                  {hireable.map((jobTitle) => (
                    <SelectItem key={jobTitle.id} value={jobTitle.id}>
                      {jobTitle.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label id="staff-members-label">Members</Label>
            <ul
              aria-labelledby="staff-members-label"
              className="flex max-h-72 flex-col divide-y overflow-y-auto border-y"
            >
              {hireable.map((jobTitle) => (
                <MemberRow
                  key={jobTitle.id}
                  jobTitle={jobTitle}
                  count={draft.counts[jobTitle.id] ?? 0}
                  onChange={(count) =>
                    edit({ lead: draft.lead, counts: { ...draft.counts, [jobTitle.id]: count } })
                  }
                />
              ))}
            </ul>
          </div>
          <DialogFooter className="items-center">
            {error === undefined ? null : (
              <p role="alert" className="mr-auto text-xs text-error">
                {error}
              </p>
            )}
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || hires === 0}>
              {busy ? (
                <Loader2Icon data-icon="inline-start" className="motion-safe:animate-spin" />
              ) : null}
              {hireLabel(hires)}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
