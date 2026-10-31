#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HELP = `cdp-capture.mjs — capture the running dia window over CDP as a PNG or an MP4.

Usage:
  node scripts/cdp-capture.mjs screenshot --port <port> --out <file.png>
  node scripts/cdp-capture.mjs record --port <port> --seconds <n> --out <file.mp4> [--width <px>]

screenshot  writes one PNG of the page.
record      records the page for <n> seconds and writes an H.264 MP4 (needs ffmpeg on PATH).
            Run it in the background, then drive the app with cdp-eval.mjs while it records.
            --width scales the video (default 960). Frames arrive only when the page repaints.

Only the app's own page target is captured, never other windows on the desktop.

Exit codes:
  0  written
  2  usage error
  3  no page target on --port
  5  ffmpeg failed or captured no frames
`

const fail = (code, message) => {
  process.stderr.write(`${message}\n`)
  process.exit(code)
}

const parseArgs = (argv) => {
  const args = { mode: argv[0], port: undefined, out: undefined, seconds: undefined, width: 960 }
  if (args.mode === '--help' || args.mode === '-h' || args.mode === undefined) {
    process.stdout.write(HELP)
    process.exit(args.mode === undefined ? 2 : 0)
  }
  if (args.mode !== 'screenshot' && args.mode !== 'record')
    fail(2, `Unknown mode ${args.mode}. Accepted: screenshot, record.`)
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--port') args.port = Number(argv[++i])
    else if (arg === '--out') args.out = argv[++i]
    else if (arg === '--seconds') args.seconds = Number(argv[++i])
    else if (arg === '--width') args.width = Number(argv[++i])
    else fail(2, `Unknown argument ${arg}. Accepted: --port, --out, --seconds, --width.`)
  }
  if (!Number.isInteger(args.port) || args.port <= 0) fail(2, '--port <port> is required.')
  if (!args.out) fail(2, '--out <file> is required.')
  if (args.mode === 'record' && !(args.seconds > 0)) fail(2, 'record needs --seconds <n>.')
  return args
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const findPageSocketUrl = async (port) => {
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
      const page = targets.find((target) => target.type === 'page')
      if (page) return page.webSocketDebuggerUrl
    } catch {}
    await sleep(500)
  }
  fail(3, `No page target on port ${port}. Launch the app with --remote-debugging-port=${port}.`)
}

const connect = async (url) => {
  const socket = new WebSocket(url)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve)
    socket.addEventListener('error', reject)
  })
  let nextId = 0
  const pending = new Map()
  const listeners = []
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id !== undefined) {
      pending.get(message.id)?.(message)
      pending.delete(message.id)
    } else for (const listener of listeners) listener(message)
  })
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++nextId
      pending.set(id, resolve)
      socket.send(JSON.stringify({ id, method, params }))
    })
  return { socket, send, onEvent: (listener) => listeners.push(listener) }
}

const screenshot = async ({ send }, out) => {
  const response = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(out, Buffer.from(response.result.data, 'base64'))
}

const record = async ({ send, onEvent }, { out, seconds, width }) => {
  const dir = mkdtempSync(join(tmpdir(), 'dia-capture-'))
  const frames = []
  onEvent((message) => {
    if (message.method !== 'Page.screencastFrame') return
    const { data, metadata, sessionId } = message.params
    const file = join(dir, `${String(frames.length).padStart(5, '0')}.jpg`)
    writeFileSync(file, Buffer.from(data, 'base64'))
    frames.push({ file, timestamp: metadata.timestamp })
    send('Page.screencastFrameAck', { sessionId })
  })
  await send('Page.startScreencast', { format: 'jpeg', quality: 80, everyNthFrame: 1 })
  await sleep(seconds * 1000)
  await send('Page.stopScreencast')
  frames.push({ ...frames.at(-1), timestamp: frames.at(-1)?.timestamp + 1 })
  if (frames.length < 2) fail(5, 'No frames captured; the page never repainted.')
  const list = frames
    .slice(0, -1)
    .map((frame, i) => {
      const duration = Math.max(frames[i + 1].timestamp - frame.timestamp, 0.04)
      return `file '${frame.file.replaceAll('\\', '/')}'\nduration ${duration.toFixed(3)}`
    })
    .join('\n')
  const listFile = join(dir, 'frames.txt')
  writeFileSync(listFile, `${list}\nfile '${frames.at(-1).file.replaceAll('\\', '/')}'\n`)
  const ffmpeg = spawnSync(
    'ffmpeg',
    [
      '-y',
      '-loglevel',
      'error',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      listFile,
      '-vf',
      `scale=${width}:-2`,
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-r',
      '30',
      out
    ],
    { encoding: 'utf8' }
  )
  rmSync(dir, { recursive: true, force: true })
  if (ffmpeg.status !== 0) fail(5, `ffmpeg failed: ${ffmpeg.stderr || ffmpeg.error}`)
}

const args = parseArgs(process.argv.slice(2))
const client = await connect(await findPageSocketUrl(args.port))
if (args.mode === 'screenshot') await screenshot(client, args.out)
else await record(client, args)
client.socket.close()
process.stdout.write(`${JSON.stringify({ written: args.out })}\n`)
