import { type AgentName, PaneChat } from '@dia/plugin'
import type { AgentBackend } from '@dia-plugin/dia-agent-adapters/backend'
import {
  type AgentAdapter,
  TextGenerationFailed,
  type TextGenerationRequest
} from '@dia-plugin/dia-agent-adapters/registry'
import { Effect, Logger, Option } from 'effect'

/** One log line a test captured: its level and its message parts as JSON text. */
export interface CapturedLog {
  readonly level: string
  readonly text: string
}

/** A logger layer that records every log line; provide `layer` and read `logs`. */
export const captureLogs = () => {
  const logs: Array<CapturedLog> = []
  const logger = Logger.make(({ message, logLevel }) => {
    logs.push({
      level: logLevel,
      text: (Array.isArray(message) ? message : [message])
        .map((part) => JSON.stringify(part))
        .join(' ')
    })
  })
  return { logs, layer: Logger.layer([logger], { mergeWithExisting: false }) }
}

/** What a fake adapter's `generate` does with a request. */
export type Answer = (request: TextGenerationRequest) => Effect.Effect<string, TextGenerationFailed>

/** An adapter with text generation answering through `answer`; every request it receives is pushed to `requests`. */
export const adapterWithText = (
  id: string,
  defaultModel: string,
  answer: Answer,
  requests: Array<TextGenerationRequest> = []
): AgentAdapter => ({
  id,
  label: id,
  backend: {} as unknown as AgentBackend,
  textGeneration: Option.some({
    defaultModel,
    generate: (request) => {
      requests.push(request)
      return answer(request)
    }
  })
})

/** An adapter registered without text generation. */
export const adapterWithoutText = (id: string): AgentAdapter => ({
  id,
  label: id,
  backend: {} as unknown as AgentBackend,
  textGeneration: Option.none()
})

/** An answer that always succeeds with `text`. */
export const answering =
  (text: string): Answer =>
  () =>
    Effect.succeed(text)

/** An answer that always fails with `reason`. */
export const failing =
  (reason: string): Answer =>
  () =>
    Effect.fail(new TextGenerationFailed({ reason }))

/** A chat message of `role` holding one text part. */
export const messageOf = (
  id: string,
  role: 'user' | 'assistant',
  content: string
): PaneChat.PaneMessage => ({ id, role, parts: [{ type: 'text', content }] })

/** A chat snapshot holding `messages`. */
export const snapshotOf = (
  messages: ReadonlyArray<PaneChat.PaneMessage>
): PaneChat.PaneChatSnapshot => ({
  state: { ...PaneChat.emptyPaneChatState, messages },
  seq: messages.length
})

/** A workspace holding one tab `paneId` named `name`, owned by `owner` when given. */
export const workspaceWithTab = (paneId: string, name: AgentName | string, owner?: string) => ({
  projects: [
    {
      project: {
        projectId: '33333333-3333-4333-8333-333333333333',
        directory: '/repo',
        directoryKey: '/repo',
        displayName: 'repo',
        isGitRepo: false
      },
      tabs: [
        {
          name,
          config: {
            paneId,
            cwd: '/repo',
            model: 'm',
            thinkingLevel: 'adaptive' as const,
            permissionMode: 'default' as const
          },
          archived: false,
          ...(owner === undefined ? {} : { owner })
        }
      ]
    }
  ],
  visibleTab: null
})
