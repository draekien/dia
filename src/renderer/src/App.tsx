import { useForm } from '@tanstack/react-form'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'

interface Message {
  role: 'user' | 'assistant'
  content: string
}

const PANE_ID = '00000000-0000-0000-0000-000000000001'
const messagesQueryKey = ['pane', PANE_ID, 'messages'] as const

function App(): React.JSX.Element {
  const queryClient = useQueryClient()
  const { data: messages = [] } = useQuery<Message[]>({
    queryKey: messagesQueryKey,
    queryFn: () => [],
    staleTime: Infinity
  })

  useEffect(() => {
    return window.dia.onMessageAppended((event) => {
      queryClient.setQueryData<Message[]>(messagesQueryKey, (prev = []) => [...prev, event.message])
    })
  }, [queryClient])

  const form = useForm({
    defaultValues: { text: '' },
    onSubmit: ({ value, formApi }) => {
      const text = value.text.trim()
      if (!text) return
      queryClient.setQueryData<Message[]>(messagesQueryKey, (prev = []) => [
        ...prev,
        { role: 'user', content: text }
      ])
      window.dia.sendMessage(PANE_ID, text)
      formApi.reset()
    }
  })

  return (
    <div className="flex h-screen flex-col bg-neutral-950 p-4 text-neutral-100">
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

export default App
