import type { BranchList } from '@dia-plugin/dia-git/calls'
import { describe, expect, it } from 'vitest'
import { baseChoices, headLabel, switchName, uncommittedText, worktreeBase } from './workspace-menu'

const list: BranchList = {
  head: { _tag: 'OnBranch', branch: 'topic' },
  defaultBase: 'origin/main',
  branches: [
    { name: 'topic', remote: null },
    { name: 'main', remote: null },
    { name: 'origin/main', remote: 'origin' },
    { name: 'origin/release', remote: 'origin' }
  ]
}

describe('headLabel', () => {
  it('names the checked-out branch', () => {
    expect(headLabel({ _tag: 'OnBranch', branch: 'main' })).toBe('main')
  })

  it('names a detached HEAD by its commit', () => {
    expect(headLabel({ _tag: 'DetachedHead', commit: '1a2b3c4' })).toBe('detached at 1a2b3c4')
  })
})

describe('baseChoices', () => {
  it('lists the default base, then remote branches, then local ones', () => {
    expect(baseChoices(list).map((branch) => branch.name)).toEqual([
      'origin/main',
      'origin/release',
      'topic',
      'main'
    ])
  })
})

describe('worktreeBase', () => {
  it("is the draft's chosen base when it has one", () => {
    expect(worktreeBase({ base: 'origin/release' }, list)).toBe('origin/release')
  })

  it("is the repository's default base when the draft chose none", () => {
    expect(worktreeBase({ base: null }, list)).toBe('origin/main')
  })

  it('is null while the branches are not read and the draft chose none', () => {
    expect(worktreeBase({ base: null }, undefined)).toBeNull()
  })
})

describe('switchName', () => {
  it('drops the remote from a remote branch so git switch creates the local branch', () => {
    expect(switchName({ name: 'origin/feature/login', remote: 'origin' })).toBe('feature/login')
  })

  it('keeps a local branch name as it is', () => {
    expect(switchName({ name: 'feature/login', remote: null })).toBe('feature/login')
  })
})

describe('uncommittedText', () => {
  it('names the branch with uncommitted changes', () => {
    expect(uncommittedText('main')).toBe(
      'main has uncommitted changes. Commit or stash them first, or turn on Worktree.'
    )
  })
})
