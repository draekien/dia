import { RegistryContext } from '@effect/atom-react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './app'
import { CommandPalette } from './components/command-palette'
import { TabContent } from './components/tab-content'
import { TabHeader } from './components/tab-header'
import { ThemeProvider } from './components/theme-provider'
import { TooltipProvider } from './components/ui/tooltip'
import { MAIN, MAIN_HEADER, setKernelDefault, setPluginRegistry } from './lib/slots'
import { appRegistry } from './lib/workspace-atoms'
import { startRendererPlugins } from './plugins/built-in-renderer-plugins'
import './index.css'

const queryClient = new QueryClient()

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Root element not found')
const root = createRoot(rootElement)

setKernelDefault(MAIN, TabContent)
setKernelDefault(MAIN_HEADER, TabHeader)

const renderApp = () =>
  root.render(
    <StrictMode>
      <RegistryContext.Provider value={appRegistry}>
        <ThemeProvider>
          <QueryClientProvider client={queryClient}>
            <TooltipProvider delayDuration={400}>
              <App />
              <CommandPalette />
            </TooltipProvider>
          </QueryClientProvider>
        </ThemeProvider>
      </RegistryContext.Provider>
    </StrictMode>
  )

void startRendererPlugins().then(setPluginRegistry).finally(renderApp)
