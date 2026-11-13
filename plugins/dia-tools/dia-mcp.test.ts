import { diaTool, type ToolScope } from '@dia/plugin'
import * as NodeCrypto from '@effect/platform-node/NodeCrypto'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { assert, describe, it } from '@effect/vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { Effect, FileSystem, Layer, Path, Schema } from 'effect'
import { serveMcp } from './http-server'
import { makeToolRegistry } from './registry'
import { ENDPOINT_FILE, writePort } from './store'
import { newToken } from './tools'

const OUTSIDE: ToolScope = { labels: [], context: undefined }

const pingTool = diaTool({
  name: 'ping',
  description: 'Answer pong.',
  input: Schema.Struct({}),
  run: () => Effect.succeed({ text: 'pong', isError: false })
})

const listOverStdio = (script: string, endpointFile: string, token: string) =>
  Effect.acquireUseRelease(
    Effect.sync(() => new Client({ name: 'test', version: '1' })),
    (client) =>
      Effect.tryPromise(async () => {
        await client.connect(
          new StdioClientTransport({
            command: process.execPath,
            args: ['--import', 'tsx', script, endpointFile],
            env: { ...(process.env as Record<string, string>), DIA_MCP_TOKEN: token },
            stderr: 'ignore'
          })
        )
        return client.listTools()
      }),
    (client) => Effect.promise(() => client.close())
  )

const setUp = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const registry = yield* makeToolRegistry
  yield* registry.register(pingTool, { when: () => true })
  const endpoint = yield* serveMcp(registry, 0)
  const endpointFile = path.join(yield* fs.makeTempDirectoryScoped(), ENDPOINT_FILE)
  yield* writePort(endpointFile, endpoint.port)
  const { token, hash } = yield* newToken
  yield* registry.grant(hash, OUTSIDE)
  const script = path.resolve('plugins/dia-tools/dia-mcp.ts')
  return { script, endpointFile, token }
}).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)))

describe('dia-mcp', () => {
  it.effect(
    'lists the dia tools over stdio for a token from DIA_MCP_TOKEN',
    () =>
      Effect.gen(function* () {
        const { script, endpointFile, token } = yield* setUp

        const listed = yield* listOverStdio(script, endpointFile, token)

        assert.deepStrictEqual(
          listed.tools.map((tool) => tool.name),
          ['ping']
        )
      }).pipe(Effect.scoped),
    30_000
  )

  it.effect(
    'fails the connection for a token dia did not grant',
    () =>
      Effect.gen(function* () {
        const { script, endpointFile } = yield* setUp

        const outcome = yield* listOverStdio(script, endpointFile, 'not-a-token').pipe(Effect.flip)

        assert.include(String(outcome.cause), 'dia did not answer')
      }).pipe(Effect.scoped),
    30_000
  )
})
