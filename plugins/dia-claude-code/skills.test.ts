import type { SkillContext, SkillSource } from '@dia-plugin/dia-skills/registry'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { assert, describe, it } from '@effect/vitest'
import { Duration, Effect, FileSystem, Option, Path, Stream } from 'effect'
import { claudeCodeSources } from './skills'

const scratch = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = yield* fs.makeTempDirectoryScoped({ prefix: 'dia-claude-skills-' })
  const write = (file: string, text: string) =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(path.dirname(file), { recursive: true })
      yield* fs.writeFileString(file, text)
    })
  const writeSkill = (directory: string, entry: string, frontmatter = '') =>
    write(path.join(directory, entry, 'SKILL.md'), `---\n${frontmatter}\n---\n`)
  return { fs, path, root, home: path.join(root, 'home'), write, writeSkill }
})

const firstList = (sources: ReadonlyArray<SkillSource>, id: string, context: SkillContext) => {
  const source = sources.find((each) => each.id === id)
  if (source === undefined) return Effect.die(`no source ${id}`)
  return source
    .skills(context)
    .pipe(Stream.runHead, Effect.timeout(Duration.seconds(5)), Effect.map(Option.getOrThrow))
}

const names = (skills: ReadonlyArray<{ name: string; group: string }>) =>
  skills.map(({ name, group }) => ({ name, group }))

