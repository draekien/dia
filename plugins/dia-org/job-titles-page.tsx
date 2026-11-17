import { Button } from '@dia/renderer-plugin'
import { PlusIcon } from 'lucide-react'
import { useState } from 'react'
import type { JobTitleId } from './domain'
import { EntryList } from './entry-list'
import { JobTitleEditor, NewJobTitleEditor } from './job-title-editor'
import type { OrgScreen } from './org-actions'
import { JobTitlesView } from './org-view'

/**
 * The Job titles page: every job title with its hire count, and the detail of the selected one,
 * `jobTitleId`, or the first when null. Below 48rem of width the list sits above the detail.
 * `New job title` replaces the detail with an empty editor until it is saved or cancelled, a job
 * title is selected, or `jobTitleId` changes.
 */
export function JobTitlesPage({
  jobTitleId,
  ...screen
}: OrgScreen & { readonly jobTitleId: JobTitleId | null }) {
  const { snapshot, show } = screen
  const [creating, setCreating] = useState(false)
  const [creatingFor, setCreatingFor] = useState(jobTitleId)
  if (creatingFor !== jobTitleId) {
    setCreatingFor(jobTitleId)
    setCreating(false)
  }
  const selected =
    snapshot.jobTitles.find((jobTitle) => jobTitle.id === jobTitleId) ?? snapshot.jobTitles[0]

  return (
    <div className="flex flex-col gap-6 @3xl:flex-row">
      <div className="flex max-w-sm flex-col gap-3 @3xl:w-56 @3xl:shrink-0">
        <Button
          size="sm"
          variant="outline"
          className="self-start"
          onClick={() => setCreating(true)}
        >
          <PlusIcon data-icon="inline-start" />
          New job title
        </Button>
        <EntryList
          label="Job titles"
          selectedId={creating ? undefined : selected?.id}
          onSelect={(id) => {
            setCreating(false)
            show(JobTitlesView.make({ jobTitleId: id as JobTitleId }))
          }}
          entries={snapshot.jobTitles.map((jobTitle) => {
            const hires = snapshot.hiredAgents.filter(
              (agent) => agent.jobTitleId === jobTitle.id
            ).length
            return {
              id: jobTitle.id,
              content: (
                <>
                  <span className="truncate">{jobTitle.name}</span>
                  {jobTitle.enabled ? null : (
                    <span className="text-xs font-normal text-ink-muted">Disabled</span>
                  )}
                  <span
                    className="ml-auto text-xs font-normal text-ink-muted tabular-nums"
                    title={`${hires} hired`}
                  >
                    <span className="sr-only">Hired: </span>
                    {hires}
                  </span>
                </>
              )
            }
          })}
        />
      </div>
      {creating ? (
        <div className="min-w-0 max-w-3xl flex-1">
          <NewJobTitleEditor {...screen} onClose={() => setCreating(false)} />
        </div>
      ) : selected === undefined ? null : (
        <div className="min-w-0 max-w-3xl flex-1">
          <JobTitleEditor key={selected.id} jobTitle={selected} {...screen} />
        </div>
      )}
    </div>
  )
}
