import { AgentName } from '@dia/plugin'
import { NodeFileSystem, NodePath } from '@effect/platform-node'
import * as NodeCrypto from '@effect/platform-node/NodeCrypto'
import { assert, describe, it } from '@effect/vitest'
import { Duration, Effect, Exit, FileSystem, Layer, Path, Scope } from 'effect'
import { SqlClient } from 'effect/sql'
import { TestClock } from 'effect/testing'
import { openDatabase } from '../../src/host/services/database'
import { HireId, OverallCap, type Role, RoleId, RoleName } from './domain'
import { orgMigrations } from './migrations'
import { makeOrg } from './org'

const openOrgIn = (filename: string) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make()
    const sql = yield* openDatabase(filename, orgMigrations).pipe(Scope.provide(scope))
    const org = yield* makeOrg.pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.provide(NodeCrypto.layer)
    )
    return { org, close: Scope.close(scope, Exit.void) }
  })

const freshOrg = Effect.map(openOrgIn(':memory:'), ({ org }) => org)

const roleNamed = (roles: ReadonlyArray<Role>, name: string): Role => {
  const role = roles.find((candidate) => candidate.name === name)
  assert.isDefined(role, `no role named ${name}`)
  return role as Role
}

const builtIn = (name: string) =>
  Effect.gen(function* () {
    const org = yield* freshOrg
    return { org, role: roleNamed(yield* org.roles, name) }
  })

const UNKNOWN_ROLE = RoleId.make('00000000-0000-4000-8000-000000000000')

describe('org seed', () => {
  it.effect('lists the five built-in roles in seed order, enabled, named after their kind', () =>
    Effect.gen(function* () {
      const org = yield* freshOrg
      const roles = yield* org.roles
      assert.deepStrictEqual(
        roles.map((role) => [role.name, role.builtIn, role.enabled]),
        [
          ['planner', 'planner', true],
          ['engineer', 'engineer', true],
          ['reviewer', 'reviewer', true],
          ['researcher', 'researcher', true],
          ['retro', 'retro', true]
        ]
      )
    })
  )

  it.effect('denies file edits to read-only roles and only Edit and NotebookEdit to retro', () =>
    Effect.gen(function* () {
      const org = yield* freshOrg
      const roles = yield* org.roles
      assert.deepStrictEqual(
        roles.map((role): [string, ReadonlyArray<string>] => [role.name, role.permissions.deny]),
        [
          ['planner', ['Edit', 'Write', 'NotebookEdit']],
          ['engineer', []],
          ['reviewer', ['Edit', 'Write', 'NotebookEdit']],
          ['researcher', ['Edit', 'Write', 'NotebookEdit']],
          ['retro', ['Edit', 'NotebookEdit']]
        ]
      )
    })
  )

  it.effect('gives every built-in role no skills, MCP servers, allow or ask rules, or bypass', () =>
    Effect.gen(function* () {
      const org = yield* freshOrg
      for (const role of yield* org.roles) {
        assert.deepStrictEqual(
          [
            role.skills,
            role.mcpServers,
            role.permissions.allow,
            role.permissions.ask,
            role.bypassOptIn
          ],
          [[], {}, [], [], false],
          role.name
        )
      }
    })
  )

  it.effect('appends the execution contract to every built-in role', () =>
    Effect.gen(function* () {
      const org = yield* freshOrg
      for (const role of yield* org.roles) {
        assert.include(role.instructions, '## Execution contract', role.name)
      }
    })
  )

  it.effect('hires one unnamed retro with no bypass override', () =>
    Effect.gen(function* () {
      const org = yield* freshOrg
      const retro = roleNamed(yield* org.roles, 'retro')
      const hires = yield* org.hiredAgents
      assert.deepStrictEqual(
        hires.map((hire) => [hire.roleId, hire.name, hire.bypassOverride]),
        [[retro.id, null, null]]
      )
    })
  )

  it.effect('starts with an overall cap of 4', () =>
    Effect.gen(function* () {
      const org = yield* freshOrg
      assert.strictEqual((yield* org.settings).overallCap, 4)
    })
  )

  it.effect('does not hire the first retro again after it is dismissed and the org reopens', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const filename = path.join(yield* fs.makeTempDirectoryScoped(), 'data.db')
      const first = yield* openOrgIn(filename)
      for (const hire of yield* first.org.hiredAgents) {
        yield* first.org.dismiss(hire.id)
      }
      yield* first.close

      const second = yield* openOrgIn(filename)
      const hires = yield* second.org.hiredAgents
      yield* second.close
      assert.deepStrictEqual(hires, [])
    }).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)))
  )
})

