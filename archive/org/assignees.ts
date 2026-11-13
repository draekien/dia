import { ListedAssignee } from '@dia-plugin/issues/domain'
import { Effect, Stream } from 'effect'
import { agentName, jobTitleName } from './domain'
import type { Org } from './service'

/**
 * The hired agents of `org` as listed assignees (id, name, job title): the current list when
 * subscribed, then a new list after each hire, dismissal, rename or job title change. Pass it as
 * the `assignees` of the org's assignee provider.
 */
export const orgAssignees = (org: Org) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const hireChanges = yield* org.watchHireChanges
      const jobTitleChanges = yield* org.watchJobTitleChanges
      const read = Effect.map(Effect.all([org.hiredAgents, org.jobTitles]), ([hires, jobTitles]) =>
        hires.map((hire) =>
          ListedAssignee.make({
            id: hire.id,
            name: agentName(hire, jobTitles),
            detail: jobTitleName(hire, jobTitles) ?? ''
          })
        )
      )
      return Stream.concat(Stream.make(undefined), Stream.merge(hireChanges, jobTitleChanges)).pipe(
        Stream.mapEffect(() => read)
      )
    })
  )
