import { GitKey, type HostPluginContext, type PluginSetup } from '@dia/plugin'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { Effect } from 'effect'
import { readBranches, switchBranch } from './branches'
import { ReadBranches, SwitchBranch } from './calls'
import { makeGit } from './git'

const setup: PluginSetup<HostPluginContext> = (ctx) =>
  Effect.gen(function* () {
    const git = yield* makeGit.pipe(Effect.provide(NodeServices.layer))
    yield* ctx.provide(GitKey, git)
    yield* ctx.serve(ReadBranches, ({ directory }) => readBranches(git, directory))
    yield* ctx.serve(SwitchBranch, ({ directory, branch }) => switchBranch(git, directory, branch))
    yield* Effect.logInfo('Git provided', { plugin: ctx.name })
  })

export default setup
