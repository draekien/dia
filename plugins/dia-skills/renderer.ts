import type { PluginServices, PluginSetup } from '@dia/plugin'
import { Effect } from 'effect'
import { createElement } from 'react'
import { SkillPickerKey, type SkillPickerProps } from './picker'
import { makeSkillsFamily, SkillPicker } from './skill-picker'

const setup: PluginSetup<PluginServices> = (ctx) =>
  Effect.gen(function* () {
    const skillsFamily = makeSkillsFamily(ctx)
    yield* ctx.provide(SkillPickerKey, (props: SkillPickerProps) =>
      createElement(SkillPicker, { ...props, skillsFamily })
    )
    yield* Effect.logDebug('Skill picker provided', { key: SkillPickerKey.name })
  })

export default setup
