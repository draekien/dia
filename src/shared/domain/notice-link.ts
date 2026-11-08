import { Schema } from 'effect'
import { PluginName } from '../plugin/manifest'

/**
 * A link a transcript notice carries (ADR-0071): a button labelled `label` that opens page `page`
 * of plugin `plugin` with `target`, which the page reads to choose what it shows (for the org
 * page, an objective id).
 */
export const NoticeLink = Schema.Struct({
  label: Schema.NonEmptyString,
  plugin: PluginName,
  page: Schema.String,
  target: Schema.String
})
export type NoticeLink = typeof NoticeLink.Type
