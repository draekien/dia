// @effect-diagnostics-next-line nodeBuiltinImport:off -- the test reads plugin sources and writes fixture plugins on disk.
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
// @effect-diagnostics-next-line nodeBuiltinImport:off -- the test resolves paths inside the plugins directory.
import { dirname, extname, join, relative, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolvePluginExport } from '../../shared/plugin/plugin-export'

interface ConfigIncludes {
  readonly config: string
  readonly files: ReadonlySet<string>
}

const ALLOWED_PACKAGES = /^(?:effect(?:\/.*)?|@dia\/plugin)$/
const SPECIFIER_PATTERNS = [
  /(?:import|export)\s[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g,
  /import\s*['"]([^'"]+)['"]/g,
  /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g
]
const FORBIDDEN_FORMS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\brequire\s*\(/, 'require('],
  [/\bimport\s*\((?!\s*['"][^'"]+['"]\s*\))/, 'import() of a non-literal'],
  [/\bimport\.meta\b/, 'import.meta']
]

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const specifiersOf = (source: string): ReadonlyArray<string> =>
  SPECIFIER_PATTERNS.flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1]))

const exportsIn = (pluginsDir: string, plugin: string): ReadonlyArray<string> | undefined => {
  const manifestPath = join(pluginsDir, plugin, 'plugin.json')
  if (!fs.existsSync(manifestPath)) return undefined
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8')).exports ?? []
}

const exportProblems = (
  pluginsDir: string,
  includes: ReadonlyArray<ConfigIncludes>
): ReadonlyArray<string> => {
  const problems: Array<string> = []
  const visited = new Set<string>()
  const visit = (plugin: string, file: string): void => {
    const pluginRoot = join(pluginsDir, plugin)
    const path = join(pluginRoot, file)
    if (visited.has(path)) return
    visited.add(path)
    const label = `${plugin}/${file}`
    const source = stripComments(fs.readFileSync(path, 'utf8'))
    for (const [pattern, form] of FORBIDDEN_FORMS) {
      if (pattern.test(source)) problems.push(`${label}: uses ${form}`)
    }
    for (const specifier of specifiersOf(source)) {
      if (specifier.startsWith('.')) {
        const named = resolve(dirname(path), specifier)
        const target = extname(named) === '' ? `${named}.ts` : named
        const inPlugin = relative(pluginRoot, target)
        if (inPlugin.startsWith('..') || extname(target) !== '.ts' || !fs.existsSync(target)) {
          problems.push(`${label}: "${specifier}" is not a .ts file in plugin "${plugin}"`)
        } else visit(plugin, inPlugin.replaceAll('\\', '/'))
        continue
      }
      const exported = resolvePluginExport(specifier, (name) => exportsIn(pluginsDir, name))
      if (exported === undefined) {
        if (!ALLOWED_PACKAGES.test(specifier)) problems.push(`${label}: imports "${specifier}"`)
      } else if ('message' in exported) problems.push(`${label}: ${exported.message}`)
      else visit(exported.plugin, exported.file)
    }
  }
  for (const plugin of fs.readdirSync(pluginsDir)) {
    for (const file of exportsIn(pluginsDir, plugin) ?? []) {
      for (const { config, files } of includes) {
        if (!files.has(resolve(pluginsDir, plugin, file))) {
          problems.push(`${plugin}/${file}: not in ${config} include`)
        }
      }
      visit(plugin, file)
    }
  }
  return problems
}

const repoRoot = resolve(__dirname, '../../..')

const includesOf = (config: string): ConfigIncludes => ({
  config,
  files: new Set<string>(
    JSON.parse(fs.readFileSync(join(repoRoot, config), 'utf8')).include.map((entry: string) =>
      resolve(repoRoot, entry)
    )
  )
})

describe('the exported modules in plugins/', () => {
  it('are listed in both tsconfigs and import only what Host and renderer can both load', () => {
    const includes = [includesOf('tsconfig.plugin-exports.json'), includesOf('tsconfig.web.json')]
    expect(exportProblems(join(repoRoot, 'plugins'), includes)).toEqual([])
  })
})

