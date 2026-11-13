import { type DiaTool, diaTool, type ToolScope } from '@dia/plugin'
import * as NodeCrypto from '@effect/platform-node/NodeCrypto'
import { assert, describe, it } from '@effect/vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { Deferred, Effect, Schema } from 'effect'
import { MCP_HOST, MCP_PATH, serveMcp } from './http-server'
import { makeToolRegistry } from './registry'
import { newToken } from './tools'

const ISSUE_RUN: ToolScope = {
  runId: 'run-1',
  project: '/work/dia',
  labels: ['issue'],
  context: { issueId: 'issue-7' }
}
const OTHER_RUN: ToolScope = { runId: 'run-2', labels: [], context: undefined }

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'test', version: '1' }
  }
}

const isIssueRun = (scope: ToolScope) => scope.labels.includes('issue')

const echoTool = (received: Array<unknown>): DiaTool =>
  diaTool({
    name: 'echo',
    description: 'Echo the text back.',
    input: Schema.Struct({ text: Schema.String }),
    run: (input, scope) =>
      Effect.sync(() => {
        received.push(scope.context)
        return { text: `echo: ${input.text}`, isError: false }
      })
  })

const serve = Effect.gen(function* () {
  const registry = yield* makeToolRegistry
  const endpoint = yield* serveMcp(registry, 0)
  const url = new URL(`http://${MCP_HOST}:${endpoint.port}${MCP_PATH}`)
  const grantNew = (scope: ToolScope) =>
    Effect.gen(function* () {
      const { token, hash } = yield* newToken
      yield* registry.grant(hash, scope)
      return { token, hash }
    }).pipe(Effect.provide(NodeCrypto.layer))
  return { registry, endpoint, url, grantNew }
}).pipe(Effect.provide(NodeCrypto.layer))

const connect = (url: URL, token: string) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const client = new Client({ name: 'test', version: '1' })
      await client.connect(
        new StreamableHTTPClientTransport(url, {
          requestInit: { headers: { Authorization: `Bearer ${token}` } }
        })
      )
      return client
    }),
    (client) => Effect.promise(() => client.close())
  )

const post = (url: URL, headers: Record<string, string>) =>
  Effect.promise(() =>
    // @effect-diagnostics-next-line globalFetchInEffect:off -- the test sends raw HTTP requests as a local process would.
    fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...headers
      },
      body: JSON.stringify(INITIALIZE)
    })
  )

