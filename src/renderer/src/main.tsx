import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './app'
import { CommandPalette } from './components/command-palette'
import { ThemeProvider } from './components/theme-provider'
import { startRendererPlugins } from './plugins/built-in-renderer-plugins'
import './index.css'

const queryClient = new QueryClient()

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Root element not found')
const root = createRoot(rootElement)

const renderApp = () =>
  root.render(
    <StrictMode>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <App />
          <CommandPalette />
        </QueryClientProvider>
      </ThemeProvider>
    </StrictMode>
  )

void startRendererPlugins().finally(renderApp)
