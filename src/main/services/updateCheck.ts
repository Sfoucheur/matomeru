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
