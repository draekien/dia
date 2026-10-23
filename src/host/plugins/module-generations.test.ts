import { assert, describe, it } from '@effect/vitest'
import { ModuleGenerations } from './module-generations'

const entry = 'file:///plugin/entry.ts'
const left = 'file:///plugin/left.ts'
const right = 'file:///plugin/right.ts'
const leaf = 'file:///plugin/leaf.ts'

const linked = () => {
  const generations = new ModuleGenerations()
  generations.recordImport(entry, left)
  generations.recordImport(entry, right)
  generations.recordImport(left, leaf)
  return generations
}

describe('ModuleGenerations', () => {
  it('versions a module that was never invalidated with generation 0', () => {
    assert.strictEqual(new ModuleGenerations().versioned(leaf), `${leaf}?gen=0`)
  })

  it('invalidates a changed module and every module that imports it, and no other', () => {
    const generations = linked()

    const affected = generations.invalidate([leaf])

    assert.deepStrictEqual([...affected].sort(), [entry, left, leaf].sort())
    assert.strictEqual(generations.versioned(right), `${right}?gen=0`)
    assert.strictEqual(generations.versioned(leaf), `${leaf}?gen=1`)
    assert.strictEqual(generations.versioned(left), `${left}?gen=1`)
    assert.strictEqual(generations.versioned(entry), `${entry}?gen=1`)
  })

  it('does not invalidate the modules a changed module imports', () => {
    const generations = linked()

    const affected = generations.invalidate([left])

    assert.deepStrictEqual([...affected].sort(), [entry, left].sort())
    assert.strictEqual(generations.versioned(leaf), `${leaf}?gen=0`)
  })

  it('gives each invalidation a generation no module had before', () => {
    const generations = new ModuleGenerations()

    generations.invalidate([leaf])
    generations.invalidate([right])
    generations.invalidate([leaf])

    assert.strictEqual(generations.versioned(leaf), `${leaf}?gen=3`)
    assert.strictEqual(generations.versioned(right), `${right}?gen=2`)
  })

  it('invalidates through an import cycle once', () => {
    const generations = new ModuleGenerations()
    generations.recordImport(left, right)
    generations.recordImport(right, left)

    const affected = generations.invalidate([left])

    assert.deepStrictEqual([...affected].sort(), [left, right].sort())
  })

  it('returns no modules and keeps the counter for an empty change', () => {
    const generations = new ModuleGenerations()

    const affected = generations.invalidate([])
    generations.invalidate([leaf])

    assert.strictEqual(affected.size, 0)
    assert.strictEqual(generations.versioned(leaf), `${leaf}?gen=1`)
  })

  it('follows importer links recorded again after an invalidation', () => {
    const generations = linked()
    generations.invalidate([leaf])
    generations.recordImport(entry, left)
    generations.recordImport(left, leaf)

    const affected = generations.invalidate([leaf])

    assert.deepStrictEqual([...affected].sort(), [entry, left, leaf].sort())
  })

  it('does not follow an importer link dropped by an invalidation and not recorded again', () => {
    const generations = linked()
    generations.invalidate([leaf])

    const affected = generations.invalidate([leaf])

    assert.deepStrictEqual([...affected], [leaf])
  })

  describe('snapshot', () => {
    it('restores the generations and importer links of the moment it was taken', () => {
      const generations = linked()
      generations.invalidate([right])
      generations.recordImport(entry, left)
      generations.recordImport(entry, right)
      const restore = generations.snapshot()
      generations.invalidate([leaf])

      restore()

      assert.strictEqual(generations.versioned(leaf), `${leaf}?gen=0`)
      assert.strictEqual(generations.versioned(right), `${right}?gen=1`)
      assert.deepStrictEqual([...generations.invalidate([leaf])].sort(), [entry, left, leaf].sort())
    })

    it('never hands out a generation again after a restore', () => {
      const generations = new ModuleGenerations()
      const restore = generations.snapshot()
      generations.invalidate([leaf])
      restore()

      generations.invalidate([leaf])

      assert.strictEqual(generations.versioned(leaf), `${leaf}?gen=2`)
    })
  })
})
