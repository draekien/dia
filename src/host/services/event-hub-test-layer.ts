import { Layer } from 'effect'
import { SqlClient } from 'effect/sql'
import { type AgentEventStore, AgentEventStoreLive } from './agent-event-store'
import { openDatabase } from './database'
import { type EventHub, EventHubLive } from './event-hub'
import { kernelMigrations } from './kernel-migrations'

/**
 * An {@link AgentEventStore} and the `SqlClient` it writes, over an in-memory `host.db` that is
 * discarded with the layer. Each build starts with no stored events.
 */
export const AgentEventStoreTestLayer: Layer.Layer<AgentEventStore | SqlClient.SqlClient> =
  Layer.provideMerge(
    AgentEventStoreLive,
    Layer.effect(SqlClient.SqlClient, openDatabase(':memory:', kernelMigrations))
  ).pipe(Layer.orDie)

/**
 * The live {@link EventHub} with the in-memory {@link AgentEventStoreTestLayer} it stores pane
 * events in. For tests that need a real hub; each build starts with no stored events.
 */
export const EventHubTestLayer: Layer.Layer<EventHub | AgentEventStore | SqlClient.SqlClient> =
  Layer.provideMerge(EventHubLive, AgentEventStoreTestLayer)
