/**
 * Updating from GitHub releases.
 *
 * Three behaviours from one surface, chosen by `updateMode`: an installed build
 * updates itself, a portable build reports what it found and offers the release page,
 * and an unpackaged build does nothing at all. The renderer sees one `UpdateState`
 * either way, so the Settings panel has a single thing to render rather than a branch
 * per build type.
 *
 * `electron-updater` is only ever touched in `auto` mode. It reads `app-update.yml`
 * from the packaged resources, which exists only because `electron-builder.yml` has a
 * `publish:` block — and outside a packaged app it is not there at all, which is why
 * `disabled` is a real mode rather than a courtesy.
 */
import { app, shell } from 'electron'
import type { ProgressEvent, UpdateState } from '@shared/types'
import { t } from '@shared/i18n/index.js'
import type { TranslationKey } from '@shared/types'
import { getLocale } from '../db/repos/settings.js'
import { isNewerVersion, updateMode } from './updateCheck.js'

function tr(key: TranslationKey, vars?: Record<string, string | number>): string {
  return t(getLocale(), key, vars)
}

const OWNER = 'Sfoucheur'
const REPO = 'matomeru'
const RELEASES_PAGE = `https://github.com/${OWNER}/${REPO}/releases`

export type ProgressSink = (event: ProgressEvent) => void

/**
 * The last thing a check or a download learned.
 *
 * Held in the main process rather than recomputed, because electron-updater reports
 * progress and completion through events: the renderer asks for the current picture
 * whenever it wants it, and nothing has to keep two copies in step.
 */
const state: {
  checkedAt: string | null
  available: { version: string; notes: string; url: string } | null
  downloaded: boolean
  downloading: boolean
  error: string | null
} = {
  checkedAt: null,
  available: null,
  downloaded: false,
  downloading: false,
  error: null
}

function mode(): ReturnType<typeof updateMode> {
  return updateMode({
    packaged: app.isPackaged,
    portableDir: process.env.PORTABLE_EXECUTABLE_DIR
  })
}

export function updateState(): UpdateState {
  return { mode: mode(), current: app.getVersion(), ...state }
}

/** Wired once, at startup, so events are never registered twice. */
let wired = false

/*
  The current progress sink, and whether the work in flight asked to be quiet.

  Both live here rather than in the listener closures, because the listeners are
  attached exactly once and would otherwise capture whatever the *first* caller passed
  forever. Today every caller passes the same broadcaster, so that would work by
  coincidence — and the coincidence is the bug: the next caller with a different sink
  would be silently ignored.

  `quiet` matters more. electron-updater reports failure through its `error` event, not
  through the promise, so a silent launch check against a repository with no releases
  would set an error the user never asked for and see it waiting in Settings. Silent
  has to mean silent on both routes out.
*/
let sink: ProgressSink = () => {}
let quiet = false

async function updater(onProgress: ProgressSink): Promise<typeof import('electron-updater').autoUpdater> {
  sink = onProgress
  /*
    Imported here rather than at the top of the module.

    `electron-updater` reads `app-update.yml` when it initialises, so importing it in
    an unpackaged build throws before any of our own code gets a chance to say the
    feature is unavailable. A dynamic import keeps `disabled` genuinely inert.
  */
  const { autoUpdater } = await import('electron-updater')

  if (!wired) {
    wired = true
    // Nothing downloads because the app launched. 96 MB moving unannounced is not a
    // courtesy, and the Settings panel asks explicitly.
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true
    // Its own logging goes nowhere by default; console is enough to diagnose a failed
    // update from a terminal run without adding a logging dependency.
    autoUpdater.logger = null

    autoUpdater.on('download-progress', (progress) => {
      sink({
        job: 'update',
        phase: 'Downloading',
        done: Math.round(progress.transferred),
        total: Math.round(progress.total),
        message: `${Math.round(progress.percent)}%`
      })
    })
    autoUpdater.on('update-downloaded', () => {
      state.downloaded = true
      state.downloading = false
      sink({ job: 'update', phase: 'Done', done: 1, total: 1, finished: true })
    })
    autoUpdater.on('error', (err) => {
      state.downloading = false
      if (!quiet) {
        state.error = err.message
        sink({
          job: 'update',
          phase: 'Failed',
          done: 1,
          total: 1,
          finished: true,
          error: err.message
        })
      }
    })
  }
  return autoUpdater
}

