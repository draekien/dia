import { describe, expect, it } from 'vitest'
import { findSecretRule } from './secret-rules'

const KEY_BODY = 'Zq8Xw2Lm4Np6Rt0Vb3Hk7Jd9Sf1Gc5Ty'
const repeatTo = (length: number) =>
  KEY_BODY.repeat(Math.ceil(length / KEY_BODY.length)).slice(0, length)

const SECRETS: ReadonlyArray<readonly [string, string]> = [
  ['anthropic-key', `ANTHROPIC_API_KEY=${['sk', 'ant', 'api03', repeatTo(93)].join('-')}AA`],
  ['anthropic-key', `token ${['sk', 'ant', 'oat01', repeatTo(40)].join('-')}`],
  ['openai-key', `OPENAI=${['sk', 'proj', repeatTo(74)].join('-')}`],
  ['github-token', `remote uses ${['ghp', repeatTo(36)].join('_')}`],
  ['github-token', `${['github', 'pat', repeatTo(82)].join('_')}`],
  ['aws-access-key', `aws_access_key_id = ${['AKIA', 'QYLPMN5HHHFUVHZS'].join('')}`],
  ['private-key', ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' ')],
  ['private-key', ['-----BEGIN', 'OPENSSH PRIVATE KEY-----'].join(' ')],
  ['slack-token', ['xoxb', '1234567890', '1234567890123', 'abcDEF'].join('-')],
  ['google-api-key', ['AIza', repeatTo(35)].join('')],
  ['stripe-key', ['sk', 'live', repeatTo(24)].join('_')],
  ['npm-token', ['npm', repeatTo(36)].join('_')],
  ['jwt', `Bearer ey${repeatTo(20)}.ey${repeatTo(20)}.${repeatTo(20)}`],
  ['generic-secret', `db_password = "${repeatTo(24)}"`],
  ['generic-secret', `"apiKey": "${repeatTo(32)}"`]
]

describe('findSecretRule', () => {
  it.each(SECRETS)('reports a line with a secret under %s', (rule, line) => {
    expect(findSecretRule(line)?.id).toBe(rule)
  })

  it.each([
    ['a line of prose', 'Prefer the Read tool over cat when reading files.'],
    ['an environment variable reference', 'token: process.env.GITHUB_TOKEN'],
    ['a low-entropy value', 'password = "aaaaaaaa11111111"'],
    ['a value without a digit', 'secret = "correcthorsebatterystaple"'],
    ['a value shorter than 16 characters', 'api_key = "Zq8Xw2Lm4Np6"'],
    ['a GitHub prefix with too few characters', `${['ghp', repeatTo(20)].join('_')}`],
    ['a public key header', ['-----BEGIN', 'PUBLIC KEY-----'].join(' ')]
  ])('does not report %s', (_, line) => {
    expect(findSecretRule(line)).toBeUndefined()
  })
})
