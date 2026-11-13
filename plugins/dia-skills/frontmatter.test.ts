import { assert, describe, it } from '@effect/vitest'
import { Option } from 'effect'
import { readFrontmatter } from './frontmatter'

const description = (text: string) =>
  Option.flatMap(readFrontmatter(text), (fields) => fields.description)

describe('readFrontmatter', () => {
  it('reads a plain name and description', () => {
    const text = '---\nname: review\ndescription: Reviews a diff\n---\nbody'

    assert.deepStrictEqual(
      readFrontmatter(text),
      Option.some({ name: Option.some('review'), description: Option.some('Reviews a diff') })
    )
  })

  it('reads the same fields from CRLF line endings', () => {
    const text = '---\r\nname: review\r\ndescription: Reviews a diff\r\n---\r\nbody'

    assert.deepStrictEqual(
      readFrontmatter(text),
      Option.some({ name: Option.some('review'), description: Option.some('Reviews a diff') })
    )
  })

  it('reads the fields after a byte order mark', () => {
    const text = '﻿---\nname: review\n---\n'

    assert.deepStrictEqual(
      Option.flatMap(readFrontmatter(text), (fields) => fields.name),
      Option.some('review')
    )
  })

  it('unescapes a double-quoted description', () => {
    assert.deepStrictEqual(
      description('---\ndescription: "Use \\"this\\": now"\n---\n'),
      Option.some('Use "this": now')
    )
  })

  it('unescapes a doubled quote in a single-quoted description', () => {
    assert.deepStrictEqual(
      description("---\ndescription: 'It''s here'\n---\n"),
      Option.some("It's here")
    )
  })

  it('folds a > block into one line with a trailing newline', () => {
    assert.deepStrictEqual(
      description('---\ndescription: >\n  Reviews a\n  diff\nname: review\n---\n'),
      Option.some('Reviews a diff\n')
    )
  })

  it('folds a >- block without the trailing newline', () => {
    assert.deepStrictEqual(
      description('---\ndescription: >-\n  Reviews a\n  diff\n---\n'),
      Option.some('Reviews a diff')
    )
  })

  it('keeps the line breaks of a | block', () => {
    assert.deepStrictEqual(
      description('---\ndescription: |\n  first\n  second\n---\n'),
      Option.some('first\nsecond\n')
    )
  })

  it('joins the continuation lines of a plain description', () => {
    assert.deepStrictEqual(
      description('---\ndescription: Reviews a\n  diff carefully\n---\n'),
      Option.some('Reviews a diff carefully')
    )
  })

  it('leaves a field the frontmatter lacks empty', () => {
    assert.deepStrictEqual(
      readFrontmatter('---\nname: review\n---\n'),
      Option.some({ name: Option.some('review'), description: Option.none() })
    )
  })

  it('reads nothing from a file without frontmatter', () => {
    assert.deepStrictEqual(readFrontmatter('# review\n'), Option.none())
  })

  it('reads nothing from frontmatter that is never closed', () => {
    assert.deepStrictEqual(readFrontmatter('---\nname: review\n'), Option.none())
  })
})
