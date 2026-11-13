import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import * as NodeRuntime from '@effect/platform-node/NodeRuntime'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { isJSONRPCRequest, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { Config, Data, Effect, Layer, Logger, Option, Redacted } from 'effect'
import { readPort } from './store'

class DiaMcpError extends Data.TaggedError('DiaMcpError')<{ readonly message: string }> {}

const failedReply = (message: JSONRPCMessage, reason: string): Option.Option<JSONRPCMessage> =>
  isJSONRPCRequest(message)
    ? Option.some({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32000, message: `dia did not answer: ${reason}` }
      })
    : Option.none()

const program = Effect.gen(function* () {
  const token = yield* Config.Redacted('DIA_MCP_TOKEN')
  const endpointFile = process.argv[2]
  if (endpointFile === undefined) {
    return yield* new DiaMcpError({ message: 'Pass the dia tools endpoint file as an argument.' })
  }
  const port = yield* readPort(endpointFile)
  if (Option.isNone(port)) {
    return yield* new DiaMcpError({
      message: `No dia tools endpoint in ${endpointFile}; start dia first.`
    })
  }
  const services = yield* Effect.context<never>()
  const log = (message: string, details: object) =>
    Effect.runForkWith(services)(Effect.logWarning(message, details))
  const http = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port.value}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${Redacted.value(token)}` } }
  })
  const stdio = new StdioServerTransport()
  yield* Effect.logInfo('Forwarding MCP between stdio and dia', { port: port.value })
  yield* Effect.callback<void>((resume) => {
    stdio.onmessage = (message) => {
      http.send(message).catch((error: unknown) => {
        log('Could not forward a message to dia', { error: String(error) })
        Option.map(failedReply(message, String(error)), (reply) => stdio.send(reply))
      })
    }
    http.onmessage = (message) => {
      stdio.send(message).catch((error: unknown) => {
        log('Could not forward a message to the agent', { error: String(error) })
      })
    }
    http.onerror = (error) => log('The dia connection reported an error', { error: String(error) })
    stdio.onclose = () => resume(Effect.void)
    void http.start().then(() => stdio.start())
    return Effect.promise(() => http.close())
  })
  yield* Effect.promise(() => http.terminateSession().catch(() => undefined))
  yield* Effect.logInfo('The agent closed stdio; dia-mcp exits')
})

const StderrLogger = Logger.layer([Logger.withConsoleError(Logger.formatLogFmt)])

program.pipe(
  Effect.provide(Layer.mergeAll(NodeFileSystem.layer, StderrLogger)),
  NodeRuntime.runMain
)
