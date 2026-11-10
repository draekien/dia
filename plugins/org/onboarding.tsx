import type { PaneId } from '@dia/plugin'
import {
  actions,
  Button,
  Label,
  paneSendAtom,
  REGISTER_PROJECT_REFUSAL_TEXT,
  Status,
  StatusMedia,
  StatusName,
  Textarea
} from '@dia/renderer-plugin'
import { useAtomSet } from '@effect/atom-react'
import { Effect } from 'effect'
import { SendIcon } from 'lucide-react'
import { type FormEvent, useId, useState } from 'react'

/** The onboarding step the Dashboard marks current. */
export type OnboardingStage = 'add-project' | 'staff' | 'get-working'

/**
 * The onboarding step to mark current for a workspace of `projects` projects and an org of `hires`
 * hired agents, `teamHasWork` saying whether any of them has an open issue; null once the team has
 * work, when the Dashboard shows no onboarding.
 */
export const onboardingStage = (
  projects: number,
  hires: number,
  teamHasWork: boolean
): OnboardingStage | null => {
  if (projects === 0) return 'add-project'
  if (hires === 0) return 'staff'
  return teamHasWork ? null : 'get-working'
}

const STEPS: ReadonlyArray<{
  readonly stage: OnboardingStage
  readonly name: string
  readonly detail: string
}> = [
  {
    stage: 'add-project',
    name: 'Add a project',
    detail: 'Agents work inside a project directory.'
  },
  {
    stage: 'staff',
    name: 'Staff the org',
    detail: 'Hire a team: a lead and the agents who report to it.'
  },
  {
    stage: 'get-working',
    name: 'Get the team working',
    detail: 'Tell the Executive assistant what to build.'
  }
]

function AddProjectAction() {
  const [notice, setNotice] = useState<string | null>(null)
  const add = () => {
    setNotice(null)
    actions.registerProject().then(
      (refusal) => setNotice(refusal == null ? null : REGISTER_PROJECT_REFUSAL_TEXT[refusal._tag]),
      () => setNotice('The project could not be added. Try again.')
    )
  }
  return (
    <div className="flex flex-col items-start gap-1.5">
      <Button size="sm" onClick={add}>
        Add project…
      </Button>
      {notice === null ? null : (
        <p role="alert" className="text-xs text-error">
          {notice}
        </p>
      )}
    </div>
  )
}

/**
 * The three onboarding steps (Add a project, Staff the org, Get the team working) in order, with
 * the steps before `stage` drawn done and `stage` current. The current step holds its action:
 * `Add project…` opens the directory picker and shows a refusal beside it; `Staff the org…` calls
 * `openStaff`. Get the team working has no action here; {@link TeamWorkBox} carries it.
 */
export function OnboardingStrip({
  stage,
  openStaff
}: {
  readonly stage: OnboardingStage
  readonly openStaff: () => void
}) {
  const current = STEPS.findIndex((step) => step.stage === stage)
  return (
    <section aria-labelledby="org-onboarding-heading" className="flex flex-col gap-2">
      <h3 id="org-onboarding-heading" className="text-sm font-medium text-ink">
        Set up the org
      </h3>
      <ol className="grid grid-cols-1 divide-y border-y @lg:grid-cols-3 @lg:divide-x @lg:divide-y-0">
        {STEPS.map((step, index) => {
          const state = index < current ? 'done' : index === current ? 'current' : 'later'
          return (
            <li
              key={step.stage}
              aria-current={state === 'current' ? 'step' : undefined}
              className="flex min-w-0 flex-col gap-2 py-3 @lg:px-4 @lg:first:pl-0"
            >
              <Status className={state === 'current' ? 'text-primary' : 'text-ink-muted'}>
                <StatusMedia
                  fill={state === 'done' ? 'full' : state === 'current' ? 'half' : 'none'}
                />
                <StatusName
                  className={state === 'current' ? 'font-medium text-ink' : 'text-ink-muted'}
                >
                  {step.name}
                </StatusName>
                {state === 'done' ? <span className="sr-only">(done)</span> : null}
              </Status>
              <p className="text-xs text-ink-muted">{step.detail}</p>
              {state !== 'current' ? null : step.stage === 'add-project' ? (
                <AddProjectAction />
              ) : step.stage === 'staff' ? (
                <div>
                  <Button size="sm" onClick={openStaff}>
                    Staff the org…
                  </Button>
                </div>
              ) : null}
            </li>
          )
        })}
      </ol>
    </section>
  )
}

function SendBox({ paneId }: { readonly paneId: PaneId }) {
  const send = useAtomSet(paneSendAtom(paneId))
  const [text, setText] = useState('')
  const fieldId = useId()

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const request = text.trim()
    if (request === '') return
    Effect.runSync(Effect.logInfo('Sending team work to the Executive assistant', { paneId }))
    send({ text: request, mode: 'queue' })
    setText('')
    actions.selectAttached(paneId)
  }

  return (
    <form className="flex flex-col gap-2" onSubmit={submit}>
      <Label htmlFor={fieldId}>What should the team work on?</Label>
      <Textarea
        id={fieldId}
        value={text}
        rows={3}
        placeholder="Add a dark mode toggle to the settings page"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) submit(event)
        }}
      />
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={text.trim() === ''}>
          <SendIcon data-icon="inline-start" />
          Send to the Executive assistant
        </Button>
        <span className="text-xs text-ink-muted">
          It plans the work and assigns it to your team.
        </span>
      </div>
    </form>
  )
}

/**
 * `What should the team work on?`: a request box whose `Send` queues the text in the Executive
 * assistant session at `assistantPaneId` and shows that session. While `assistantPaneId` is null
 * it says the Executive assistant is not running and offers no box.
 */
export function TeamWorkBox({ assistantPaneId }: { readonly assistantPaneId: PaneId | null }) {
  return (
    <section aria-label="Team work" className="flex max-w-2xl flex-col gap-2">
      {assistantPaneId === null ? (
        <p className="text-sm text-ink-muted">
          The Executive assistant is not running, so it cannot take requests.
        </p>
      ) : (
        <SendBox key={assistantPaneId} paneId={assistantPaneId} />
      )}
    </section>
  )
}
