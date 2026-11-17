import { type HostPluginContext, isRunScope, type PluginSetup } from '@dia/plugin'
import { ToolsKey } from '@dia-plugin/dia-tools/tools'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'
import { FollowRunPullRequests, RefreshPullRequest, UnlinkPullRequest } from './calls'
import { makeGitHubCli } from './gh'
import { makePullRequests } from './pull-requests'
import { makeLinkStore, pullRequestMigrations } from './store'
import { linkPullRequestTool } from './tool'

const setup: PluginSetup<HostPluginContext> = (ctx) =>
  Effect.gen(function* () {
    const sql = yield* ctx.database(pullRequestMigrations)
    const store = yield* makeLinkStore.pipe(Effect.provideService(SqlClient.SqlClient, sql))
    const gh = yield* makeGitHubCli.pipe(Effect.provide(NodeServices.layer))
    const pullRequests = yield* makePullRequests(store, gh)
    yield* ctx.serve(FollowRunPullRequests, ({ runId }) => pullRequests.follow(runId))
    yield* ctx.serve(UnlinkPullRequest, ({ runId, url }) => pullRequests.unlink(runId, url))
    yield* ctx.serve(RefreshPullRequest, ({ runId, url }) => pullRequests.refresh(runId, url))
    yield* ctx.whenProvided([ToolsKey], ({ tools }) =>
      tools
        .register(linkPullRequestTool(pullRequests), { when: isRunScope })
        .pipe(
          Effect.tap(() => Effect.logInfo('link_pull_request registered', { plugin: ctx.name }))
        )
    )
    yield* Effect.logInfo('Pull request links served', { plugin: ctx.name })
  })

export default setup