describe('claudeCodeSources', () => {
  it.effect('lists <home>/.claude/skills under "Your skills"', () =>
    Effect.gen(function* () {
      const { path, home, writeSkill } = yield* scratch
      yield* writeSkill(path.join(home, '.claude', 'skills'), 'review')
      const sources = yield* claudeCodeSources(home)

      const skills = yield* firstList(sources, 'claude-code/user', { cwd: Option.none() })

      assert.deepStrictEqual(names(skills), [{ name: 'review', group: 'Your skills' }])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  describe('claude-code/project', () => {
    it.effect('lists no skill without a cwd', () =>
      Effect.gen(function* () {
        const { home } = yield* scratch
        const sources = yield* claudeCodeSources(home)

        assert.deepStrictEqual(
          yield* firstList(sources, 'claude-code/project', { cwd: Option.none() }),
          []
        )
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
    )

    it.effect('lists the skills of the cwd and its parents up to the directory holding .git', () =>
      Effect.gen(function* () {
        const { fs, path, root, home, writeSkill } = yield* scratch
        const repo = path.join(root, 'repo')
        const cwd = path.join(repo, 'packages', 'app')
        yield* fs.makeDirectory(path.join(repo, '.git'), { recursive: true })
        yield* writeSkill(path.join(root, '.claude', 'skills'), 'outside-repo')
        yield* writeSkill(path.join(repo, '.claude', 'skills'), 'repo-skill')
        yield* writeSkill(path.join(cwd, '.claude', 'skills'), 'app-skill')
        const sources = yield* claudeCodeSources(home)

        const skills = yield* firstList(sources, 'claude-code/project', { cwd: Option.some(cwd) })

        assert.deepStrictEqual(
          [...names(skills)].sort((a, b) => a.name.localeCompare(b.name)),
          [
            { name: 'app-skill', group: 'Project' },
            { name: 'repo-skill', group: 'Project' }
          ]
        )
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
    )

    it.effect('lists a skill name found in the cwd and a parent once', () =>
      Effect.gen(function* () {
        const { fs, path, root, home, writeSkill } = yield* scratch
        const repo = path.join(root, 'repo')
        const cwd = path.join(repo, 'app')
        yield* fs.makeDirectory(path.join(repo, '.git'), { recursive: true })
        yield* writeSkill(path.join(repo, '.claude', 'skills'), 'review')
        yield* writeSkill(path.join(cwd, '.claude', 'skills'), 'review')
        const sources = yield* claudeCodeSources(home)

        const skills = yield* firstList(sources, 'claude-code/project', { cwd: Option.some(cwd) })

        assert.deepStrictEqual(names(skills), [{ name: 'review', group: 'Project' }])
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
    )

    it.effect('lists only the cwd when no parent holds .git', () =>
      Effect.gen(function* () {
        const { path, root, home, writeSkill } = yield* scratch
        const cwd = path.join(root, 'loose')
        yield* writeSkill(path.join(root, '.claude', 'skills'), 'parent-skill')
        yield* writeSkill(path.join(cwd, '.claude', 'skills'), 'loose-skill')
        const sources = yield* claudeCodeSources(home)

        const skills = yield* firstList(sources, 'claude-code/project', { cwd: Option.some(cwd) })

        assert.deepStrictEqual(names(skills), [{ name: 'loose-skill', group: 'Project' }])
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
    )
  })

  describe('claude-code/plugins', () => {
    const installedPlugins = (installs: Record<string, ReadonlyArray<object>>) =>
      JSON.stringify({ version: 2, plugins: installs })

    it.effect('lists only enabled installs that count for the context, as <plugin>:<skill>', () =>
      Effect.gen(function* () {
        const { path, root, home, write, writeSkill } = yield* scratch
        const enabledDir = path.join(root, 'cache', 'reviewing')
        const disabledDir = path.join(root, 'cache', 'disabled')
        const otherProjectDir = path.join(root, 'cache', 'elsewhere')
        yield* writeSkill(path.join(enabledDir, 'skills'), 'review')
        yield* writeSkill(path.join(disabledDir, 'skills'), 'off')
        yield* writeSkill(path.join(otherProjectDir, 'skills'), 'far')
        yield* write(
          path.join(home, '.claude', 'plugins', 'installed_plugins.json'),
          installedPlugins({
            'reviewing@market': [{ scope: 'user', installPath: enabledDir }],
            'disabled@market': [{ scope: 'user', installPath: disabledDir }],
            'elsewhere@market': [
              {
                scope: 'project',
                projectPath: path.join(root, 'other-project'),
                installPath: otherProjectDir
              }
            ]
          })
        )
        yield* write(
          path.join(home, '.claude', 'settings.json'),
          JSON.stringify({
            enabledPlugins: {
              'reviewing@market': true,
              'disabled@market': false,
              'elsewhere@market': true
            }
          })
        )
        const sources = yield* claudeCodeSources(home)

        const skills = yield* firstList(sources, 'claude-code/plugins', { cwd: Option.none() })

        assert.deepStrictEqual(names(skills), [
          { name: 'reviewing:review', group: 'Plugin › reviewing' }
        ])
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
    )

    it.effect('names a plugin by its manifest and lists a project install for that cwd', () =>
      Effect.gen(function* () {
        const { path, root, home, write, writeSkill } = yield* scratch
        const cwd = path.join(root, 'project')
        const installDir = path.join(root, 'cache', 'tools')
        yield* writeSkill(path.join(installDir, 'skills'), 'lint-dir', 'name: lint')
        yield* write(
          path.join(installDir, '.claude-plugin', 'plugin.json'),
          JSON.stringify({ name: 'house-tools' })
        )
        yield* write(
          path.join(home, '.claude', 'plugins', 'installed_plugins.json'),
          installedPlugins({
            'tools@market': [{ scope: 'local', projectPath: cwd, installPath: installDir }]
          })
        )
        yield* write(
          path.join(cwd, '.claude', 'settings.local.json'),
          JSON.stringify({ enabledPlugins: { 'tools@market': true } })
        )
        const sources = yield* claudeCodeSources(home)

        const skills = yield* firstList(sources, 'claude-code/plugins', { cwd: Option.some(cwd) })

        assert.deepStrictEqual(names(skills), [
          { name: 'house-tools:lint', group: 'Plugin › house-tools' }
        ])
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
    )

    it.effect("lets the project's settings disable a plugin the user settings enable", () =>
      Effect.gen(function* () {
        const { path, root, home, write, writeSkill } = yield* scratch
        const cwd = path.join(root, 'project')
        const installDir = path.join(root, 'cache', 'reviewing')
        yield* writeSkill(path.join(installDir, 'skills'), 'review')
        yield* write(
          path.join(home, '.claude', 'plugins', 'installed_plugins.json'),
          installedPlugins({ 'reviewing@market': [{ scope: 'user', installPath: installDir }] })
        )
        yield* write(
          path.join(home, '.claude', 'settings.json'),
          JSON.stringify({ enabledPlugins: { 'reviewing@market': true } })
        )
        yield* write(
          path.join(cwd, '.claude', 'settings.json'),
          JSON.stringify({ enabledPlugins: { 'reviewing@market': false } })
        )
        const sources = yield* claudeCodeSources(home)

        const skills = yield* firstList(sources, 'claude-code/plugins', { cwd: Option.some(cwd) })

        assert.deepStrictEqual(skills, [])
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
    )

    it.effect(
      'lists no plugin skill when installed_plugins.json is missing and settings.json is invalid',
      () =>
        Effect.gen(function* () {
          const { path, home, write } = yield* scratch
          yield* write(path.join(home, '.claude', 'settings.json'), '{ not json')
          const sources = yield* claudeCodeSources(home)

          const skills = yield* firstList(sources, 'claude-code/plugins', { cwd: Option.none() })

          assert.deepStrictEqual(skills, [])
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
    )
  })
})
