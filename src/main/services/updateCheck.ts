import type { UpdateMode } from '@shared/types'

/**
 * The decisions behind updating, as pure functions.
 *
 * Separate from `updates.ts` because that module imports Electron and
 * `electron-updater`, neither of which survives the CommonJS bundle the verification
 * suite builds. What is worth asserting is exactly what lives here: whether an update
 * check should happen at all, and whether a release is actually newer than what is
 * running. Both are cheap to get wrong and impossible to notice — a mode that says
 * "auto" in a portable build downloads an installer it can never install, and a
 * comparison that reads `0.10.0` as older than `0.9.0` stops offering updates
 * precisely when they matter.
 */

export function updateMode(env: {
  packaged: boolean
  /**
   * `process.env.PORTABLE_EXECUTABLE_DIR`, which electron-builder's portable stub
   * sets before launching the app (see its `templates/nsis/portable.nsi`). This is
   * the only reliable signal: `app-update.yml` is written into the shared resources
   * directory, so the portable exe contains one too and electron-updater will happily
   * check and download before failing at the install, which is the worst possible
   * moment to find out.
   */
  portableDir: string | undefined
}): UpdateMode {
  if (!env.packaged) return 'disabled'
  if (env.portableDir !== undefined && env.portableDir !== '') return 'notify'
  return 'auto'
}

/**
 * A release tag as numbers, or null when it is not a version at all.
 *
 * Tags carry a `v` by convention and the app's own version does not, so both forms
 * have to mean the same thing. A pre-release suffix is dropped rather than ordered:
 * this only serves the notify path, where the question is "is there something newer to
 * go and look at", and electron-updater does its own full semver comparison for the
 * path that installs anything.
 */
export function parseVersion(raw: string): number[] | null {
  const cleaned = raw.trim().replace(/^v/i, '').split(/[-+]/)[0]
  if (!/^\d+(\.\d+)*$/.test(cleaned)) return null
  return cleaned.split('.').map((part) => Number(part))
}

/**
 * Whether `candidate` is a later version than `current`.
 *
 * Compared segment by segment as numbers, so `0.10.0` beats `0.9.0` — which string
 * comparison gets backwards, and which is the bug that would quietly stop all updates
 * at the tenth minor release. Anything unparseable is not newer: a malformed tag
 * should never trigger an update prompt.
 */
export function isNewerVersion(candidate: string, current: string): boolean {
  const a = parseVersion(candidate)
  const b = parseVersion(current)
  if (a === null || b === null) return false
  const length = Math.max(a.length, b.length)
  for (let i = 0; i < length; i += 1) {
    const left = a[i] ?? 0
    const right = b[i] ?? 0
    if (left !== right) return left > right
  }
  return false
}

/**
 * The bits of `electron-updater`'s updater this app touches.
 *
 * Declared here rather than imported, so this module stays free of the dependency and
 * of Electron — which is what lets the verification suite reach it.
 */
export interface AutoUpdaterLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  /**
   * No blockmaps are built (`nsis.differentialPackage: false`), so looking for one is a
   * wasted request and an ERROR line that means nothing is wrong. The real run logged
   * exactly that: a 404 on `Matomeru-Setup-0.2.0.exe.blockmap`, then a full download.
   */
  disableDifferentialDownload: boolean
  /** electron-updater warns until this is said out loud, and we do not use one. */
  disableWebInstaller: boolean
  logger: unknown
  /*
    Only the three events this app listens to, typed for what each one carries. A
    catch-all signature would type every listener argument as `never` and push the
    casts out to the call sites, which is where they would rot.
  */
  on(
    event: 'download-progress',
    listener: (progress: { transferred: number; total: number; percent: number }) => void
  ): unknown
  on(event: 'update-downloaded', listener: () => void): unknown
  on(event: 'error', listener: (err: Error) => void): unknown
  checkForUpdates(): Promise<{ updateInfo: { version: string; releaseNotes?: unknown } } | null>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(): void
}

