import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/syne'
import '@fontsource/ibm-plex-mono/400.css'
import './styles/index.css'
import App from './App'
import { ErrorBoundary } from './ErrorBoundary'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
