import { NodeFileSystem, NodePath } from '@effect/platform-node'
import { assert, describe, it } from '@effect/vitest'
import { Effect, FileSystem, Layer, Option } from 'effect'
import { makeClaudeInstall, resolveSpawnablePath } from './claude-install'

const filesAt =
  (...paths: ReadonlyArray<string>) =>
  (path: string): boolean =>
    paths.includes(path)

describe('resolveSpawnablePath on Linux and macOS', () => {
  it('finds a bare name in the first PATH directory that has it', () => {
    const resolved = resolveSpawnablePath(
      'claude',
      'linux',
      { PATH: '/usr/bin:/home/me/.local/bin:/opt/bin' },
      filesAt('/home/me/.local/bin/claude', '/opt/bin/claude')
    )
    assert.deepStrictEqual(resolved, Option.some('/home/me/.local/bin/claude'))
  })

  it('is none when no PATH directory has the name', () => {
    const resolved = resolveSpawnablePath('claude', 'darwin', { PATH: '/usr/bin' }, filesAt())
    assert.deepStrictEqual(resolved, Option.none())
  })

  it('is none when PATH is unset', () => {
    assert.deepStrictEqual(
      resolveSpawnablePath('claude', 'linux', {}, filesAt('claude')),
      Option.none()
    )
  })

  it('uses an absolute path as given without searching PATH', () => {
    const resolved = resolveSpawnablePath(
      '/opt/claude/claude',
      'linux',
      { PATH: '/usr/bin' },
      filesAt('/opt/claude/claude', '/usr/bin/claude')
    )
    assert.deepStrictEqual(resolved, Option.some('/opt/claude/claude'))
  })
})

describe('resolveSpawnablePath on Windows', () => {
  const env = { Path: 'C:\\Windows;C:\\Users\\me\\AppData\\Roaming\\npm', PATHEXT: '.EXE;.CMD' }

  it('finds the native claude.exe through PATHEXT, whatever the casing of Path', () => {
    const resolved = resolveSpawnablePath(
      'claude',
      'win32',
      { Path: 'C:\\Users\\me\\.local\\bin', PATHEXT: '.EXE;.CMD' },
      filesAt('C:\\Users\\me\\.local\\bin\\claude.exe')
    )
    assert.deepStrictEqual(resolved, Option.some('C:\\Users\\me\\.local\\bin\\claude.exe'))
  })

  it('replaces an npm claude.cmd shim with the claude.exe beside it', () => {
    const resolved = resolveSpawnablePath(
      'claude',
      'win32',
      env,
      filesAt(
        'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd',
        'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'
      )
    )
    assert.deepStrictEqual(
      resolved,
      Option.some(
        'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'
      )
    )
  })

  it('skips the extensionless sh script npm writes beside claude.cmd', () => {
    const resolved = resolveSpawnablePath(
      'claude',
      'win32',
      env,
      filesAt(
        'C:\\Users\\me\\AppData\\Roaming\\npm\\claude',
        'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd',
        'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'
      )
    )
    assert.deepStrictEqual(
      resolved,
      Option.some(
        'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'
      )
    )
  })

  it('falls back to cli.js for an older package without bin/claude.exe', () => {
    const resolved = resolveSpawnablePath(
      'claude',
      'win32',
      env,
      filesAt(
        'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd',
        'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js'
      )
    )
    assert.deepStrictEqual(
      resolved,
      Option.some(
        'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js'
      )
    )
  })

  it('is none for a shim with no package entry beside it, because the SDK cannot spawn a shim', () => {
    const resolved = resolveSpawnablePath(
      'claude',
      'win32',
      env,
      filesAt('C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd')
    )
    assert.deepStrictEqual(resolved, Option.none())
  })

  it('resolves an absolute override that names a .cmd shim', () => {
    const resolved = resolveSpawnablePath(
      'D:\\tools\\npm\\claude.cmd',
      'win32',
      env,
      filesAt(
        'D:\\tools\\npm\\claude.cmd',
        'D:\\tools\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'
      )
    )
    assert.deepStrictEqual(
      resolved,
      Option.some('D:\\tools\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe')
    )
  })
})

const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)

describe('makeClaudeInstall', () => {
  it.effect('has no override until one is set, and forgets it when cleared', () =>
    Effect.gen(function* () {
      const dataDir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()
      const install = yield* makeClaudeInstall({ dataDir }, filesAt())

      const initial = yield* install.override
      yield* install.setOverride(Option.some('D:\\tools\\claude.exe'))
      const stored = yield* install.override
      yield* install.setOverride(Option.none())
      const cleared = yield* install.override

      assert.deepStrictEqual(
        [initial, stored, cleared],
        [Option.none(), Option.some('D:\\tools\\claude.exe'), Option.none()]
      )
    }).pipe(Effect.scoped, Effect.provide(platform))
  )

  it.effect('keeps the override in the data directory across instances', () =>
    Effect.gen(function* () {
      const dataDir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()
      const first = yield* makeClaudeInstall({ dataDir }, filesAt())
      yield* first.setOverride(Option.some('/opt/claude'))

      const second = yield* makeClaudeInstall({ dataDir }, filesAt())

      assert.deepStrictEqual(yield* second.override, Option.some('/opt/claude'))
    }).pipe(Effect.scoped, Effect.provide(platform))
  )

  it.effect('does not fall back to PATH when the stored override cannot be run', () =>
    Effect.gen(function* () {
      const dataDir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()
      const missing = process.platform === 'win32' ? 'Z:\\missing\\claude.exe' : '/missing/claude'
      const everyFileExceptTheOverride = (path: string) => path !== missing
      const install = yield* makeClaudeInstall({ dataDir }, everyFileExceptTheOverride)
      yield* install.setOverride(Option.some(missing))

      assert.deepStrictEqual(yield* install.resolve, Option.none())
    }).pipe(Effect.scoped, Effect.provide(platform))
  )
})
