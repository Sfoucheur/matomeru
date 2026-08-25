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
import { logDebug, logError, logInfo, logWarn } from './log.js'
import type { ProgressEvent, UpdateState } from '@shared/types'
import { t } from '@shared/i18n/index.js'
import type { TranslationKey } from '@shared/types'
import { getLocale } from '../db/repos/settings.js'
import {
  type AutoUpdaterLike,
  isNewerVersion,
  notesToText,
  parseFakeUpdate,
  pickAutoUpdater,
  updateMode
} from './updateCheck.js'

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

/*
  The version a fabricated update is pretending to be, or null.

  Remembered rather than re-derived per call, because everything downstream has to agree:
  a dialog that reports `disabled` mode disables its own Download button, so a seam that
  only fabricated the *notice* could show the dialog and never let anyone click through
  it — which is exactly how far this got before the real 0.2.0 release found the rest.

  It cannot be set in a packaged build: `parseFakeUpdate` refuses there, and a check
  asserts that.
*/
let pretending: string | null = null

function mode(): ReturnType<typeof updateMode> {
  return updateMode({
    packaged: app.isPackaged,
    portableDir: process.env.PORTABLE_EXECUTABLE_DIR
  })
}

export function updateState(): UpdateState {
  /*
    A rehearsal reports `auto`, because that is the arrangement being rehearsed. In an
    unpackaged build the real answer is `disabled`, and the dialog reads it: it would grey
    out its own Download button and the flow under test would be unreachable.
  */
  const reported = pretending === null ? mode() : 'auto'
  return { mode: reported, current: app.getVersion(), ...state }
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

/*
  Who to tell when the state changes.

  Without this the launch check wrote to the object above and stopped: the renderer read
  the state when its panel mounted and never again, so a found update was invisible
  unless someone walked to Settings and pressed the button. Pushing instead of polling is
  the fix, and the listener keeps the direction of dependency intact — this module still
  knows nothing about windows.
*/
let listener: ((state: UpdateState) => void) | null = null

export function setUpdateListener(fn: ((state: UpdateState) => void) | null): void {
  listener = fn
}

function announce(): UpdateState {
  const current = updateState()
  listener?.(current)
  return current
}

async function updater(onProgress: ProgressSink): Promise<AutoUpdaterLike> {
  sink = onProgress
  /*
    Imported here rather than at the top of the module.

    `electron-updater` reads `app-update.yml` when it initialises, so importing it in
    an unpackaged build throws before any of our own code gets a chance to say the
    feature is unavailable. A dynamic import keeps `disabled` genuinely inert.
  */
  const autoUpdater = pickAutoUpdater(await import('electron-updater'))
  if (autoUpdater === null) throw new Error(tr('err.updateModuleShape'))

  if (!wired) {
    wired = true
    // Nothing downloads because the app launched. 96 MB moving unannounced is not a
    // courtesy, and the Settings panel asks explicitly.
    autoUpdater.autoDownload = false
    /*
      Nothing installs without a click.

      This was true, and the log of a real run showed what that meant: the update was
      downloaded, "Later" was chosen, the app was closed, and it installed anyway —
      "Auto install update on quit". A prompt offering "install or not" has to be able to
      mean not.
    */
    autoUpdater.autoInstallOnAppQuit = false
    // No blockmaps are produced, so do not go looking for one and log a 404 about it.
    autoUpdater.disableDifferentialDownload = true
    // Said out loud, because electron-updater warns until it is.
    autoUpdater.disableWebInstaller = true
    /*
      Its own diagnostics, into our log rather than the bin.

      This was `null`, and that cost real time: when the updater failed on a CJS/ESM
      interop problem, electron-updater's own account of what it was doing went nowhere
      and all that surfaced was a TypeError in a toast.
    */
    autoUpdater.logger = {
      info: (m: unknown) => logInfo('updater', String(m)),
      warn: (m: unknown) => logWarn('updater', String(m)),
      error: (m: unknown) => logError('updater', String(m)),
      debug: (m: unknown) => logDebug('updater', String(m))
    }

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
      // The dialog is waiting to become "Restart and install", and this is what tells it.
      announce()
    })
    autoUpdater.on('error', (err) => {
      state.downloading = false
      if (!quiet) {
        state.error = err.message
        announce()
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

  /*
    The fabricated update comes first, and short-circuits everything: in an unpackaged
    build the mode is `disabled`, so anything after this point would refuse to look.
  */
  const faked = parseFakeUpdate(process.argv, app.isPackaged)
  if (faked !== null) {
    pretending = faked
    state.available = {
      version: faked,
      /*
        HTML, and then converted, because that is what a real release feed hands over.
        Fake notes that were already plain text would have looked perfect throughout the
        exact bug this seam exists to look at.
      */
      notes: notesToText(
        `<h2>Pretend release notes for ${faked}</h2>` +
          '<ul><li>Something was fixed &amp; tidied</li>' +
          "<li>It&#39;s only a rehearsal</li></ul>" +
          '<p>Nothing here was really released.</p>'
      ),
      url: `${RELEASES_PAGE}/tag/v${faked}`
    }
    state.checkedAt = new Date().toISOString()
    state.error = null
    return announce()
  }

  if (current === 'disabled') {
    state.error = options.silent === true ? null : tr('err.updateUnavailable')
    return announce()
  }

  let failure: string | null = null
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
              // The feed hands these over as HTML; the dialog shows text.
              notes: typeof result?.updateInfo.releaseNotes === 'string'
                ? notesToText(result.updateInfo.releaseNotes)
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
    // Kept for the log even when the panel is not told: a silent check that fails every
    // launch is exactly the thing a log is for.
    failure = state.error
    if (options.silent === true) state.error = null
  }
  /*
    `quiet` is deliberately not reset here. electron-updater reports failure through an
    event, and an event can arrive after the promise it belongs to has settled — so
    clearing the flag on the way out would leave a window where a silent check's error
    still gets recorded. Each entry point sets it instead, which has no window at all.
  */
  /*
    The outcome, in one line.

    electron-updater logs "Update for version X is not available" itself, but only on the
    `auto` route and only when it gets that far: a disabled build, the portable route and
    a thrown check all left the log holding a "Checking for update" with no answer under
    it. Reading a log to find out whether a check happened should not need inference.
  */
  logInfo(
    'updates',
    failure !== null
      ? `check failed (${current}${options.silent === true ? ', silent' : ''}): ${failure}`
      : state.available === null
        ? `up to date (${current}, running ${app.getVersion()})`
        : `${state.available.version} available (${current}, running ${app.getVersion()})`
  )
  return announce()
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
    notes: notesToText(release.body ?? ''),
    url: release.html_url ?? RELEASES_PAGE
  }
}

/** Fetches the installer. Only ever reached in `auto` mode. */
export async function downloadUpdate(onProgress: ProgressSink): Promise<UpdateState> {
  if (pretending !== null) return rehearseDownload(onProgress)
  if (mode() !== 'auto') throw new Error(tr('err.updateNotInstallable'))
  if (state.available === null) throw new Error(tr('err.updateNothingToGet'))
  try {
    // Asked for explicitly, so its failures are worth saying out loud.
    quiet = false
    state.downloading = true
    state.error = null
    /*
      Announced before the await, which is the whole point.

      Without this the renderer learned nothing until the transfer finished, so clicking
      Download left the button saying "Download update" while 96 MB moved behind it.
      Nothing was broken; it just looked inert, which is worse than an error.
    */
    announce()
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
    announce()
    throw err
  }
  return announce()
}

/**
 * A download that moves, without a release to download.
 *
 * Slow on purpose: the two things worth watching both happen *during* a transfer — the
 * dialog has to get out of the way and stay away while the progress bar runs, and it has
 * to come back as "ready to install" when the bar finishes. A rehearsal that completed
 * instantly would show neither.
 */
async function rehearseDownload(onProgress: ProgressSink): Promise<UpdateState> {
  const steps = 8
  const bytes = 96 * 1024 * 1024
  quiet = false
  state.downloading = true
  state.downloaded = false
  state.error = null
  announce()
  for (let step = 1; step <= steps; step++) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    const done = Math.round((bytes * step) / steps)
    onProgress({ job: 'update', phase: 'Downloading', done, total: bytes })
    announce()
  }
  state.downloading = false
  state.downloaded = true
  onProgress({ job: 'update', phase: 'Done', done: 1, total: 1, finished: true })
  logInfo('updates', `rehearsal: ${pretending ?? '?'} "downloaded"`)
  return announce()
}

/**
 * Quits and hands over to the installer.
 *
 * Nothing is saved here on purpose: the database is committed after every write and
 * closed on `before-quit`, so there is no in-memory work to lose.
 */
export async function installUpdate(onProgress: ProgressSink): Promise<void> {
  if (pretending !== null) {
    /*
      As far as it can go. `quitAndInstall` on an unpackaged build has no installer to
      hand over to, so this says what would have happened and puts the state back to
      "nothing pending" — which is what a successful install looks like from here.
    */
    logInfo('updates', `rehearsal: would install ${pretending} and restart`)
    state.available = null
    state.downloaded = false
    announce()
    return
  }
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
