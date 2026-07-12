export {}

declare global {
  interface Window {
    dia: {
      sendMessage(paneId: string, text: string): void
      onMessageAppended(
        listener: (event: {
          paneId: string
          message: { role: 'user' | 'assistant'; content: string }
        }) => void
      ): () => void
    }
  }
}
