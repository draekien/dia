import { describe, expect, it } from 'vitest'
import { mergeReferencePages } from './plugin-api-reference'

const main = [
  '# dia',
  '',
  '## Namespaces',
  '',
  '- [AgentEvents](dia/namespaces/AgentEvents.md)',
  '',
  '## Variables',
  '',
  '### MetaRepoKey',
  '',
  'The key the `meta` plugin provides its MetaRepo under.',
  ''
].join('\n')

const agentEvents = [
  '# AgentEvents',
  '',
  '## Type Aliases',
  '',
  '### AgentArchived',
  '',
  '```ts',
  '# not a heading',
  '```',
  ''
].join('\n')

describe('mergeReferencePages', () => {
  it('replaces the module title with the reference title', () => {
    const merged = mergeReferencePages('0.0.35', main, [])

    expect(merged.startsWith('# @dia/plugin API reference\n')).toBe(true)
    expect(merged).not.toContain('# dia\n')
  })

  it('states the plugin API version of the build under the title', () => {
    const merged = mergeReferencePages('1.2.3', main, [])

    expect(merged).toContain('This dia implements plugin API version `1.2.3`.')
  })

  it('keeps every export heading and its JSDoc from the module page', () => {
    const merged = mergeReferencePages('0.0.35', main, [])

    expect(merged).toContain(
      '### MetaRepoKey\n\nThe key the `meta` plugin provides its MetaRepo under.'
    )
  })

  it('appends a namespace page as a section one heading level below its name', () => {
    const merged = mergeReferencePages('0.0.35', main, [
      { name: 'AgentEvents', markdown: agentEvents }
    ])

    expect(merged).toContain('## AgentEvents\n\n### Type Aliases\n\n#### AgentArchived')
  })

  it('leaves lines inside a code fence of a namespace page unchanged', () => {
    const merged = mergeReferencePages('0.0.35', main, [
      { name: 'AgentEvents', markdown: agentEvents }
    ])

    expect(merged).toContain('```ts\n# not a heading\n```')
  })

  it('points a link to a namespace page at that namespace section', () => {
    const merged = mergeReferencePages('0.0.35', main, [
      { name: 'AgentEvents', markdown: agentEvents }
    ])

    expect(merged).toContain('- [AgentEvents](#agentevents)')
    expect(merged).not.toContain('.md)')
  })

  it('leaves a link to a markdown file on another site unchanged', () => {
    const external =
      '# Attention\n\nSee [ADR-0032](https://github.com/draekien/dia/blob/main/docs/adr/0032.md).'

    const merged = mergeReferencePages('0.0.35', main, [{ name: 'Attention', markdown: external }])

    expect(merged).toContain('(https://github.com/draekien/dia/blob/main/docs/adr/0032.md)')
  })

  it('points a link to a heading on another page at that heading in the merged document', () => {
    const linking =
      '# Attention\n\nSee [AgentEvent](../../README.md#agentevent) and [Pane](PaneEvents.md#panesignal-1).'

    const merged = mergeReferencePages('0.0.35', main, [{ name: 'Attention', markdown: linking }])

    expect(merged).toContain('See [AgentEvent](#agentevent) and [Pane](#panesignal-1).')
  })

  it('orders namespace sections by name whatever order the pages arrive in', () => {
    const pages = [
      { name: 'Zeta', markdown: '# Zeta\n\nlast' },
      { name: 'Alpha', markdown: '# Alpha\n\nfirst' }
    ]

    expect(mergeReferencePages('0.0.35', main, pages)).toBe(
      mergeReferencePages('0.0.35', main, [...pages].reverse())
    )
    expect(mergeReferencePages('0.0.35', main, pages).indexOf('## Alpha')).toBeLessThan(
      mergeReferencePages('0.0.35', main, pages).indexOf('## Zeta')
    )
  })
})
