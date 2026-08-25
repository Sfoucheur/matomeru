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

/**
 * Renderer failures, into the same log as everything else.
 *
 * Two events cover what React does not: a synchronous throw outside a component, and a
 * rejected promise nobody awaited. Before this, an uncaught render error was a blank
 * window and no record anywhere — the worst possible combination, because the one person
 * who saw it is the one person who cannot look into it.
 *
 * Deliberately fire-and-forget. If the IPC that records the failure fails too, there is
 * nothing sensible left to do, and a handler that can throw would replace a blank screen
 * with a loop.
 */
function reportFailures(): void {
  const send = (message: string): void => {
    void window.api.diagnostics.record('error', message).catch(() => {})
  }
  window.addEventListener('error', (event) => {
    const where = event.filename ? ` (${event.filename}:${event.lineno}:${event.colno})` : ''
    send(`${event.message}${where}${event.error?.stack ? `
${event.error.stack}` : ''}`)
  })
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason
    send(
      `unhandled rejection: ${
        reason instanceof Error ? `${reason.message}
${reason.stack ?? ''}` : String(reason)
      }`
    )
  })
}

reportFailures()

const root = document.getElementById('root')
if (!root) throw new Error('Root element missing from index.html')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
)