/**
 * Looks for something newer.
 *
 * `silent` is the difference between the check that runs at launch and the one behind
 * the button. A launch check that pops up to say GitHub was unreachable is worse than
 * one that says nothing: the user did not ask, and there is nothing for them to do.
 */
export async function checkForUpdates(
  onProgress: ProgressSink,
  options: { silent?: boolean } = {}
): Promise<UpdateState> {
  const current = mode()
  if (current === 'disabled') {
    state.error = options.silent === true ? null : tr('err.updateUnavailable')
    return updateState()
  }

  try {
    quiet = options.silent === true
    state.error = null
    if (current === 'notify') {
      const release = await latestRelease()
      state.available =
        release !== null && isNewerVersion(release.version, app.getVersion()) ? release : null
    } else {
      const updaterInstance = await updater(onProgress)
      const result = await updaterInstance.checkForUpdates()
      const version = result?.updateInfo.version
      state.available =
        version !== undefined && isNewerVersion(version, app.getVersion())
          ? {
              version,
              notes: typeof result?.updateInfo.releaseNotes === 'string'
                ? result.updateInfo.releaseNotes
                : '',
              url: `${RELEASES_PAGE}/tag/v${version}`
            }
          : null
    }
    state.checkedAt = new Date().toISOString()
  } catch (err) {
    // Recorded, not thrown: a failed check should leave the panel usable and saying
    // what went wrong, rather than surfacing as a broken button.
    state.error = (err as Error).message
    if (options.silent === true) state.error = null
  }
  /*
    `quiet` is deliberately not reset here. electron-updater reports failure through an
    event, and an event can arrive after the promise it belongs to has settled — so
    clearing the flag on the way out would leave a window where a silent check's error
    still gets recorded. Each entry point sets it instead, which has no window at all.
  */
  return updateState()
}

/**
 * The newest release, straight from the API.
 *
 * Used by the portable path, which has no `app-update.yml` worth reading. No token:
 * the repository is public, and unauthenticated GitHub allows sixty requests an hour
 * against one check per launch.
 *
 * A repository with no releases answers 404, and that is not an error — it is the
 * honest state of this project today, and it has to read as "nothing to update to".
 */
async function latestRelease(): Promise<{ version: string; notes: string; url: string } | null> {
  const response = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`, {
    headers: { accept: 'application/vnd.github+json' }
  })
  if (response.status === 404) return null
  if (!response.ok) {
    throw new Error(tr('err.updateCheckFailed', { status: response.status }))
  }
  const release = (await response.json()) as {
    tag_name?: string
    body?: string
    html_url?: string
    draft?: boolean
    prerelease?: boolean
  }
  if (release.draft === true || release.tag_name === undefined) return null
  return {
    version: release.tag_name.replace(/^v/i, ''),
    notes: release.body ?? '',
    url: release.html_url ?? RELEASES_PAGE
  }
}

/** Fetches the installer. Only ever reached in `auto` mode. */
export async function downloadUpdate(onProgress: ProgressSink): Promise<UpdateState> {
  if (mode() !== 'auto') throw new Error(tr('err.updateNotInstallable'))
  if (state.available === null) throw new Error(tr('err.updateNothingToGet'))
  try {
    // Asked for explicitly, so its failures are worth saying out loud.
    quiet = false
    state.downloading = true
    state.error = null
    const updaterInstance = await updater(onProgress)
    onProgress({ job: 'update', phase: 'Downloading', done: 0, total: 1 })
    await updaterInstance.downloadUpdate()
    /*
      Cleared here as well as in the `update-downloaded` listener. The listener is what
      normally does it, but if it ever fails to arrive this flag would stay raised and
      leave the button disabled for the rest of the session with no way back.
    */
    state.downloading = false
  } catch (err) {
    state.downloading = false
    state.error = (err as Error).message
    throw err
  }
  return updateState()
}

/**
 * Quits and hands over to the installer.
 *
 * Nothing is saved here on purpose: the database is committed after every write and
 * closed on `before-quit`, so there is no in-memory work to lose.
 */
export async function installUpdate(onProgress: ProgressSink): Promise<void> {
  if (mode() !== 'auto') throw new Error(tr('err.updateNotInstallable'))
  if (!state.downloaded) throw new Error(tr('err.updateNotDownloaded'))
  quiet = false
  const updaterInstance = await updater(onProgress)
  updaterInstance.quitAndInstall()
}

/** Opens the release page, which is all a portable build can offer. */
export async function openReleasePage(): Promise<void> {
  await shell.openExternal(state.available?.url ?? RELEASES_PAGE)
}
