import type { AttachedSession } from '@shared/domain/attached-session'
import type { SessionId } from '@shared/domain/pane'
import type { HostPluginContext as SharedHostPluginContext } from '@shared/plugin/api'
import type { Effect, Option, Scope } from 'effect'
import type { AgentSession } from '../session/agent-backend'
import type { OutboundMessage } from '../session/protocol'

/**
 * What a plugin passes to `ctx.sessions.attach`: how the session is shown (`display`), the Agent
 * SDK session it resumes, if any, `open`, which opens the session and must report every event it
 * produces to the `emit` it is given, and `reset`, which replaces the session with a fresh one
 * when the user asks; `None` hides that action.
 */
export interface SessionAttachment {
  readonly display: Omit<AttachedSession, 'resettable'>
  readonly resume: Option.Option<SessionId>
  readonly open: (
    emit: (message: OutboundMessage) => Effect.Effect<void>
  ) => Effect.Effect<AgentSession, never, Scope.Scope>
  readonly reset: Option.Option<Effect.Effect<void>>
}

/** Sessions a plugin attaches to the Host, offered to a plugin's `host` entry as `ctx.sessions`. */
export interface HostSessions {
  /**
   * Opens the session through `open`, records its events, shows it as a row in project
   * `display.projectId`'s group (the `Assistant` group when null), and routes the composer's commands for `display.config.paneId`
   * to the session `open` returns. Closing the calling scope closes the session and removes the
   * row. Rewind is refused for an attached session. The session's end is the caller's to handle.
   * To change how a command reaches the agent, return a wrapped `AgentSession` from `open`.
   */
  readonly attach: (attachment: SessionAttachment) => Effect.Effect<void, never, Scope.Scope>
}

/**
 * The context a plugin's `host` entry receives: the shared context (see `@shared/plugin/api`)
 * plus `sessions`, where it attaches sessions it opens.
 */
export interface HostPluginContext extends SharedHostPluginContext {
  readonly sessions: HostSessions
}