describe('the export import check', () => {
  let pluginsDir = ''

  afterEach(() => fs.rmSync(pluginsDir, { recursive: true, force: true }))

  const fixture = (
    files: Record<string, string>,
    manifests: Record<string, ReadonlyArray<string>> = { org: ['domain.ts'] },
    listsExports = true
  ): ReadonlyArray<string> => {
    pluginsDir = fs.mkdtempSync(join(tmpdir(), 'dia-plugin-exports-'))
    for (const [plugin, exports] of Object.entries(manifests)) {
      fs.mkdirSync(join(pluginsDir, plugin), { recursive: true })
      fs.writeFileSync(
        join(pluginsDir, plugin, 'plugin.json'),
        JSON.stringify({ name: plugin, exports })
      )
    }
    for (const [file, source] of Object.entries(files)) {
      fs.mkdirSync(dirname(join(pluginsDir, file)), { recursive: true })
      fs.writeFileSync(join(pluginsDir, file), source)
    }
    const listed = listsExports
      ? Object.entries(manifests).flatMap(([plugin, exports]) =>
          exports.map((file) => resolve(pluginsDir, plugin, file))
        )
      : []
    return exportProblems(pluginsDir, [{ config: 'tsconfig.fixture.json', files: new Set(listed) }])
  }

  it('accepts effect, effect subpaths, @dia/plugin, listed exports and relative files in the plugin', () => {
    const problems = fixture(
      {
        'org/domain.ts': [
          "import { Schema } from 'effect'",
          "import type { Rpc } from 'effect/rpc'",
          "export { SessionId } from '@dia/plugin'",
          "export * from './ids'",
          "import { ReadGreeting } from '@dia-plugin/example/messages'"
        ].join('\n'),
        'org/ids.ts': "import { Brand } from 'effect'\n",
        'example/messages.ts': "import { Rpc } from 'effect/rpc'\n"
      },
      { org: ['domain.ts'], example: ['messages.ts'] }
    )
    expect(problems).toEqual([])
  })

  it('ignores an import inside a comment', () => {
    expect(
      fixture({ 'org/domain.ts': "// import React from 'react'\n/* import 'node:fs' */\n" })
    ).toEqual([])
  })

  it.each([
    ["import type { ReactNode } from 'react'", 'imports "react"'],
    ["import { readFileSync } from 'node:fs'", 'imports "node:fs"'],
    ["export { Pane } from '@shared/domain/pane'", 'imports "@shared/domain/pane"'],
    ["import '@dia/renderer-plugin'", 'imports "@dia/renderer-plugin"'],
    ["const lazy = import('react')", 'imports "react"'],
    ["const fs = require('node:fs')", 'uses require('],
    ['const lazy = import(name)', 'uses import() of a non-literal'],
    ['const here = import.meta.url', 'uses import.meta']
  ])('reports %s', (line, problem) => {
    expect(fixture({ 'org/domain.ts': `${line}\n` })).toEqual([`org/domain.ts: ${problem}`])
  })

  it('reports a forbidden import in a relative file the export imports, naming that file', () => {
    const problems = fixture({
      'org/domain.ts': "import { hire } from './calls/hire'\n",
      'org/calls/hire.ts': "import { join } from 'node:path'\n"
    })
    expect(problems).toEqual(['org/calls/hire.ts: imports "node:path"'])
  })

  it('reports a relative import that leaves the plugin', () => {
    const problems = fixture({
      'org/domain.ts': "import { shared } from '../shared'\n",
      'shared.ts': 'export const shared = 1\n'
    })
    expect(problems).toEqual(['org/domain.ts: "../shared" is not a .ts file in plugin "org"'])
  })

  it('reports a relative import of a file that is not .ts', () => {
    const problems = fixture({
      'org/domain.ts': "import { Card } from './card.tsx'\n",
      'org/card.tsx': 'export const Card = 1\n'
    })
    expect(problems).toEqual(['org/domain.ts: "./card.tsx" is not a .ts file in plugin "org"'])
  })

  it("reports an import of another plugin's file that it does not export", () => {
    const problems = fixture(
      {
        'org/domain.ts': "import { setup } from '@dia-plugin/example/host'\n",
        'example/host.ts': "import 'node:fs'\n"
      },
      { org: ['domain.ts'], example: [] }
    )
    expect(problems).toEqual([
      'org/domain.ts: Cannot import "@dia-plugin/example/host": plugin "example" does not export "host.ts"'
    ])
  })

  it("reports a forbidden import in another plugin's export that this export imports", () => {
    const problems = fixture(
      {
        'org/domain.ts': "import { ReadGreeting } from '@dia-plugin/example/messages'\n",
        'example/messages.ts': "import { createElement } from 'react'\n"
      },
      { org: ['domain.ts'], example: ['messages.ts'] }
    )
    expect(problems).toEqual(['example/messages.ts: imports "react"'])
  })

  it('reports an export missing from a tsconfig include', () => {
    const problems = fixture(
      { 'org/domain.ts': "import { Schema } from 'effect'\n" },
      undefined,
      false
    )
    expect(problems).toEqual(['org/domain.ts: not in tsconfig.fixture.json include'])
  })
})
