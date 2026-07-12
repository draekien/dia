import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { Schema } from 'effect'
import type { ConversationMessage, PaneConfig } from '../domain/pane'
import { AssistantMessageReceived, InboundMessage } from './protocol'

const decodeInbound = Schema.decodeUnknownSync(InboundMessage)
const encodeOutbound = Schema.encodeSync(AssistantMessageReceived)

const port = process.parentPort

class AsyncQueue<T> {
  private readonly items: T[] = []
  private waiting: ((value: T) => void) | undefined

  push(item: T): void {
    if (this.waiting) {
      const resolve = this.waiting
      this.waiting = undefined
      resolve(item)
    } else {
      this.items.push(item)
    }
  }

  next(): Promise<T> {
    const item = this.items.shift()
    if (item !== undefined) return Promise.resolve(item)
    return new Promise((resolve) => {
      this.waiting = resolve
    })
  }
}

const inboundText = new AsyncQueue<string>()

async function* userMessages(): AsyncGenerator<SDKUserMessage> {
  while (true) {
    const text = await inboundText.next()
    yield { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null }
  }
}

function postAssistantMessage(message: ConversationMessage): void {
  port.postMessage(encodeOutbound({ _tag: 'AssistantMessageReceived', message }))
}

async function runSession(config: PaneConfig): Promise<void> {
  console.log('[agent-session] starting query session', { paneId: config.paneId, cwd: config.cwd })

  const session = query({
    prompt: userMessages(),
    options: { cwd: config.cwd, model: config.model }
  })

  for await (const event of session) {
    console.log('[agent-session] received SDK event', { type: event.type })
    if (event.type === 'assistant') {
      const text = event.message.content
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('')
      if (text) {
        console.log('[agent-session] posting assistant message', {
          paneId: config.paneId,
          length: text.length
        })
        postAssistantMessage({ role: 'assistant', content: text })
      }
    }
  }
}

port.on('message', (event) => {
  const inbound = decodeInbound(event.data)
  if (inbound._tag === 'Init') {
    runSession(inbound.config).catch((cause) => {
      console.error('[agent-session] query session failed', cause)
    })
  } else {
    console.log('[agent-session] queuing user text', { length: inbound.text.length })
    inboundText.push(inbound.text)
  }
})