describe('Org.setRoleEnabled', () => {
  it.effect('disables a role and lists it disabled', () =>
    Effect.gen(function* () {
      const { org, role } = yield* builtIn('reviewer')
      const changed = yield* org.setRoleEnabled(role.id, false)
      assert.isFalse(changed.enabled)
      assert.isFalse(roleNamed(yield* org.roles, 'reviewer').enabled)
    })
  )

  it.effect('fails with RoleNotFound for an unknown role', () =>
    Effect.gen(function* () {
      const org = yield* freshOrg
      const error = yield* Effect.flip(org.setRoleEnabled(UNKNOWN_ROLE, false))
      assert.strictEqual(error._tag, 'RoleNotFound')
    })
  )
})

describe('Org.copyRole', () => {
  it.effect('copies every field except id, name and builtIn, and lists the copy last', () =>
    Effect.gen(function* () {
      const { org, role } = yield* builtIn('reviewer')
      const copy = yield* org.copyRole(role.id, RoleName.make('strict reviewer'))
      assert.notStrictEqual(copy.id, role.id)
      assert.deepStrictEqual(copy, {
        ...role,
        id: copy.id,
        name: RoleName.make('strict reviewer'),
        builtIn: null
      })
      const roles = yield* org.roles
      assert.deepStrictEqual(roles.at(-1), copy)
    })
  )

  it.effect('makes the copy of a disabled role enabled', () =>
    Effect.gen(function* () {
      const { org, role } = yield* builtIn('reviewer')
      yield* org.setRoleEnabled(role.id, false)
      const copy = yield* org.copyRole(role.id, RoleName.make('strict reviewer'))
      assert.isTrue(copy.enabled)
    })
  )

  it.effect('fails with RoleNameTaken for an existing name in another case', () =>
    Effect.gen(function* () {
      const { org, role } = yield* builtIn('reviewer')
      const error = yield* Effect.flip(org.copyRole(role.id, RoleName.make('Engineer')))
      assert.deepStrictEqual([error._tag, (yield* org.roles).length], ['RoleNameTaken', 5])
    })
  )

  it.effect('fails with RoleNotFound for an unknown role', () =>
    Effect.gen(function* () {
      const org = yield* freshOrg
      const error = yield* Effect.flip(org.copyRole(UNKNOWN_ROLE, RoleName.make('ghost')))
      assert.strictEqual(error._tag, 'RoleNotFound')
    })
  )
})

describe('Org.editRole', () => {
  it.effect('applies the present fields and keeps the absent ones', () =>
    Effect.gen(function* () {
      const { org, role } = yield* builtIn('engineer')
      const permissions = { allow: ['Bash(pnpm test)'], ask: ['Bash(git push:*)'], deny: [] }
      const edited = yield* org.editRole(role.id, { permissions, skills: ['tdd'] })
      assert.deepStrictEqual(edited, { ...role, permissions, skills: ['tdd'] })
      assert.deepStrictEqual(roleNamed(yield* org.roles, 'engineer'), edited)
    })
  )

  it.effect('keeps the id, builtIn and enabled of the role when the edit is a whole role', () =>
    Effect.gen(function* () {
      const { org, role: planner } = yield* builtIn('planner')
      yield* org.setRoleEnabled(planner.id, false)
      const copy = yield* org.copyRole(planner.id, RoleName.make('builder'))
      const disabledPlanner = roleNamed(yield* org.roles, 'planner')
      const edited = yield* org.editRole(copy.id, { ...disabledPlanner, name: copy.name })
      assert.deepStrictEqual([edited.id, edited.builtIn, edited.enabled], [copy.id, null, true])
      assert.deepStrictEqual(roleNamed(yield* org.roles, 'builder'), edited)
    })
  )

  it.effect('refuses to rename a built-in role', () =>
    Effect.gen(function* () {
      const { org, role } = yield* builtIn('engineer')
      const error = yield* Effect.flip(org.editRole(role.id, { name: RoleName.make('builder') }))
      assert.strictEqual(error._tag, 'BuiltInRoleRenamed')
    })
  )

  it.effect('accepts a built-in role edit that repeats its current name', () =>
    Effect.gen(function* () {
      const { org, role } = yield* builtIn('engineer')
      const edited = yield* org.editRole(role.id, { name: role.name, bypassOptIn: true })
      assert.isTrue(edited.bypassOptIn)
    })
  )

  it.effect('lets a copy change the case of its own name', () =>
    Effect.gen(function* () {
      const { org, role } = yield* builtIn('engineer')
      const copy = yield* org.copyRole(role.id, RoleName.make('builder'))
      const edited = yield* org.editRole(copy.id, { name: RoleName.make('Builder') })
      assert.strictEqual(edited.name, 'Builder')
    })
  )

  it.effect("fails with RoleNameTaken when a copy takes another role's name in another case", () =>
    Effect.gen(function* () {
      const { org, role } = yield* builtIn('engineer')
      const copy = yield* org.copyRole(role.id, RoleName.make('builder'))
      const error = yield* Effect.flip(org.editRole(copy.id, { name: RoleName.make('PLANNER') }))
      assert.strictEqual(error._tag, 'RoleNameTaken')
    })
  )
})

