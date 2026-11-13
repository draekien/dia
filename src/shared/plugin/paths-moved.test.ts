import { Option } from 'effect'
import { describe, expect, it } from 'vitest'
import { relocatePath } from './paths-moved'

const windowsMove = {
  from: 'C:\\Users\\me\\AppData\\Roaming\\dia\\plugins\\claude-code',
  to: 'C:\\Users\\me\\AppData\\Roaming\\dia\\plugins\\dia-claude-code'
}
const posixMove = {
  from: '/home/me/.config/dia/plugins/worktrees',
  to: '/home/me/.config/dia/plugins/dia-worktrees'
}

describe('relocatePath', () => {
  it('moves the moved folder itself', () => {
    expect(relocatePath(windowsMove.from, windowsMove)).toEqual(Option.some(windowsMove.to))
  })

  it('moves a path under the folder and keeps the rest of it', () => {
    expect(relocatePath(`${posixMove.from}/trees/heron`, posixMove)).toEqual(
      Option.some(`${posixMove.to}/trees/heron`)
    )
  })

  it('moves a Windows path written with forward slashes under the folder', () => {
    expect(relocatePath(`${windowsMove.from}/x`, windowsMove)).toEqual(
      Option.some(`${windowsMove.to}/x`)
    )
  })

  it('leaves a sibling folder whose name starts with the moved name', () => {
    expect(relocatePath(`${windowsMove.from}-settings\\x`, windowsMove)).toEqual(Option.none())
  })

  it('leaves a path outside the folder', () => {
    expect(relocatePath('/home/me/projects/app', posixMove)).toEqual(Option.none())
  })

  it('ignores case on Windows paths', () => {
    expect(relocatePath(`${windowsMove.from.toLowerCase()}\\trees`, windowsMove)).toEqual(
      Option.some(`${windowsMove.to}\\trees`)
    )
  })

  it('compares case on POSIX paths', () => {
    expect(relocatePath(posixMove.from.toUpperCase(), posixMove)).toEqual(Option.none())
  })
})
