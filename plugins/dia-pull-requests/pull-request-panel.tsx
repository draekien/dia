import {
  Button,
  buttonVariants,
  RelativeTime,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Status,
  StatusMedia,
  StatusName,
  useProvided
} from '@dia/renderer-plugin'
import { MarkdownKey } from '@dia-plugin/dia-markdown/markdown'
import { useAtom } from '@effect/atom-react'
import { DateTime } from 'effect'
import { ExternalLinkIcon, RefreshCwIcon, UnlinkIcon } from 'lucide-react'
import { useState } from 'react'
import type { PullRequestAtoms } from './atoms'
import type {
  LinkedPullRequest,
  PullRequestActivity,
  PullRequestCheck,
  PullRequestDetails
} from './calls'
import { pullRequestRef } from './pull-request-url'
import { useRunPullRequests } from './pull-requests-card'
import { stateLabel } from './summary'

const STATE_FILL = {
  draft: 'none',
  open: 'half',
  merged: 'full',
  closed: 'full'
} as const satisfies Record<PullRequestDetails['state'], 'none' | 'half' | 'full'>

const CHECK_FILL = {
  pending: 'none',
  skipped: 'half',
  passed: 'full',
  failed: 'full'
} as const satisfies Record<PullRequestCheck['state'], 'none' | 'half' | 'full'>

const CHECK_LABEL: Record<PullRequestCheck['state'], string> = {
  pending: 'Pending',
  skipped: 'Skipped',
  passed: 'Passed',
  failed: 'Failed'
}

const REVIEW_LABEL = {
  approved: 'approved',
  changes_requested: 'requested changes',
  commented: 'reviewed',
  dismissed: 'review dismissed'
} as const

const nowIso = () => DateTime.formatIso(DateTime.nowUnsafe())

function Text({ content }: { readonly content: string }): React.JSX.Element {
  const Markdown = useProvided(MarkdownKey)
  if (Markdown !== undefined) return <Markdown content={content} className="text-sm" />
  return <p className="whitespace-pre-wrap text-sm">{content}</p>
}

function Section({
  title,
  children
}: {
  readonly title: string
  readonly children: React.ReactNode
}): React.JSX.Element {
  return (
    <section aria-label={title} className="flex flex-col gap-2 py-3">
      <h3 className="font-medium text-muted-foreground text-xs">{title}</h3>
      {children}
    </section>
  )
}

function Actions({
  pullRequest,
  onRefresh,
  onUnlink
}: {
  readonly pullRequest: LinkedPullRequest
  readonly onRefresh: () => Promise<void>
  readonly onUnlink: () => Promise<void>
}): React.JSX.Element {
  const [refreshing, setRefreshing] = useState(false)
  return (
    <div className="flex flex-wrap gap-1.5">
      <a
        href={pullRequest.url}
        target="_blank"
        rel="noreferrer"
        className={buttonVariants({ variant: 'outline', size: 'xs' })}
      >
        <ExternalLinkIcon data-icon="inline-start" aria-hidden="true" />
        Open in browser
      </a>
      <Button
        variant="outline"
        size="xs"
        disabled={refreshing}
        onClick={() => {
          setRefreshing(true)
          void onRefresh().finally(() => setRefreshing(false))
        }}
      >
        <RefreshCwIcon data-icon="inline-start" aria-hidden="true" />
        {refreshing ? 'Refreshing…' : 'Refresh'}
      </Button>
      <Button variant="ghost" size="xs" onClick={() => void onUnlink()}>
        <UnlinkIcon data-icon="inline-start" aria-hidden="true" />
        Unlink
      </Button>
    </div>
  )
}

function Summary({ details }: { readonly details: PullRequestDetails }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <h2 className="text-balance font-medium text-sm">{details.title}</h2>
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-xs">
        <span className="tabular-nums">#{details.number}</span>
        <Status>
          <StatusMedia fill={STATE_FILL[details.state]} />
          <StatusName className="text-foreground">{stateLabel(details.state)}</StatusName>
        </Status>
        <span>{details.author}</span>
        <span className="tabular-nums">
          <span className="sr-only">Lines added </span>+{details.additions.toLocaleString()}{' '}
          <span className="sr-only">removed </span>−{details.deletions.toLocaleString()}
        </span>
      </p>
      <p className="truncate font-mono text-muted-foreground text-xs">
        {details.baseRef} ← {details.headRef}
      </p>
    </div>
  )
}