describe('Org.deleteRole', () => {
  it.effect('deletes a copy with no hires', () =>
    Effect.gen(function* () {
      const { org, role } = yield* builtIn('engineer')
      const copy = yield* org.copyRole(role.id, RoleName.make('builder'))
      yield* org.deleteRole(copy.id)
      assert.notInclude(
        (yield* org.roles).map((listed) => listed.id),
        copy.id
      )
    })
  )

  it.effect('refuses to delete a built-in role', () =>
    Effect.gen(function* () {
      const { org, role } = yield* builtIn('planner')
      const error = yield* Effect.flip(org.deleteRole(role.id))
      assert.strictEqual(error._tag, 'BuiltInRoleDeleted')
    })
  )

  it.effect('refuses to delete a copy with hires and reports how many', () =>
    Effect.gen(function* () {
      const { org, role } = yield* builtIn('engineer')
      const copy = yield* org.copyRole(role.id, RoleName.make('builder'))
      yield* org.hire(copy.id, null)
      yield* org.hire(copy.id, null)
      const error = yield* Effect.flip(org.deleteRole(copy.id))
      assert.deepStrictEqual(
        [error._tag, error._tag === 'RoleHasHires' ? error.hires : undefined],
        ['RoleHasHires', 2]
      )
    })
  )
})

describe('Org.hire', () => {
  it.effect('hires a named agent at the current time', () =>
    Effect.gen(function* () {
      const { org, role } = yield* builtIn('engineer')
      yield* TestClock.adjust(Duration.seconds(5))
      const hired = yield* org.hire(role.id, AgentName.make('Ada'))
      assert.deepStrictEqual(
        [hired.roleId, hired.name, hired.bypassOverride, hired.hiredAt],
        [role.id, 'Ada', null, Duration.toMillis(Duration.seconds(5))]
      )
    })
  )

  it.effect('lists hires by hire time, then by creation order', () =>
    Effect.gen(function* () {
      const { org, role } = yield* builtIn('engineer')
      yield* TestClock.adjust(Duration.seconds(1))
      const first = yield* org.hire(role.id, null)
      const second = yield* org.hire(role.id, null)
      const ids = (yield* org.hiredAgents).map((hire) => hire.id)
      assert.deepStrictEqual(ids.slice(1), [first.id, second.id])
    })
  )

  it.effect('fails with HireNameTaken for a hired name in another case', () =>
    Effect.gen(function* () {
      const { org, role } = yield* builtIn('engineer')
      yield* org.hire(role.id, AgentName.make('Ada'))
      const error = yield* Effect.flip(org.hire(role.id, AgentName.make('ADA')))
      assert.strictEqual(error._tag, 'HireNameTaken')
    })
  )

  it.effect('fails with RoleDisabled for a disabled role', () =>
    Effect.gen(function* () {
      const { org, role } = yield* builtIn('engineer')
      yield* org.setRoleEnabled(role.id, false)
      const error = yield* Effect.flip(org.hire(role.id, null))
      assert.deepStrictEqual([error._tag, (yield* org.hiredAgents).length], ['RoleDisabled', 1])
    })
  )

  it.effect('fails with RoleNotFound for an unknown role', () =>
    Effect.gen(function* () {
      const org = yield* freshOrg
      const error = yield* Effect.flip(org.hire(UNKNOWN_ROLE, null))
      assert.strictEqual(error._tag, 'RoleNotFound')
    })
  )
})

describe('Org.dismiss', () => {
  it.effect('removes the hired agent', () =>
    Effect.gen(function* () {
      const { org, role } = yield* builtIn('engineer')
      const hired = yield* org.hire(role.id, null)
      yield* org.dismiss(hired.id)
      assert.notInclude(
        (yield* org.hiredAgents).map((hire) => hire.id),
        hired.id
      )
    })
  )

  it.effect('fails with HireNotFound for an unknown hire', () =>
    Effect.gen(function* () {
      const org = yield* freshOrg
      const error = yield* Effect.flip(
        org.dismiss(HireId.make('00000000-0000-4000-8000-000000000000'))
      )
      assert.strictEqual(error._tag, 'HireNotFound')
    })
  )
})

describe('Org.setOverallCap', () => {
  it.effect('stores the new cap', () =>
    Effect.gen(function* () {
      const org = yield* freshOrg
      yield* org.setOverallCap(OverallCap.make(7))
      assert.strictEqual((yield* org.settings).overallCap, 7)
    })
  )
})
