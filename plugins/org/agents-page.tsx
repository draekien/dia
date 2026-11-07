// @effect-diagnostics asyncFunction:off -- React callbacks await OrgCall's Promise; components hold no Effect runtime.
import {
  Button,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SettingsRow,
  ToggleGroup,
  ToggleGroupItem
} from '@dia/renderer-plugin'
import { Result } from 'effect'
import { useState } from 'react'
import { Dismiss, RenameHire, SetBypassOverride, SetReportsTo } from './calls'
import { ConfirmDialog } from './confirm-dialog'
import type { HiredAgent, HireId } from './domain'
import { EntryList } from './entry-list'
import { NameDialog } from './name-dialog'
import {
  agentName,
  commonFailureText,
  type OrgScreen,
  readAgentName,
  toastFailure
} from './org-actions'
import { NoHires } from './org-chart'
import { reportsToChoices } from './org-tree'
import { HiredAgentsView, JobTitlesView } from './org-view'

const YOU = 'you'

const BYPASS = [
  { value: 'follow', label: 'Follow job title', override: null },
  { value: 'on', label: 'On', override: true },
  { value: 'off', label: 'Off', override: false }
] as const

const hiredDate = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })

function AgentDetail({
  agent,
  snapshot,
  call,
  show
}: Omit<OrgScreen, 'openHire'> & { readonly agent: HiredAgent }) {
  const [dialog, setDialog] = useState<'rename' | 'dismiss' | undefined>(undefined)
  const [reportsToError, setReportsToError] = useState<string | undefined>(undefined)
  const name = agentName(agent, snapshot.jobTitles)
  const nameOf = (hireId: HireId | null) => {
    const other = snapshot.hiredAgents.find((candidate) => candidate.id === hireId)
    return other === undefined ? 'You' : agentName(other, snapshot.jobTitles)
  }
  const jobTitle = snapshot.jobTitles.find((candidate) => candidate.id === agent.jobTitleId)
  const reports = snapshot.hiredAgents.filter((other) => other.reportsTo === agent.id)
  const bypass = BYPASS.find((option) => option.override === agent.bypassOverride) ?? BYPASS[0]

  const rename = async (text: string): Promise<string | undefined> => {
    const read = readAgentName(text)
    if (Result.isFailure(read)) return read.failure
    const result = await call(RenameHire, { hireId: agent.id, name: read.success }, agent.id)
    if (Result.isSuccess(result)) return undefined
    const failure = result.failure
    return failure._tag === 'HireNameTaken'
      ? `An agent named "${failure.agentName}" already exists`
      : commonFailureText(failure)
  }

  const dismiss = async (): Promise<string | undefined> => {
    const result = await call(Dismiss, { hireId: agent.id }, agent.id)
    if (Result.isSuccess(result) || result.failure._tag === 'HireNotFound') return undefined
    return commonFailureText(result.failure)
  }

  const setReportsTo = async (reportsTo: HireId | null) => {
    setReportsToError(undefined)
    const result = await call(SetReportsTo, { hireId: agent.id, reportsTo }, agent.id)
    if (Result.isSuccess(result)) return
    const failure = result.failure
    if (failure._tag === 'ReportsToCycle') {
      return setReportsToError(
        failure.reportsTo === failure.hireId
          ? 'An agent cannot report to itself'
          : `${nameOf(failure.reportsTo)} already reports to ${name}`
      )
    }
    if (failure._tag === 'HireNotFound' && failure.hireId === reportsTo) {
      return setReportsToError('The selected manager was dismissed')
    }
    setReportsToError(commonFailureText(failure))
  }

  const setBypass = async (value: string) => {
    const option = BYPASS.find((candidate) => candidate.value === value)
    if (option === undefined || option.override === agent.bypassOverride) return
    const result = await call(
      SetBypassOverride,
      { hireId: agent.id, override: option.override },
      agent.id
    )
    if (Result.isFailure(result)) {
      toastFailure(`Could not change bypass approvals for ${name}`, result.failure)
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h3 className="text-base font-semibold text-ink">{name}</h3>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setDialog('rename')}>
            Rename
          </Button>
          <Button size="sm" variant="outline" onClick={() => setDialog('dismiss')}>
            Dismiss…
          </Button>
        </div>
      </div>
      <dl className="flex flex-col gap-4">
        <SettingsRow label="Job title">
          <Button
            variant="link"
            className="h-auto p-0"
            onClick={() => show(JobTitlesView.make({ jobTitleId: agent.jobTitleId }))}
          >
            {jobTitle?.name}
          </Button>
        </SettingsRow>
        <SettingsRow label="Reports to">
          <div className="flex max-w-xs flex-col gap-1.5">
            <Select
              value={agent.reportsTo ?? YOU}
              onValueChange={(value) => {
                const next = value === YOU || value === null ? null : (value as HireId)
                if (next !== agent.reportsTo) void setReportsTo(next)
              }}
            >
              <SelectTrigger aria-label="Reports to" className="w-full">
                <SelectValue>{nameOf(agent.reportsTo)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value={YOU}>You</SelectItem>
                  {reportsToChoices(snapshot.hiredAgents, agent.id).map((choice) => (
                    <SelectItem key={choice.id} value={choice.id}>
                      {agentName(choice, snapshot.jobTitles)}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            {reportsToError === undefined ? null : (
              <p className="text-xs text-error">{reportsToError}</p>
            )}
          </div>
        </SettingsRow>
        {snapshot.bypassAvailable ? (
          <SettingsRow label="Bypass approvals">
            <ToggleGroup
              value={[bypass.value]}
              onValueChange={([value]) => {
                if (value !== undefined) void setBypass(value)
              }}
              variant="outline"
              size="sm"
              aria-label="Bypass approvals"
            >
              {BYPASS.map((option) => (
                <ToggleGroupItem key={option.value} value={option.value}>
                  {option.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </SettingsRow>
        ) : null}
        <SettingsRow label="Hired">
          <span className="tabular-nums">{hiredDate.format(agent.hiredAt)}</span>
        </SettingsRow>
      </dl>
      {dialog === 'rename' ? (
        <NameDialog
          title={`Rename ${name}`}
          initial={agent.name ?? ''}
          placeholder="Leave blank for no name"
          submitLabel="Rename"
          onSubmit={rename}
          onClose={() => setDialog(undefined)}
        />
      ) : null}
      {dialog === 'dismiss' ? (
        <ConfirmDialog
          title={`Dismiss ${name}?`}
          description={
            reports.length === 0
              ? 'dia removes this agent from the org.'
              : `Its ${reports.length} reports will report to ${nameOf(agent.reportsTo)}.`
          }
          confirmLabel="Dismiss"
          onConfirm={dismiss}
          onClose={() => setDialog(undefined)}
        />
      ) : null}
    </div>
  )
}

/**
 * The Hired agents page: `Hire…`, every hired agent with its job title, and the detail of the
 * selected one, `hireId`, or the first when null, where every agent action lives. With no hires it
 * shows the empty state.
 */
export function AgentsPage({ hireId, ...screen }: OrgScreen & { readonly hireId: HireId | null }) {
  const { snapshot, show, openHire } = screen
  if (snapshot.hiredAgents.length === 0) return <NoHires openHire={openHire} />
  const selected =
    snapshot.hiredAgents.find((agent) => agent.id === hireId) ?? snapshot.hiredAgents[0]

  return (
    <div className="flex flex-col gap-6 @3xl:flex-row">
      <div className="flex flex-col gap-3 @3xl:w-56 @3xl:shrink-0">
        <Button size="sm" variant="outline" className="self-start" onClick={() => openHire(null)}>
          Hire…
        </Button>
        <EntryList
          label="Hired agents"
          selectedId={selected?.id}
          onSelect={(id) => show(HiredAgentsView.make({ hireId: id as HireId }))}
          entries={snapshot.hiredAgents.map((agent) => ({
            id: agent.id,
            content: (
              <>
                <span className="truncate">{agentName(agent, snapshot.jobTitles)}</span>
                <span className="ml-auto truncate text-xs font-normal text-ink-muted">
                  {snapshot.jobTitles.find((jobTitle) => jobTitle.id === agent.jobTitleId)?.name}
                </span>
              </>
            )
          }))}
        />
      </div>
      {selected === undefined ? null : (
        <div className="min-w-0 max-w-3xl flex-1">
          <AgentDetail key={selected.id} agent={selected} {...screen} />
        </div>
      )}
    </div>
  )
}
