/**
 * The build-time values electron-vite inlines into the main process.
 *
 * electron-vite's main-process `envPrefix` is `['MAIN_VITE_', 'VITE_']`, so these are
 * read from a gitignored `.env` at the project root and replaced with literals when
 * the bundle is built — there is no environment to read at run time, and a missing
 * one is the empty string rather than a crash.
 *
 * Both are optional on purpose: a checkout with no `.env` must still build and run,
 * with the Drive connection simply reporting that this build carries no client.
 */
interface ImportMetaEnv {
  /** OAuth client of type "Desktop app". */
  readonly MAIN_VITE_GOOGLE_CLIENT_ID?: string
  /**
   * Its secret. Not confidential in the usual sense — Google's installed-app flow
   * states as much, and a packaged asar is extractable anyway. PKCE is the guard.
   */
  readonly MAIN_VITE_GOOGLE_CLIENT_SECRET?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