function Checks({ checks }: { readonly checks: ReadonlyArray<PullRequestCheck> }) {
  if (checks.length === 0) return <p className="text-muted-foreground text-xs">No checks</p>
  return (
    <ul className="flex flex-col gap-1 text-xs">
      {checks.map((check, index) => {
        const status = (
          <Status className={check.state === 'failed' ? 'text-destructive' : undefined}>
            <StatusMedia fill={CHECK_FILL[check.state]} />
            <StatusName className="text-foreground">{check.name}</StatusName>
            <span className="sr-only">{CHECK_LABEL[check.state]}</span>
          </Status>
        )
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: two checks can share a name and carry no id
          <li key={index} className="flex min-w-0 items-center gap-2">
            {check.url === undefined ? (
              status
            ) : (
              <a
                href={check.url}
                target="_blank"
                rel="noreferrer"
                className="min-w-0 rounded-sm hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                {status}
              </a>
            )}
            <span className="ms-auto shrink-0 text-muted-foreground">
              {CHECK_LABEL[check.state]}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

const activityHeading = (activity: PullRequestActivity): string =>
  activity._tag === 'Review' ? REVIEW_LABEL[activity.state] : 'commented'

function Activity({ activity }: { readonly activity: ReadonlyArray<PullRequestActivity> }) {
  if (activity.length === 0) {
    return <p className="text-muted-foreground text-xs">No reviews or comments</p>
  }
  const now = nowIso()
  return (
    <ol className="flex flex-col gap-3">
      {activity.map((entry, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: entries carry no id and keep their order
        <li key={index} className="flex flex-col gap-1">
          <p className="flex items-baseline gap-1.5 text-xs">
            <span className="font-medium">{entry.author}</span>
            <span className="text-muted-foreground">{activityHeading(entry)}</span>
            <span className="ms-auto shrink-0 text-muted-foreground">
              <RelativeTime
                dateTime={DateTime.formatIso(DateTime.makeUnsafe(entry.at))}
                now={now}
              />
            </span>
          </p>
          {entry.body.trim() !== '' && <Text content={entry.body} />}
        </li>
      ))}
    </ol>
  )
}

function Details({
  pullRequest,
  onRefresh,
  onUnlink
}: {
  readonly pullRequest: LinkedPullRequest
  readonly onRefresh: () => Promise<void>
  readonly onUnlink: () => Promise<void>
}): React.JSX.Element {
  const read = pullRequest.read
  const actions = <Actions pullRequest={pullRequest} onRefresh={onRefresh} onUnlink={onUnlink} />
  if (read._tag !== 'Read') {
    return (
      <div className="flex flex-col gap-3">
        <p className="font-medium text-sm tabular-nums">
          #{pullRequestRef(pullRequest.url).number}
        </p>
        {read._tag === 'Reading' ? (
          <div className="flex flex-col gap-2">
            <span className="sr-only">Reading the pull request</span>
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">{read.message}</p>
        )}
        {actions}
      </div>
    )
  }
  const { details } = read
  return (
    <div className="flex flex-col divide-y divide-border">
      <div className="flex flex-col gap-3 pb-3">
        <Summary details={details} />
        {actions}
      </div>
      <Section title="Checks">
        <Checks checks={details.checks} />
      </Section>
      <Section title="Reviews and comments">
        <Activity activity={details.activity} />
      </Section>
      <Section title="Description">
        {details.body.trim() === '' ? (
          <p className="text-muted-foreground text-xs">No description</p>
        ) : (
          <Text content={details.body} />
        )}
      </Section>
    </div>
  )
}

const optionLabel = (pullRequest: LinkedPullRequest): string => {
  const number = `#${pullRequestRef(pullRequest.url).number}`
  return pullRequest.read._tag === 'Read' ? `${number} ${pullRequest.read.details.title}` : number
}

function Switcher({
  pullRequests,
  shown,
  onSelect
}: {
  readonly pullRequests: ReadonlyArray<LinkedPullRequest>
  readonly shown: LinkedPullRequest
  readonly onSelect: (url: LinkedPullRequest['url']) => void
}): React.JSX.Element {
  return (
    <Select
      value={shown.url}
      onValueChange={(next) => {
        const chosen = pullRequests.find((pullRequest) => pullRequest.url === next)
        if (chosen !== undefined) onSelect(chosen.url)
      }}
    >
      <SelectTrigger
        size="sm"
        aria-label="Pull request"
        className="-ml-2 h-7 max-w-full border-transparent px-2 text-xs shadow-none"
      >
        <SelectValue>{optionLabel(shown)}</SelectValue>
      </SelectTrigger>
      <SelectContent align="start">
        <SelectGroup>
          {pullRequests.map((pullRequest) => (
            <SelectItem key={pullRequest.url} value={pullRequest.url}>
              {optionLabel(pullRequest)}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}

/**
 * The `Pull request` right panel body for the tab showing run `runId`: the pull request the tab's
 * card row chose (or the first linked one), with its summary, checks, reviews and comments, and
 * description, and the actions `Open in browser`, `Refresh` and `Unlink`. With two or more linked
 * pull requests a switcher above the details chooses which one.
 */
export function PullRequestPanel({
  runId,
  atoms
}: {
  readonly runId: string
  readonly atoms: PullRequestAtoms
}): React.JSX.Element {
  const pullRequests = useRunPullRequests(atoms, runId)
  const [shownUrl, setShown] = useAtom(atoms.shown(runId))
  const shown = pullRequests.find((pullRequest) => pullRequest.url === shownUrl) ?? pullRequests[0]
  if (shown === undefined) {
    return <p className="p-3 text-muted-foreground text-sm">No pull requests linked to this run</p>
  }
  return (
    <div className="flex flex-col gap-2 p-3">
      {pullRequests.length > 1 && (
        <Switcher pullRequests={pullRequests} shown={shown} onSelect={setShown} />
      )}
      <Details
        key={shown.url}
        pullRequest={shown}
        onRefresh={() => atoms.refresh(runId, shown.url)}
        onUnlink={() => atoms.unlink(runId, shown.url)}
      />
    </div>
  )
}
