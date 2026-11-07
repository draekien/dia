import { describe, expect, it } from 'vitest'
import { HiredAgent, HireId, JobTitleId } from './domain'
import { type OrgNode, orgTree, reportsToChoices } from './org-tree'

const hireId = (n: number) =>
  HireId.make(`00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`)
const agent = (n: number, reportsTo: number | null, hiredAt = n) =>
  HiredAgent.make({
    id: hireId(n),
    jobTitleId: JobTitleId.make('00000000-0000-4000-8000-000000000100'),
    name: null,
    bypassOverride: null,
    reportsTo: reportsTo === null ? null : hireId(reportsTo),
    hiredAt
  })

interface Shape {
  readonly id: HireId
  readonly reports: ReadonlyArray<Shape>
}
const shape = (nodes: ReadonlyArray<OrgNode>): ReadonlyArray<Shape> =>
  nodes.map((node) => ({ id: node.agent.id, reports: shape(node.reports) }))
const leaf = (n: number): Shape => ({ id: hireId(n), reports: [] })

describe('orgTree', () => {
  it('has no nodes without hires', () => {
    expect(orgTree([])).toEqual([])
  })

  it('makes every agent that reports to the user a root, ordered by hiredAt', () => {
    expect(shape(orgTree([agent(2, null, 20), agent(1, null, 10)]))).toEqual([leaf(1), leaf(2)])
  })

  it('nests a three-level reporting chain', () => {
    const tree = orgTree([agent(3, 2), agent(1, null), agent(2, 1)])

    expect(shape(tree)).toEqual([
      { id: hireId(1), reports: [{ id: hireId(2), reports: [leaf(3)] }] }
    ])
  })

  it('shows an agent whose manager is not in the list as a root', () => {
    expect(shape(orgTree([agent(1, 9)]))).toEqual([leaf(1)])
  })

  it('keeps the snapshot order of agents hired at the same time', () => {
    expect(shape(orgTree([agent(2, null, 5), agent(1, null, 5)]))).toEqual([leaf(2), leaf(1)])
  })
})

describe('reportsToChoices', () => {
  it('leaves out the agent and every agent below it, and keeps other branches', () => {
    const agents = [agent(1, null), agent(2, 1), agent(3, 2), agent(4, null), agent(5, 4)]

    expect(reportsToChoices(agents, hireId(1)).map((choice) => choice.id)).toEqual([
      hireId(4),
      hireId(5)
    ])
  })

  it('offers a mid-chain agent its own manager and the other branches', () => {
    const agents = [agent(1, null), agent(2, 1), agent(3, 2), agent(4, null)]

    expect(reportsToChoices(agents, hireId(2)).map((choice) => choice.id)).toEqual([
      hireId(1),
      hireId(4)
    ])
  })
})