describe('the dia tools MCP endpoint', () => {
  it.effect('lists a tool to a run its scope accepts and passes the run context to it', () =>
    Effect.gen(function* () {
      const env = yield* serve
      const received: Array<unknown> = []
      yield* env.registry.register(echoTool(received), { when: isIssueRun })
      const { token } = yield* env.grantNew(ISSUE_RUN)
      const client = yield* connect(env.url, token)

      const listed = yield* Effect.promise(() => client.listTools())
      const result = yield* Effect.promise(() =>
        client.callTool({ name: 'echo', arguments: { text: 'hi' } })
      )

      assert.deepStrictEqual(
        listed.tools.map((tool) => tool.name),
        ['echo']
      )
      assert.deepStrictEqual(result.content, [{ type: 'text', text: 'echo: hi' }])
      assert.deepStrictEqual(received, [{ issueId: 'issue-7' }])
    }).pipe(Effect.scoped)
  )

  it.effect('hides a tool from a run its scope does not accept and refuses its call', () =>
    Effect.gen(function* () {
      const env = yield* serve
      const received: Array<unknown> = []
      yield* env.registry.register(echoTool(received), { when: isIssueRun })
      const { token } = yield* env.grantNew(OTHER_RUN)
      const client = yield* connect(env.url, token)

      const listed = yield* Effect.promise(() => client.listTools())
      const result = yield* Effect.promise(() =>
        client.callTool({ name: 'echo', arguments: { text: 'hi' } })
      )

      assert.deepStrictEqual(listed.tools, [])
      assert.isTrue(result.isError)
      assert.deepStrictEqual(received, [])
    }).pipe(Effect.scoped)
  )

  it.effect('returns invalid input to the agent as an error without running the tool', () =>
    Effect.gen(function* () {
      const env = yield* serve
      const received: Array<unknown> = []
      yield* env.registry.register(echoTool(received), { when: isIssueRun })
      const { token } = yield* env.grantNew(ISSUE_RUN)
      const client = yield* connect(env.url, token)

      const result = yield* Effect.promise(() =>
        client.callTool({ name: 'echo', arguments: { text: 42 } })
      )

      assert.isTrue(result.isError)
      assert.deepStrictEqual(received, [])
    }).pipe(Effect.scoped)
  )

  it.effect('refuses a request without a token with 401', () =>
    Effect.gen(function* () {
      const env = yield* serve
      const response = yield* post(env.url, {})
      assert.strictEqual(response.status, 401)
    }).pipe(Effect.scoped)
  )

  it.effect('refuses a revoked token with 401', () =>
    Effect.gen(function* () {
      const env = yield* serve
      const { token, hash } = yield* env.grantNew(ISSUE_RUN)
      yield* env.registry.revoke(hash)

      const response = yield* post(env.url, { authorization: `Bearer ${token}` })

      assert.strictEqual(response.status, 401)
    }).pipe(Effect.scoped)
  )

  it.effect('refuses a valid token sent with an Origin header with 403', () =>
    Effect.gen(function* () {
      const env = yield* serve
      const { token } = yield* env.grantNew(ISSUE_RUN)

      const response = yield* post(env.url, {
        authorization: `Bearer ${token}`,
        origin: 'http://evil.example'
      })

      assert.strictEqual(response.status, 403)
    }).pipe(Effect.scoped)
  )

  it.effect('accepts a valid token without an Origin header', () =>
    Effect.gen(function* () {
      const env = yield* serve
      const { token } = yield* env.grantNew(ISSUE_RUN)

      const response = yield* post(env.url, { authorization: `Bearer ${token}` })

      assert.strictEqual(response.status, 200)
    }).pipe(Effect.scoped)
  )

  it.effect('refuses another token on a session the first token opened with 403', () =>
    Effect.gen(function* () {
      const env = yield* serve
      const first = yield* env.grantNew(ISSUE_RUN)
      const second = yield* env.grantNew(OTHER_RUN)
      const opened = yield* post(env.url, { authorization: `Bearer ${first.token}` })
      const sessionId = opened.headers.get('mcp-session-id')
      assert.isNotNull(sessionId)

      const response = yield* post(env.url, {
        authorization: `Bearer ${second.token}`,
        'mcp-session-id': sessionId ?? ''
      })

      assert.strictEqual(response.status, 403)
    }).pipe(Effect.scoped)
  )

  it.effect('tells a connected client the tool list changed when a tool is registered', () =>
    Effect.gen(function* () {
      const env = yield* serve
      const { token } = yield* env.grantNew(ISSUE_RUN)
      const client = yield* connect(env.url, token)
      const changed = yield* Deferred.make<void>()
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        Deferred.doneUnsafe(changed, Effect.void)
      })
      yield* Effect.promise(() => client.listTools())

      yield* env.registry.register(echoTool([]), { when: isIssueRun })

      yield* Deferred.await(changed).pipe(Effect.timeout('5 seconds'))
      const listed = yield* Effect.promise(() => client.listTools())
      assert.deepStrictEqual(
        listed.tools.map((tool) => tool.name),
        ['echo']
      )
    }).pipe(Effect.scoped)
  )

  it.effect('serves the same tools over the HTTP+SSE transport', () =>
    Effect.gen(function* () {
      const env = yield* serve
      yield* env.registry.register(echoTool([]), { when: isIssueRun })
      const { token } = yield* env.grantNew(ISSUE_RUN)
      const sseUrl = new URL(`http://${MCP_HOST}:${env.url.port}/sse`)
      const client = yield* Effect.acquireRelease(
        Effect.promise(async () => {
          const created = new Client({ name: 'test', version: '1' })
          const headers = { Authorization: `Bearer ${token}` }
          await created.connect(
            new SSEClientTransport(sseUrl, {
              requestInit: { headers },
              eventSourceInit: {
                fetch: (input, init) =>
                  // @effect-diagnostics-next-line globalFetch:off -- the SSE client transport takes a fetch function.
                  fetch(input, { ...init, headers: { ...init?.headers, ...headers } })
              }
            })
          )
          return created
        }),
        (created) => Effect.promise(() => created.close())
      )

      const listed = yield* Effect.promise(() => client.listTools())

      assert.deepStrictEqual(
        listed.tools.map((tool) => tool.name),
        ['echo']
      )
    }).pipe(Effect.scoped)
  )
})
