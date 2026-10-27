import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/syne'
import '@fontsource/ibm-plex-mono/400.css'
import './styles/index.css'
import App from './App'
import { ErrorBoundary } from './ErrorBoundary'

// Rooms and session consoles load as separate chunks. Rebuilding or upgrading
// Grok UI while this tab is open renames them, so a later import fails. Reload
// once to pick up the new build; if that recently happened, let the error
// boundary report the failure instead of looping.
const CHUNK_RELOAD_KEY = 'grok-ui-chunk-reload'
window.addEventListener('vite:preloadError', (event) => {
  try {
    if (Date.now() - Number(sessionStorage.getItem(CHUNK_RELOAD_KEY)) < 10_000) return
    sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now()))
  } catch {
    return
  }
  event.preventDefault()
  window.location.reload()
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
