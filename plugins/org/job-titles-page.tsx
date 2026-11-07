import type { JobTitleId } from './domain'
import { EntryList } from './entry-list'
import { JobTitleEditor } from './job-title-editor'
import type { OrgScreen } from './org-actions'
import { JobTitlesView } from './org-view'

/**
 * The Job titles page: every job title with its hire count, and the detail of the selected one,
 * `jobTitleId`, or the first when null. Below 48rem of width the list sits above the detail.
 */
export function JobTitlesPage({
  jobTitleId,
  ...screen
}: OrgScreen & { readonly jobTitleId: JobTitleId | null }) {
  const { snapshot, show } = screen
  const selected =
    snapshot.jobTitles.find((jobTitle) => jobTitle.id === jobTitleId) ?? snapshot.jobTitles[0]

  return (
    <div className="flex flex-col gap-6 @3xl:flex-row">
      <div className="@3xl:w-56 @3xl:shrink-0">
        <EntryList
          label="Job titles"
          selectedId={selected?.id}
          onSelect={(id) => show(JobTitlesView.make({ jobTitleId: id as JobTitleId }))}
          entries={snapshot.jobTitles.map((jobTitle) => ({
            id: jobTitle.id,
            content: (
              <>
                <span className="truncate">{jobTitle.name}</span>
                {jobTitle.enabled ? null : (
                  <span className="text-xs font-normal text-ink-muted">Disabled</span>
                )}
                <span className="ml-auto text-xs font-normal text-ink-muted tabular-nums">
                  {snapshot.hiredAgents.filter((agent) => agent.jobTitleId === jobTitle.id).length}
                </span>
              </>
            )
          }))}
        />
      </div>
      {selected === undefined ? null : (
        <div className="min-w-0 max-w-3xl flex-1">
          <JobTitleEditor key={selected.id} jobTitle={selected} {...screen} />
        </div>
      )}
    </div>
  )
}
