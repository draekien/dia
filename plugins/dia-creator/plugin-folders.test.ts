import type { PluginInfo } from '@dia/plugin'
import { assert, describe, it } from '@effect/vitest'
import { Option } from 'effect'
import { joinInside, overridesInside, pluginsTouched, relativeInside } from './plugin-folders'

const plugin = (name: string, root: string, origin: PluginInfo['origin']): PluginInfo => ({
  name,
  category: 'feature',
  origin,
  root,
  status: { _tag: 'Loaded' },
  memoryBytes: 0,
  provides: []
})

const change = (path: string) => ({ path, added: 1, deleted: 0, binary: false })

describe('relativeInside', () => {
  it('gives the forward-slash path of a folder inside, ignoring separators and case', () => {
    assert.deepStrictEqual(
      relativeInside('C:\\Trees\\creator', 'c:/trees/creator/plugins/clock'),
      Option.some('plugins/clock')
    )
  })

  it('refuses a sibling folder that only shares a name prefix', () => {
    assert.deepStrictEqual(
      relativeInside('C:/trees/creator', 'C:/trees/creator-2/x'),
      Option.none()
    )
  })
})

describe('joinInside', () => {
  it('joins with the separator the directory is written with', () => {
    assert.strictEqual(joinInside('C:\\meta', 'plugins/clock'), 'C:\\meta\\plugins\\clock')
    assert.strictEqual(joinInside('/home/meta/', 'plugins/clock'), '/home/meta/plugins/clock')
  })
})

describe('pluginsTouched', () => {
  it('names the plugins inside the directory whose folder holds a changed file', () => {
    const list = [
      plugin('clock', 'C:/trees/creator/plugins/clock', 'override'),
      plugin('clockwork', 'C:/trees/creator/plugins/clockwork', 'override'),
      plugin('chat', 'C:/app/plugins/clock', 'default')
    ]

    assert.deepStrictEqual(
      pluginsTouched(list, 'C:/trees/creator', [change('plugins/clock/host.ts')]),
      ['clock']
    )
  })
})

describe('overridesInside', () => {
  it('lists only overrides inside the directory, with their folder', () => {
    const list = [
      plugin('clock', 'C:/trees/creator/plugins/clock', 'override'),
      plugin('timer', 'C:/trees/creator/plugins/timer', 'default'),
      plugin('chat', 'C:/elsewhere/chat', 'override')
    ]

    assert.deepStrictEqual(overridesInside(list, 'C:/trees/creator'), [
      { name: 'clock', folder: 'plugins/clock' }
    ])
  })
})
