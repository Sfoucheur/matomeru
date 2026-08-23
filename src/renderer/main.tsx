import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { THEME_HINT } from './store/app'
import './index.css'

/**
 * Paints the last-used colour scheme before anything renders.
 *
 * `index.html` has to hardcode one of the two shells, and it hardcodes dark —
 * so without this, someone who chose the light theme gets a dark flash on every
 * launch while the settings read completes over IPC. The CSP is `script-src
 * 'self'`, which rules out the usual inline bootstrap script, so this runs at
 * the top of the entry module instead: still before the first React render.
 *
 * The stored value is only ever a hint. The database decides, and the store
 * overwrites both the document and this key as soon as settings arrive.
 */
function paintStoredTheme(): void {
  try {
    const raw = localStorage.getItem(THEME_HINT)
    if (!raw) return
    const hint = JSON.parse(raw) as { theme?: string; dark?: boolean; black?: boolean }
    const root = document.documentElement
    if (typeof hint.theme === 'string') root.dataset.theme = hint.theme
    if (typeof hint.dark === 'boolean') root.classList.toggle('dark', hint.dark)
    if (hint.dark && hint.black) root.dataset.black = '1'
  } catch {
    /* no hint, or an unreadable one — the hardcoded dark shell stands */
  }
}

paintStoredTheme()

const root = document.getElementById('root')
if (!root) throw new Error('Root element missing from index.html')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
)