/**
 * Digs the updater out of whatever a dynamic import handed back.
 *
 * This exists because of a real failure: `const { autoUpdater } = await import(...)`
 * gave `undefined` in the packaged app, and the next line read `.checkForUpdates` off
 * it. The built main process is ESM and `electron-updater` is CommonJS, so Node has to
 * guess which named exports a CJS module offers. It does that with `cjs-module-lexer`,
 * which understands the `get: function () { return x }` form tsc emits — and not the
 * arrow-with-`||` form electron-updater actually uses:
 *
 *     Object.defineProperty(exports, "autoUpdater", {
 *       enumerable: true,
 *       get: () => { return _autoUpdater || doLoadAutoUpdater(); },
 *     })
 *
 * So no named export appears. What is guaranteed, whatever the lexer manages, is that
 * a CJS module's `default` **is** its `module.exports` — so that is the fallback, and
 * it is the one that actually works here.
 *
 * Null rather than a throw: the caller turns it into a message that says what went
 * wrong, which is more than the `TypeError` did.
 */
export function pickAutoUpdater(mod: unknown): AutoUpdaterLike | null {
  const namespace = mod as {
    autoUpdater?: AutoUpdaterLike
    default?: { autoUpdater?: AutoUpdaterLike }
  }
  return namespace?.autoUpdater ?? namespace?.default?.autoUpdater ?? null
}

/**
 * A fabricated update, for looking at the dialog without waiting for a release.
 *
 * `--fake-update=0.9.9`, and **only when the app is not packaged**. A test seam in
 * shipped code is normally the wrong trade; the case for this one is specific. The
 * dialog appears only in `auto` mode, `auto` mode exists only in a packaged install, so
 * without a seam the one path that matters is again the one nothing can exercise — which
 * is exactly how the updater's interop bug reached a release.
 *
 * Returning null when packaged is the whole guarantee, and it has a check of its own.
 */
export function parseFakeUpdate(argv: readonly string[], packaged: boolean): string | null {
  if (packaged) return null
  const flag = argv.find((arg) => arg.startsWith('--fake-update='))
  if (flag === undefined) return null
  const version = flag.slice('--fake-update='.length).trim()
  // Parsed the same way a real tag is, so nonsense cannot reach the dialog.
  return parseVersion(version) === null ? null : version
}

/**
 * Release notes as text, because they arrive as HTML.
 *
 * electron-updater's GitHub provider reads the releases feed, whose content is HTML, so
 * the dialog was showing raw markup. The two obvious alternatives are both worse:
 * `dangerouslySetInnerHTML` on a release body is not something to do, and a Markdown
 * parser would be a runtime dependency for decoration.
 *
 * Structure first, then tags, then entities — in that order, because stripping the tags
 * before reading them would throw away the list and paragraph boundaries that make the
 * result readable.
 */
export function notesToText(html: string): string {
  const withBreaks = html
    .replace(/<\s*(br|hr)\s*\/?>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '\n• ')
    .replace(/<\s*\/\s*(p|div|h[1-6]|li|ul|ol|tr)\s*>/gi, '\n')
    .replace(/<\s*(p|div|h[1-6])[^>]*>/gi, '\n')

  const withoutTags = withBreaks.replace(/<[^>]*>/g, '')

  const decoded = withoutTags
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    // Ampersand last, or an escaped entity like &amp;lt; would decode twice.
    .replace(/&amp;/gi, '&')
    .replace(/&#(\d+);/g, (_whole, code: string) => String.fromCodePoint(Number(code)))

  return decoded
    /*
      List items are not paragraphs.

      Each `</li>` ends a line and each `<li>` starts one, so a two-item list came out
      double-spaced — visible the moment it was looked at in the running app, and
      invisible to a check that only counts bullets.
    */
    .replace(/\n{2,}(?=• )/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line, index, all) => line.length > 0 || (index > 0 && all[index - 1].length > 0))
    .join('\n')
    .trim()
}
