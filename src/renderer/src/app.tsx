import { NoLayoutPlugin } from './components/tab-content'
import { ROOT, Slot } from './lib/slots'

function App() {
  return (
    <div className="h-screen bg-sidebar">
      <Slot name={ROOT} empty={<NoLayoutPlugin />} />
    </div>
  )
}

export default App
