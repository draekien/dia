import * as NodeServices from '@effect/platform-node/NodeServices'
import { assert, describe, it } from '@effect/vitest'
import { Effect, Exit, FileSystem, type Path } from 'effect'
import { moveTranscriptFolders, transcriptFolderOf } from './transcript-folders'

const move = {
  from: 'C:\\Users\\me\\AppData\\Roaming\\dia\\plugins\\worktrees',
  to: 'C:\\Users\\me\\AppData\\Roaming\\dia\\plugins\\dia-worktrees'
}
const movedCwd = `${move.from}\\trees\\heron`
const OLD_FOLDER = 'C--Users-me-AppData-Roaming-dia-plugins-worktrees-trees-heron'
const NEW_FOLDER = 'C--Users-me-AppData-Roaming-dia-plugins-dia-worktrees-trees-heron'

const withProjects = <A, E>(
  body: (
    projects: string,
    fs: FileSystem.FileSystem
  ) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const projects = yield* fs.makeTempDirectoryScoped()
    return yield* body(projects, fs)
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))

describe('transcriptFolderOf', () => {
  it('replaces every character outside letters and digits with a hyphen', () => {
    assert.strictEqual(transcriptFolderOf('/p', movedCwd), `/p/${OLD_FOLDER}`)
  })
})

describe('moveTranscriptFolders', () => {
  it.effect('renames the transcript folder of a session whose working directory moved', () =>
    withProjects((projects, fs) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(`${projects}/${OLD_FOLDER}`)
        yield* fs.writeFileString(`${projects}/${OLD_FOLDER}/s.jsonl`, '{}')

        yield* moveTranscriptFolders(move, projects, Effect.succeed([movedCwd]))

        assert.deepStrictEqual(
          [
            yield* fs.exists(`${projects}/${OLD_FOLDER}`),
            yield* fs.readFileString(`${projects}/${NEW_FOLDER}/s.jsonl`)
          ],
          [false, '{}']
        )
      })
    )
  )

  it.effect('leaves the transcript folder of a working directory outside the moved folder', () =>
    withProjects((projects, fs) =>
      Effect.gen(function* () {
        const sibling = `${move.from}-settings`
        const folder = sibling.replace(/[^a-zA-Z0-9]/g, '-')
        yield* fs.makeDirectory(`${projects}/${folder}`)

        yield* moveTranscriptFolders(move, projects, Effect.succeed([sibling]))

        assert.deepStrictEqual(yield* fs.readDirectory(projects), [folder])
      })
    )
  )

  it.effect('keeps both folders when the new folder already exists', () =>
    withProjects((projects, fs) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(`${projects}/${OLD_FOLDER}`)
        yield* fs.makeDirectory(`${projects}/${NEW_FOLDER}`)

        yield* moveTranscriptFolders(move, projects, Effect.succeed([movedCwd]))

        assert.deepStrictEqual(
          (yield* fs.readDirectory(projects)).sort(),
          [NEW_FOLDER, OLD_FOLDER].sort()
        )
      })
    )
  )

  it.effect('does nothing for a moved working directory without a transcript folder', () =>
    withProjects((projects, fs) =>
      Effect.gen(function* () {
        yield* moveTranscriptFolders(move, projects, Effect.succeed([movedCwd]))

        assert.deepStrictEqual(yield* fs.readDirectory(projects), [])
      })
    )
  )

  it.effect('does not list sessions when no transcript folder lies under the moved folder', () =>
    withProjects((projects, fs) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(`${projects}/C--elsewhere`)

        const exit = yield* Effect.exit(
          moveTranscriptFolders(move, projects, Effect.fail('listed sessions'))
        )

        assert.isTrue(Exit.isSuccess(exit))
      })
    )
  )
})
