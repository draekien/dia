/**
 * One rule of the push scan (ADR-0047): `id` names it in a finding, `description` is the label
 * the Settings page shows, and `matches` says whether a line contains a secret of this kind.
 */
export interface SecretRule {
  readonly id: string
  readonly description: string
  readonly matches: (line: string) => boolean
}

const rule = (id: string, description: string, regex: RegExp): SecretRule => ({
  id,
  description,
  matches: (line) => regex.test(line)
})

const GENERIC_ASSIGNMENT =
  /(?:access|auth|api|credential|creds|key|passw(?:or)?d|pwd|secret|token)[\w.-]{0,20}["'`]?\s{0,3}(?::=|=>|=|:)\s{0,3}["'`]?([\w.=+/-]{16,})/gi

const MIN_GENERIC_ENTROPY = 3.5

const shannonEntropy = (value: string): number => {
  const counts = new Map<string, number>()
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1)
  let entropy = 0
  for (const count of counts.values()) {
    const share = count / value.length
    entropy -= share * Math.log2(share)
  }
  return entropy
}

const isGenericSecret = (value: string): boolean =>
  /[a-z]/i.test(value) && /\d/.test(value) && shannonEntropy(value) >= MIN_GENERIC_ENTROPY

const hasGenericSecret = (line: string): boolean =>
  Array.from(line.matchAll(GENERIC_ASSIGNMENT), (match) => match[1] ?? '').some(isGenericSecret)

/**
 * The rules the push scan applies to every added line and commit message line, adapted from
 * gitleaks' default configuration (MIT). The specific rules come first, so a line that matches one
 * of them and the generic rule is reported under the specific one.
 */
export const SECRET_RULES: ReadonlyArray<SecretRule> = [
  rule('anthropic-key', 'Anthropic API key or token', /\bsk-ant-[a-z]{2,10}\d{2}-[\w-]{20,}/),
  rule(
    'openai-key',
    'OpenAI API key',
    /\bsk-(?:(?:proj|svcacct|admin)-[\w-]{20,}|[a-zA-Z0-9]{20}T3BlbkFJ[a-zA-Z0-9]{20})/
  ),
  rule('github-token', 'GitHub token', /\b(?:gh[pousr]_[0-9a-zA-Z]{36}|github_pat_\w{82})/),
  rule(
    'aws-access-key',
    'AWS access key ID',
    /\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16}\b/
  ),
  rule('private-key', 'Private key', /-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----/i),
  rule('slack-token', 'Slack token', /\bxox[baprse]-[0-9a-zA-Z-]{10,}/),
  rule('google-api-key', 'Google API key', /\bAIza[\w-]{35}/),
  rule('stripe-key', 'Stripe secret key', /\b(?:sk|rk)_(?:test|live|prod)_[a-zA-Z0-9]{10,99}/),
  rule('npm-token', 'npm access token', /\bnpm_[a-zA-Z0-9]{36}/),
  rule(
    'jwt',
    'JSON Web Token',
    /\bey[a-zA-Z0-9]{17,}\.ey[a-zA-Z0-9/\\_-]{17,}\.[a-zA-Z0-9/\\_-]{10,}/
  ),
  {
    id: 'generic-secret',
    description: 'High-entropy value assigned to a key, token, secret or password',
    matches: hasGenericSecret
  }
]

/** The first rule in {@link SECRET_RULES} that `line` matches, or `undefined` when none does. */
export const findSecretRule = (line: string): SecretRule | undefined =>
  SECRET_RULES.find((candidate) => candidate.matches(line))
