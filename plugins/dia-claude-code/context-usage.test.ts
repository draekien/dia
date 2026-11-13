import type { SDKControlGetContextUsageResponse } from '@anthropic-ai/claude-agent-sdk'
import { ContextUsage } from '@shared/domain/context-usage'
import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import { toContextUsage } from './context-usage'

const response = (
  fields: Partial<SDKControlGetContextUsageResponse>
): SDKControlGetContextUsageResponse =>
  ({
    totalTokens: 37_410,
    maxTokens: 400_000,
    percentage: 9,
    autoCompactThreshold: 367_000,
    isAutoCompactEnabled: true,
    ...fields
  }) as SDKControlGetContextUsageResponse

describe('toContextUsage', () => {
  it('keeps the token counts and the threshold while auto-compact is on', () => {
    expect(toContextUsage(response({}))).toEqual({
      totalTokens: 37_410,
      maxTokens: 400_000,
      autoCompactThreshold: 367_000
    })
  })

  it('drops the threshold while auto-compact is off', () => {
    expect(toContextUsage(response({ isAutoCompactEnabled: false }))).toEqual({
      totalTokens: 37_410,
      maxTokens: 400_000
    })
  })

  it('leaves the threshold out when the SDK reports none', () => {
    expect(toContextUsage(response({ autoCompactThreshold: undefined }))).not.toHaveProperty(
      'autoCompactThreshold'
    )
  })
})

describe('ContextUsage', () => {
  it('rejects a negative token count', () => {
    expect(
      Schema.decodeUnknownExit(ContextUsage)({ totalTokens: -1, maxTokens: 400_000 })._tag
    ).toBe('Failure')
  })

  it('rejects a fractional token count', () => {
    expect(
      Schema.decodeUnknownExit(ContextUsage)({ totalTokens: 1.5, maxTokens: 400_000 })._tag
    ).toBe('Failure')
  })
})
