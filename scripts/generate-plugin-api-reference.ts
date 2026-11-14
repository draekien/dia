import * as NodeRuntime from '@effect/platform-node/NodeRuntime'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { Data, Effect, FileSystem, Path } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import { PLUGIN_API_VERSION } from '../src/shared/plugin/manifest'
import { mergeReferencePages } from './plugin-api-reference'

const ENTRY_POINT = 'src/host/plugin-api.ts'
const OUTPUT_FILE = 'plugins/dia-meta/building-dia-plugins/references/api.md'

const TYPEDOC_PACKAGES = [
  'typedoc@0.28.20',
  'typedoc-plugin-markdown@4.14.1',
  'typescript@6.0.3'
] as const

class TypedocFailed extends Data.TaggedError('TypedocFailed')<{ readonly exitCode: number }> {}

const runTypedoc = Effect.fn('PluginApiReference.typedoc')(function* (outDirectory: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const args = [
    'dlx',
    ...TYPEDOC_PACKAGES.flatMap((name) => ['--package', name]),
    'typedoc',
    '--plugin',
    'typedoc-plugin-markdown',
    '--router',
    'module',
    '--readme',
    'none',
    '--hidePageHeader',
    '--hideBreadcrumbs',
    '--disableSources',
    '--excludeExternals',
    '--logLevel',
    'Error',
    '--entryPoints',
    ENTRY_POINT,
    '--tsconfig',
    'tsconfig.node.json',
    '--out',
    outDirectory
  ]
  yield* Effect.logInfo('Running typedoc on the plugin API', { entryPoint: ENTRY_POINT })
  const exitCode = yield* spawner.exitCode(
    ChildProcess.make('pnpm', args, { shell: true, stdout: 'inherit', stderr: 'inherit' })
  )
  if (exitCode !== 0) return yield* new TypedocFailed({ exitCode })
})

const readNamespacePages = Effect.fn('PluginApiReference.namespaces')(function* (
  outDirectory: string
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const files = yield* fs.readDirectory(outDirectory, { recursive: true })
  const pageFiles = files.filter(
    (file) => path.basename(path.dirname(file)) === 'namespaces' && file.endsWith('.md')
  )
  return yield* Effect.forEach(pageFiles, (file) =>
    fs
      .readFileString(path.join(outDirectory, file))
      .pipe(Effect.map((markdown) => ({ name: path.basename(file, '.md'), markdown })))
  )
})

const generate = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const outDirectory = yield* fs.makeTempDirectoryScoped({ prefix: 'dia-plugin-api-' })
  yield* runTypedoc(outDirectory)
  const main = yield* fs.readFileString(path.join(outDirectory, 'README.md'))
  const namespaces = yield* readNamespacePages(outDirectory)
  yield* fs.makeDirectory(path.dirname(OUTPUT_FILE), { recursive: true })
  yield* fs.writeFileString(OUTPUT_FILE, mergeReferencePages(PLUGIN_API_VERSION, main, namespaces))
  yield* Effect.logInfo('Wrote the plugin API reference', {
    file: OUTPUT_FILE,
    namespaces: namespaces.map((page) => page.name)
  })
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer))

NodeRuntime.runMain(generate)
