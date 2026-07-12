import { useForm } from '@tanstack/react-form'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import type { AttentionState, PermissionRequest } from '../dia'
import { PermissionInputPreview } from './permission-input-preview'
import { PulseIndicator } from './pulse-indicator'
import { Button } from './ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from './ui/dialog'

interface Message {
  role: 'user' | 'assistant'
  content: string
}

interface PaneProps {
  paneId: string
  cwd?: string
  sourceRepo?: string
  isFocused?: boolean
  onFocus?: () => void
}

export function dirName(path: string): string {
  const normalized = path.replace(/[/\\]+$/, '')
  const lastSeparator = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  return lastSeparator === -1 ? normalized : normalized.slice(lastSeparator + 1)
}

function Pane({ paneId, cwd, sourceRepo, isFocused = false, onFocus }: PaneProps) {
  const queryClient = useQueryClient()
  const messagesQueryKey = ['pane', paneId, 'messages'] as const
  const attentionQueryKey = ['pane', paneId, 'attention'] as const
  const streamingTextQueryKey = ['pane', paneId, 'streamingText'] as const
  const pendingPermissionQueryKey = ['pane', paneId, 'pendingPermission'] as const

  const { data: messages = [] } = useQuery<Message[]>({
    queryKey: messagesQueryKey,
    queryFn: () => [],
    staleTime: Infinity
  })
  const { data: attention = { _tag: 'Idle' } } = useQuery<AttentionState>({
    queryKey: attentionQueryKey,
    queryFn: () => ({ _tag: 'Idle' }),
    staleTime: Infinity
  })
  const { data: streamingText = '' } = useQuery<string>({
    queryKey: streamingTextQueryKey,
    queryFn: () => '',
    staleTime: Infinity
  })
  const { data: pendingPermission = null } = useQuery<PermissionRequest | null>({
    queryKey: pendingPermissionQueryKey,
    queryFn: () => null,
    staleTime: Infinity
  })

  useEffect(() => {
    return window.dia.onMessageAppended((event) => {
      if (event.paneId !== paneId) return
      queryClient.setQueryData<Message[]>(messagesQueryKey, (prev = []) => [...prev, event.message])
      if (event.message.role === 'assistant') {
        queryClient.setQueryData<string>(streamingTextQueryKey, '')
      }
    })
  }, [queryClient, paneId, messagesQueryKey, streamingTextQueryKey])

  useEffect(() => {
    return window.dia.onAssistantTextDelta((event) => {
      if (event.paneId !== paneId) return
      queryClient.setQueryData<string>(streamingTextQueryKey, (prev = '') => prev + event.text)
    })
  }, [queryClient, paneId, streamingTextQueryKey])

  useEffect(() => {
    return window.dia.onAttentionChanged((event) => {
      if (event.paneId !== paneId) return
      queryClient.setQueryData<AttentionState>(attentionQueryKey, event.attention)
    })
  }, [queryClient, paneId, attentionQueryKey])

  useEffect(() => {
    return window.dia.onPermissionRequested((event) => {
      if (event.paneId !== paneId) return
      queryClient.setQueryData<PermissionRequest | null>(pendingPermissionQueryKey, event)
    })
  }, [queryClient, paneId, pendingPermissionQueryKey])

  const form = useForm({
    defaultValues: { text: '' },
    onSubmit: ({ value, formApi }) => {
      const text = value.text.trim()
      if (!text) return
      queryClient.setQueryData<Message[]>(messagesQueryKey, (prev = []) => [
        ...prev,
        { role: 'user', content: text }
      ])
      window.dia.sendMessage(paneId, text)
      formApi.reset()
    }
  })

  function respondToPermission(decision: 'allow' | 'deny'): void {
    if (!pendingPermission) return
    window.dia.resolvePermission(paneId, pendingPermission.requestId, decision)
    queryClient.setQueryData<PermissionRequest | null>(pendingPermissionQueryKey, null)
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: tracks focus bubbling up from any descendant control to mark this pane active
    <div
      // biome-ignore lint/a11y/noNoninteractiveTabindex: must itself be focusable so clicking empty pane space still activates it
      tabIndex={0}
      onFocus={onFocus}
      className={`flex h-full flex-col bg-neutral-950 p-4 text-neutral-100 transition-shadow outline-none ${
        isFocused ? 'ring-2 ring-ring ring-inset' : ''
      }`}
    >
      <div className="flex items-center justify-between gap-2 pb-2">
        <div className="flex min-w-0 items-center gap-2">
          <PulseIndicator attention={attention} />
          {cwd !== undefined && (
            <span
              title={sourceRepo !== undefined ? `${sourceRepo} (worktree at ${cwd})` : cwd}
              className="flex min-w-0 items-center gap-1.5 rounded border border-neutral-800 bg-neutral-900 px-2 py-1 font-mono text-xs text-neutral-400"
            >
              <span className="truncate">{dirName(sourceRepo ?? cwd)}</span>
              {sourceRepo !== undefined && (
                <span className="shrink-0 rounded-sm bg-neutral-800 px-1 text-[10px] text-neutral-500">
                  worktree
                </span>
              )}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            className="rounded border border-neutral-700 px-2 py-1 text-xs"
            onClick={() => window.dia.splitPane(paneId, 'row')}
          >
            Split ↔
          </button>
          <button
            type="button"
            className="rounded border border-neutral-700 px-2 py-1 text-xs"
            onClick={() => window.dia.splitPane(paneId, 'column')}
          >
            Split ↕
          </button>
          <button
            type="button"
            className="rounded border border-neutral-700 px-2 py-1 text-xs"
            onClick={() => window.dia.closePane(paneId)}
          >
            Close
          </button>
        </div>
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto">
        {messages.map((message, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: history is append-only, index is stable
          <div key={index} className={message.role === 'user' ? 'text-right' : 'text-left'}>
            <span className="inline-block rounded bg-neutral-800 px-3 py-1">{message.content}</span>
          </div>
        ))}
        {streamingText !== '' && (
          <div className="text-left">
            <span className="inline-block rounded bg-neutral-800 px-3 py-1">{streamingText}</span>
          </div>
        )}
      </div>
      <form
        className="mt-2 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          void form.handleSubmit()
        }}
      >
        <form.Field name="text">
          {(field) => (
            <input
              className="flex-1 rounded border border-neutral-700 bg-neutral-900 px-2 py-1"
              value={field.state.value}
              onChange={(event) => field.handleChange(event.target.value)}
              placeholder="Message dia..."
            />
          )}
        </form.Field>
        <button type="submit" className="rounded bg-neutral-100 px-3 py-1 text-neutral-950">
          Send
        </button>
      </form>
      <Dialog
        open={pendingPermission !== null}
        onOpenChange={(open) => {
          if (!open) respondToPermission('deny')
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Permission requested</DialogTitle>
            <DialogDescription>
              Wants to run{' '}
              <span className="rounded border border-neutral-800 bg-neutral-900 px-1.5 py-0.5 font-mono text-xs text-neutral-300">
                {pendingPermission?.toolName}
              </span>
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-64 overflow-auto">
            {pendingPermission !== null && (
              <PermissionInputPreview
                toolName={pendingPermission.toolName}
                input={pendingPermission.input}
              />
            )}
          </div>
          <DialogFooter>
            <Button variant="destructive" onClick={() => respondToPermission('deny')}>
              Deny
            </Button>
            <Button onClick={() => respondToPermission('allow')}>Allow</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export default Pane
