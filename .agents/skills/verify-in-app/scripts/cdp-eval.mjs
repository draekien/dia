#!/usr/bin/env node
const HELP = `cdp-eval.mjs — evaluate a JavaScript expression in the running dia window over CDP.

Usage:
  node scripts/cdp-eval.mjs --port <port> [--timeout-ms <ms>] [expression]
  node scripts/cdp-eval.mjs --port <port> < expression.js

The expression comes from the positional argument, or from stdin when none is given.
It runs with awaitPromise and returnByValue, after window.dia exists. State stored on
window (for example window.__events) persists between calls. --timeout-ms bounds only
finding the page and window.dia, not the expression; wrap a promise that may never
settle in Promise.race. An undefined result prints as null.

Output (stdout, one JSON line):
  {"value": <result>}                      on success
  {"exception": "<text>"}                  when the expression throws or rejects

Exit codes:
  0  evaluated
  2  usage error
  3  no page target or window.dia within --timeout-ms (default 60000); is the app
     running with --remote-debugging-port=<port>?
  4  the expression threw or rejected

Example:
  node scripts/cdp-eval.mjs --port 9333 "window.dia.plugins.list().then(ps => ps.map(p => p.name))"
`

const fail = (code, message) => {
  process.stderr.write(`${message}\n`)
  process.exit(code)
}

const parseArgs = (argv) => {
  const args = { port: undefined, timeoutMs: 60000, expression: undefined }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(HELP)
      process.exit(0)
    } else if (arg === '--port') args.port = Number(argv[++i])
    else if (arg === '--timeout-ms') args.timeoutMs = Number(argv[++i])
    else if (arg.startsWith('--'))
      fail(2, `Unknown flag ${arg}. Accepted: --port, --timeout-ms, --help.`)
    else if (args.expression === undefined) args.expression = arg
    else fail(2, 'Pass one expression only; quote it, or pipe it on stdin.')
  }
  if (!Number.isInteger(args.port) || args.port <= 0)
    fail(2, '--port <port> is required, e.g. --port 9333.')
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)
    fail(2, '--timeout-ms must be a positive number.')
  return args
}

const readStdin = async () => {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const findPageSocketUrl = async (port, deadline) => {
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
      const page = targets.find((target) => target.type === 'page')
      if (page) return page.webSocketDebuggerUrl
    } catch {}
    await sleep(500)
  }
  fail(
    3,
    `No page target on port ${port}. Launch the app with --remote-debugging-port=${port} and retry.`
  )
}

const connect = async (url) => {
  const socket = new WebSocket(url)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve)
    socket.addEventListener('error', reject)
  })
  let nextId = 0
  const pending = new Map()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    pending.get(message.id)?.(message)
    pending.delete(message.id)
  })
  const evaluate = (expression) =>
    new Promise((resolve) => {
      const id = ++nextId
      pending.set(id, resolve)
      socket.send(
        JSON.stringify({
          id,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise: true, returnByValue: true }
        })
      )
    })
  return { socket, evaluate }
}

const waitForDia = async (evaluate, deadline, port) => {
  while (Date.now() < deadline) {
    const response = await evaluate('typeof window.dia === "object" && window.dia !== null')
    if (response.result?.result?.value === true) return
    await sleep(500)
  }
  fail(
    3,
    `window.dia did not appear on port ${port}. The renderer may have failed to load; read the app log.`
  )
}

const args = parseArgs(process.argv.slice(2))
const expression = args.expression ?? (await readStdin())
if (expression.trim() === '') fail(2, 'No expression given. Pass it as an argument or on stdin.')

const deadline = Date.now() + args.timeoutMs
const { socket, evaluate } = await connect(await findPageSocketUrl(args.port, deadline))
await waitForDia(evaluate, deadline, args.port)

const response = await evaluate(expression)
socket.close()
const details = response.result?.exceptionDetails
if (details) {
  process.stdout.write(
    `${JSON.stringify({ exception: details.exception?.description ?? details.text })}\n`
  )
  process.exit(4)
}
process.stdout.write(`${JSON.stringify({ value: response.result?.result?.value ?? null })}\n`)
