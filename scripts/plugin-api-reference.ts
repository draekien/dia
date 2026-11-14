/** A page typedoc-plugin-markdown wrote for one namespace export, such as `AgentEvents`. */
export interface NamespacePage {
  readonly name: string
  readonly markdown: string
}

const NAMESPACE_LINK = /\]\((?:[^)\s]*\/)?namespaces\/([^)/\s]+)\.md\)/g

const TITLE = '# @dia/plugin API reference'

const notice = (apiVersion: string): string =>
  [
    'Generated from the JSDoc of `src/host/plugin-api.ts` when dia is built. dia rewrites this file when the installed dia exports a different API, so an edit to it is lost.',
    `This dia implements plugin API version \`${apiVersion}\`. Set \`"api"\` in \`plugin.json\` to it.`
  ].join('\n\n')

const withoutTitle = (markdown: string): string => markdown.replace(/^# [^\n]*\n+/, '')

const demoteHeadings = (markdown: string): string => {
  let fenced = false
  return markdown
    .split('\n')
    .map((line) => {
      if (line.startsWith('```')) fenced = !fenced
      return !fenced && /^#+ /.test(line) ? `#${line}` : line
    })
    .join('\n')
}

/**
 * Merges the pages typedoc-plugin-markdown writes for `@dia/plugin` (its `--router module`
 * output) into the one markdown document the `building-dia-plugins` skill ships as
 * `references/api.md`. `apiVersion` is the `PLUGIN_API_VERSION` of the build, stated under the
 * title. `main` is the module page; each namespace page is appended as a section
 * headed by its name, and links from `main` to a namespace page become links to that section.
 * The result depends only on the inputs, so an unchanged API gives an identical document.
 */
export const mergeReferencePages = (
  apiVersion: string,
  main: string,
  namespaces: ReadonlyArray<NamespacePage>
): string => {
  const sections = [...namespaces]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((page) => `## ${page.name}\n\n${demoteHeadings(withoutTitle(page.markdown)).trim()}`)
  const body = withoutTitle(main).replace(
    NAMESPACE_LINK,
    (_link, name: string) => `](#${name.toLowerCase()})`
  )
  return `${[TITLE, notice(apiVersion), body.trim(), ...sections].join('\n\n')}\n`
}
