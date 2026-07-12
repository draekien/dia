import { useForm } from '@tanstack/react-form'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'

interface Message {
  role: 'user' | 'assistant'
  content: string
}

interface PaneProps {
  paneId: string
  cwd?: string
  sourceRepo?: string
}

export function dirName(path: string): string {
  const normalized = path.replace(/[/\\]+$/, '')
  const lastSeparator = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  return lastSeparator === -1 ? normalized : normalized.slice(lastSeparator + 1)
}

function Pane({ paneId, cwd, sourceRepo }: PaneProps) {
  const queryClient = useQueryClient()
  const messagesQueryKey = ['pane', paneId, 'messages'] as const
  const { data: messages = [] } = useQuery<Message[]>({
    queryKey: messagesQueryKey,
    queryFn: () => [],
    staleTime: Infinity
  })

  useEffect(() => {
    return window.dia.onMessageAppended((event) => {
      if (event.paneId !== paneId) return
      queryClient.setQueryData<Message[]>(messagesQueryKey, (prev = []) => [...prev, event.message])
    })
  }, [queryClient, paneId, messagesQueryKey])

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

  return (
    <div className="flex h-full flex-col bg-neutral-950 p-4 text-neutral-100">
      <div className="flex items-center justify-between gap-2 pb-2">
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
    </div>
  )
}

export default Pane
