/**
 * One rule of the push scan (ADR-0047): `id` names it in a finding, `description` is the label
 * the Settings page shows, and `matches` says whether a line contains a secret of this kind.
 */
export interface SecretRule {
  readonly id: string
  readonly description: string
  readonly matches: (line: string) => boolean
}

const pattern =
  (regex: RegExp) =>
  (line: string): boolean =>
    regex.test(line)

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
  {
    id: 'anthropic-key',
    description: 'Anthropic API key or token',
    matches: pattern(/\bsk-ant-[a-z]{2,10}\d{2}-[\w-]{20,}/)
  },
  {
    id: 'openai-key',
    description: 'OpenAI API key',
    matches: pattern(
      /\bsk-(?:(?:proj|svcacct|admin)-[\w-]{20,}|[a-zA-Z0-9]{20}T3BlbkFJ[a-zA-Z0-9]{20})/
    )
  },
  {
    id: 'github-token',
    description: 'GitHub token',
    matches: pattern(/\b(?:gh[pousr]_[0-9a-zA-Z]{36}|github_pat_\w{82})/)
  },
  {
    id: 'aws-access-key',
    description: 'AWS access key ID',
    matches: pattern(/\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16}\b/)
  },
  {
    id: 'private-key',
    description: 'Private key',
    matches: pattern(/-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----/i)
  },
  {
    id: 'slack-token',
    description: 'Slack token',
    matches: pattern(/\bxox[baprse]-[0-9a-zA-Z-]{10,}/)
  },
  {
    id: 'google-api-key',
    description: 'Google API key',
    matches: pattern(/\bAIza[\w-]{35}/)
  },
  {
    id: 'stripe-key',
    description: 'Stripe secret key',
    matches: pattern(/\b(?:sk|rk)_(?:test|live|prod)_[a-zA-Z0-9]{10,99}/)
  },
  {
    id: 'npm-token',
    description: 'npm access token',
    matches: pattern(/\bnpm_[a-zA-Z0-9]{36}/)
  },
  {
    id: 'jwt',
    description: 'JSON Web Token',
    matches: pattern(/\bey[a-zA-Z0-9]{17,}\.ey[a-zA-Z0-9/\\_-]{17,}\.[a-zA-Z0-9/\\_-]{10,}/)
  },
  {
    id: 'generic-secret',
    description: 'High-entropy value assigned to a key, token, secret or password',
    matches: hasGenericSecret
  }
]

/** The first rule in {@link SECRET_RULES} that `line` matches, or `undefined` when none does. */
export const findSecretRule = (line: string): SecretRule | undefined =>
  SECRET_RULES.find((rule) => rule.matches(line))
