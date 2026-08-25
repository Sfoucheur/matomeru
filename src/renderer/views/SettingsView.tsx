import { useEffect, useState } from 'react'
import {
  AlertCircle,
  ClipboardCopy,
  CloudUpload,
  Download,
  FileText,
  ExternalLink,
  FolderOpen,
  Link2,
  Link2Off,
  PackageOpen,
  RefreshCw,
  Save
} from 'lucide-react'
import { THEMES, type Currency, type LocaleSetting, type ThemeMode } from '@shared/types'
import {
  LOCALES,
  LOCALE_NAMES,
  resolveLocale,
  t as tFor
} from '@shared/i18n/index'
import { useT } from '../hooks/useT'
import { guard, useApp } from '../store/app'
import type { ViewProps } from '../App'
import { Button, Select } from '../components/primitives'
import LabelPossessionPanel from '../components/LabelPossessionPanel'
import { UpdateDot } from '../components/UpdateDialog'
import type { BackupStatus, UpdateState } from '@shared/types'
import { count, megabytes, relativeTime } from '../lib/format'

/**
 * The tabs, in the order they are used rather than the order they were written.
 *
 * Grouped by what someone came to change: their collection's behaviour, how it looks,
 * where it is backed up, and facts about the app itself.
 */
const TABS = [
  { id: 'collection', label: 'settings.tabCollection' },
  { id: 'appearance', label: 'settings.tabAppearance' },
  { id: 'backup', label: 'settings.tabBackup' },
  { id: 'about', label: 'settings.tabAbout' }
] as const

type SettingsTab = (typeof TABS)[number]['id']

export default function SettingsView(_props: ViewProps): React.ReactElement {
  /*
    Local state, deliberately. This app persists screen state that is expensive to
    rebuild — a selected deck, a filter, a scroll position. Which settings tab was last
    open is none of those.
  */
  const [tab, setTab] = useState<SettingsTab>('collection')
  const settings = useApp((s) => s.settings)
  const updateSettings = useApp((s) => s.updateSettings)
  const toast = useApp((s) => s.toast)
  const t = useT()
  const invalidate = useApp((s) => s.invalidate)

  const [username, setUsername] = useState('')
  const [syncing, setSyncing] = useState(false)

  /*
    Read off <html> rather than recomputed from the setting: with `system`
    chosen, the store's media listener is what decides, so this is the one
    source of truth for whether the pure-black row applies.
  */
  const resolvedDark = document.documentElement.classList.contains('dark')

  useEffect(() => {
    setUsername(settings?.archidektUsername ?? '')
  }, [settings?.archidektUsername])

  if (!settings) {
    return <div className="skeleton m-5 h-40 rounded-xl" />
  }

  const saveUsername = async (): Promise<void> => {
    await updateSettings({ archidektUsername: username.trim() })
    toast(
      'success',
      username.trim()
        ? t('settings.usernameSet', { username: username.trim() })
        : t('settings.usernameCleared')
    )
  }

  const syncNow = async (): Promise<void> => {
    if (!username.trim()) {
      toast('warn', t('settings.usernameFirst'))
      return
    }
    await updateSettings({ archidektUsername: username.trim() })
    setSyncing(true)
    const result = await guard(() => window.api.decks.syncUser(username.trim()))
    setSyncing(false)
    if (result) {
      toast('success', `Synced ${result.synced} deck(s); ${result.skipped} unchanged.`)
      invalidate()
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="shrink-0 px-5 pb-3 pt-4">
        <h1 className="text-lg font-semibold tracking-tight text-ink-50">{t('settings.title')}</h1>
      </header>

      {/*
        Tabs, and the width the screen already had.

        This was one `max-w-2xl` column of nine stacked panels: on a 1440-wide window most
        of the screen was empty and everything past the third panel was below the fold.
        The panels are unchanged — they are grouped and given room.
      */}
      <div className="shrink-0 border-b border-ink-800 px-5">
        <div className="flex gap-1" role="tablist">
          {TABS.map((entry) => {
            const active = tab === entry.id
            return (
              <button
                key={entry.id}
                role="tab"
                aria-selected={active}
                onClick={() => setTab(entry.id)}
                data-tab={entry.id}
                className={`relative -mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
                  active
                    ? 'border-gold-400 text-ink-50'
                    : 'border-transparent text-ink-400 hover:text-ink-200'
                }`}
              >
                {t(entry.label)}
                {entry.id === 'about' && <UpdateDot />}
              </button>
            )
          })}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {/*
          Two columns once there is room for them, and `items-start` so a short panel
          beside a tall one does not stretch to match it.
        */}
        {/*
          Two columns that pack independently, not a grid.

          A grid makes every row as tall as its tallest item, so a short panel beside a
          long one reserved the difference as dead space — 235px of nothing under the
          Archidekt panel, next to the label colours. `items-start` stopped the short
          panel stretching but not the row reserving the height. Flex columns cannot do
          that: a column simply ends when it runs out of panels.

          The cost is that panels are assigned a side by hand. With four on the busiest
          tab that is a fair price for never having a gap; an auto-balancing multi-column
          layout would remove the choice and scatter related settings instead.
        */}
        <div className="mx-auto flex max-w-6xl flex-col gap-4 xl:flex-row xl:items-start">
          {tab === 'collection' && (
            <>
              <div className="flex min-w-0 flex-1 flex-col gap-4">
                        <section className="panel p-4">
                          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-ink-400">
                            {t('settings.archidekt')}
                          </h2>
                          <label className="flex flex-col gap-1.5 text-[11px] text-ink-400">
                            {t('settings.username')}
                            <div className="flex gap-2">
                              <input
                                value={username}
                                onChange={(e) => setUsername(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') void saveUsername()
                                }}
                                placeholder={t('settings.usernamePlaceholder')}
                                className="field min-w-0 flex-1 text-sm outline-none placeholder:text-ink-600"
                              />
                              <Button icon={<Save size={13} />} onClick={() => void saveUsername()}>
                                {t('common.save')}
                              </Button>
                              <Button
                                variant="primary"
                                icon={<RefreshCw size={13} className={syncing ? 'animate-spin' : ''} />}
                                onClick={() => void syncNow()}
                                disabled={syncing}
                              >
                                {syncing ? t('settings.syncing') : t('settings.syncNow')}
                              </Button>
                            </div>
                          </label>

                          <p className="mt-3 text-[11px] leading-relaxed text-ink-500">
                            {t('settings.syncNote')}
                          </p>
                          <p className="mt-2 text-[11px] leading-relaxed text-ink-500">
                            {t('settings.privateNote')}
                          </p>
                          <a
                            href="https://archidekt.com"
                            target="_blank"
                            rel="noreferrer"
                            className="mt-2.5 inline-flex items-center gap-1.5 text-[11px] text-ink-400 underline-offset-2 hover:text-gold-400 hover:underline"
                          >
                            <ExternalLink size={11} />
                            {t('settings.openArchidekt')}
                          </a>
                        </section>

                        <section className="panel p-4">
                          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-ink-400">
                            {t('settings.pricesTitle')}
                          </h2>

                          <div className="space-y-3.5">
                            <label className="flex items-center justify-between gap-4">
                              <span className="text-sm text-ink-200">
                                {t('settings.currency')}
                                <span className="mt-0.5 block text-[11px] text-ink-500">
                                  {t('settings.currencyHint')}
                                </span>
                              </span>
                              <Select
                                className="w-28 shrink-0"
                                value={settings.currency}
                                onChange={(currency: Currency) => void updateSettings({ currency })}
                                options={[
                                  { value: 'usd', label: 'USD ($)' },
                                  { value: 'eur', label: 'EUR (€)' }
                                ]}
                              />
                            </label>

                            <label className="flex items-start justify-between gap-4">
                              <span className="text-sm text-ink-200">
                                {t('settings.exactMatch')}
                                <span className="mt-0.5 block text-[11px] leading-relaxed text-ink-500">
                                  {t('settings.exactMatchHint')}
                                </span>
                              </span>
                              <input
                                type="checkbox"
                                checked={settings.deckMatchExact}
                                onChange={(e) => void updateSettings({ deckMatchExact: e.target.checked })}
                                className="mt-1 shrink-0 accent-gold-500"
                              />
                            </label>

                            <p className="text-[11px] text-ink-500">
                              {t('settings.pricesRefreshed', {
                                when: relativeTime(settings.lastPriceSync)
                              })}
                            </p>
                          </div>
                        </section>

                <BoosterDataPanel />
              </div>

              {/* The long one, alone, so nothing has to match its height. */}
              <div className="flex min-w-0 flex-1 flex-col gap-4">
                <section className="panel p-4">
                  <h2 className="mb-1 text-xs font-semibold uppercase tracking-wider text-ink-400">
                    {t('settings.labelsTitle')}
                  </h2>
                  <LabelPossessionPanel />
                </section>
              </div>
            </>
          )}

          {/* One wide panel: the theme swatches are the reason this tab wants the room. */}
          {tab === 'appearance' && (
            <div className="w-full">
                        <section className="panel p-4">
                          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-ink-400">
                            {t('settings.appearance')}
                          </h2>

                          <label className="mb-3.5 flex items-center justify-between gap-4">
                            <span className="text-sm text-ink-200">
                              {t('settings.language')}
                              <span className="mt-0.5 block text-[11px] text-ink-500">
                                {t('settings.languageHint')}
                              </span>
                            </span>
                            <Select
                              className="w-40 shrink-0"
                              value={settings.locale}
                              onChange={(locale: LocaleSetting) => {
                                void updateSettings({ locale }).then(() => {
                                  const resolved = resolveLocale(locale, navigator.language)
                                  toast(
                                    'success',
                                    tFor(resolved, 'settings.languageChanged', {
                                      language: LOCALE_NAMES[resolved]
                                    })
                                  )
                                })
                              }}
                              options={[
                                { value: 'system', label: t('settings.languageSystem') },
                                ...LOCALES.map((code) => ({ value: code, label: LOCALE_NAMES[code] }))
                              ]}
                            />
                          </label>

                          <label className="mb-3.5 flex items-center justify-between gap-4">
                            <span className="text-sm text-ink-200">
                              {t('settings.themeMode')}
                              <span className="mt-0.5 block text-[11px] text-ink-500">
                                {t('settings.themeModeHint')}
                              </span>
                            </span>
                            {/* The hook sits on a wrapper because Select takes a closed set of
                                props and would drop it. It exists so checks can reach this
                                control without matching a label that changes with the
                                language — selecting by visible text is exactly how the theme
                                probe first reported false passes against the French UI. */}
                            <span data-setting="themeMode" className="w-40 shrink-0">
                              <Select
                                className="w-full"
                                value={settings.themeMode}
                                onChange={(themeMode: ThemeMode) => void updateSettings({ themeMode })}
                                options={[
                                  { value: 'system', label: t('settings.themeModeSystem') },
                                  { value: 'light', label: t('settings.themeModeLight') },
                                  { value: 'dark', label: t('settings.themeModeDark') }
                                ]}
                              />
                            </span>
                          </label>

                          {/*
                            Pure black only means something against a dark shell, so it is
                            hidden rather than disabled in light mode — a disabled control
                            invites the question of how to enable it.
                          */}
                          {resolvedDark && (
                            <label className="mb-3.5 flex items-start justify-between gap-4">
                              <span className="text-sm text-ink-200">
                                {t('settings.pureBlack')}
                                <span className="mt-0.5 block text-[11px] text-ink-500">
                                  {t('settings.pureBlackHint')}
                                </span>
                              </span>
                              <input
                                type="checkbox"
                                data-setting="pureBlack"
                                checked={settings.pureBlack}
                                onChange={(e) => void updateSettings({ pureBlack: e.target.checked })}
                                className="mt-1 shrink-0 accent-gold-500"
                              />
                            </label>
                          )}

                          <div className="mb-3.5">
                            <span className="text-sm text-ink-200">
                              {t('settings.theme')}
                              <span className="mt-0.5 block text-[11px] text-ink-500">
                                {t('settings.themeHint')}
                              </span>
                            </span>
                            {/*
                              Swatches rather than a dropdown: each one previews its own accent
                              over its own shell, so the choice is visible before it is made.
                              A name alone does not tell you what "Tako" looks like.
                            */}
                            <div className="mt-2.5 grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                              {THEMES.map((theme) => {
                                const active = settings.theme === theme.name
                                return (
                                  <button
                                    key={theme.name}
                                    type="button"
                                    aria-pressed={active}
                                    onClick={() => void updateSettings({ theme: theme.name })}
                                    className={`flex items-center gap-2 rounded-lg border px-2 py-1.5 text-left transition-colors ${
                                      active
                                        ? 'border-gold-500 bg-ink-750'
                                        : 'border-ink-700 hover:border-ink-600 hover:bg-ink-800'
                                    }`}
                                  >
                                    <span
                                      aria-hidden
                                      className="grid h-6 w-6 shrink-0 place-items-center rounded-md border border-black/30"
                                      style={{ backgroundColor: theme.shell }}
                                    >
                                      <span
                                        className="h-3 w-3 rounded-full"
                                        style={{ backgroundColor: theme.swatch }}
                                      />
                                    </span>
                                    <span className="truncate text-xs text-ink-200">{theme.label}</span>
                                  </button>
                                )
                              })}
                            </div>
                          </div>

                          <label className="flex items-start justify-between gap-4">
                            <span className="text-sm text-ink-200">
                              {t('settings.reduceMotion')}
                              <span className="mt-0.5 block text-[11px] text-ink-500">
                                {t('settings.reduceMotionHint')}
                              </span>
                            </span>
                            <input
                              type="checkbox"
                              checked={settings.reduceMotion}
                              onChange={(e) => void updateSettings({ reduceMotion: e.target.checked })}
                              className="mt-1 shrink-0 accent-gold-500"
                            />
                          </label>
                        </section>

            </div>
          )}

          {tab === 'backup' && (
            <>
              <div className="flex min-w-0 flex-1 flex-col gap-4">
                <BackupPanel />
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-4">
                <section className="panel p-4 text-[11px] leading-relaxed text-ink-500">
                  <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-400">
                    {t('settings.dataTitle')}
                  </h2>
                  <p>{t('settings.dataNote1')}</p>
                  <p className="mt-2">{t('settings.dataNote2')}</p>
                </section>
              </div>
            </>
          )}

          {tab === 'about' && (
            <>
              <div className="flex min-w-0 flex-1 flex-col gap-4">
                <UpdatePanel />
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-4">
                <DiagnosticsPanel />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Booster odds for the whole collection, in one run.
 *
 * The per-card panel could only ever fetch one set at a time, so a collection
 * spanning dozens of sets meant dozens of clicks and mostly showed nothing. This
 * lists only the sets you own booster-eligible cards from — precon-only sets are
 * left out, because Scryfall's booster flag already answers those offline and no
 * download would add anything.
 */
/**
 * Getting at the log without a terminal.
 *
 * A packaged Electron app on Windows has no console, so "check the output" is not advice
 * anyone can follow. These three buttons are the whole answer: open the file, open the
 * folder it is in, or copy the handful of facts a bug report always needs.
 */
function DiagnosticsPanel(): React.ReactElement {
  const t = useT()
  const toast = useApp((s) => s.toast)

  const copy = async (): Promise<void> => {
    const report = await guard(() => window.api.diagnostics.copy())
    if (report === undefined) return
    toast('success', t('diag.copied'))
  }

  /*
    `shell.openPath` answers with a message on failure rather than throwing, so an empty
    string is success and anything else is the reason it did not work.
  */
  const open = async (which: 'file' | 'folder'): Promise<void> => {
    const problem = await guard(() =>
      which === 'file'
        ? window.api.diagnostics.openLogFile()
        : window.api.diagnostics.openLogFolder()
    )
    if (problem === undefined) return
    if (problem !== '') toast('error', t('err.logOpenFailed', { reason: problem }))
  }

  return (
    <section className="panel p-4" data-setting="diagnostics">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-ink-400">
        {t('diag.title')}
      </h2>

      <p className="text-[11px] leading-relaxed text-ink-500">{t('diag.intro')}</p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          icon={<FileText size={13} />}
          onClick={() => void open('file')}
          data-action="openLogFile"
        >
          {t('diag.openLog')}
        </Button>
        <Button
          icon={<FolderOpen size={13} />}
          onClick={() => void open('folder')}
          data-action="openLogFolder"
        >
          {t('diag.openFolder')}
        </Button>
        <Button
          icon={<ClipboardCopy size={13} />}
          onClick={() => void copy()}
          data-action="copyDiagnostics"
        >
          {t('diag.copy')}
        </Button>
      </div>

      <p className="mt-3 text-[11px] leading-relaxed text-ink-500">{t('diag.debugHint')}</p>
    </section>
  )
}

/**
 * Updating, in whichever of its three forms this build supports.
 *
 * One state shape covers all of them, so this renders a single line of status and
 * whichever single action makes sense — rather than a matrix of buttons most of which
 * cannot work. A portable build cannot replace itself and says so; a build running
 * from source has no update feed at all and says that.
 */
function UpdatePanel(): React.ReactElement {
  const t = useT()
  const toast = useApp((s) => s.toast)
  const settings = useApp((s) => s.settings)
  const updateSettings = useApp((s) => s.updateSettings)
  const [state, setState] = useState<UpdateState | null>(null)
  const [busy, setBusy] = useState(false)

  const read = async (): Promise<void> => {
    const next = await guard(() => window.api.updates.state())
    if (next) setState(next)
  }

  useEffect(() => {
    void read()
  }, [])

  const check = async (): Promise<void> => {
    setBusy(true)
    const next = await guard(() => window.api.updates.check())
    setBusy(false)
    if (!next) return
    setState(next)
    // Said out loud, because this one was asked for. The launch check stays silent.
    if (next.error !== null) toast('error', next.error)
    else if (next.available === null) toast('info', t('updates.upToDate'))
    else toast('success', t('updates.available', { version: next.available.version }))
  }

  const download = async (): Promise<void> => {
    setBusy(true)
    const next = await guard(() => window.api.updates.download())
    setBusy(false)
    if (next) setState(next)
  }

  const install = async (): Promise<void> => {
    // Nothing to report afterwards: this quits the app.
    await guard(() => window.api.updates.install())
  }

  const mode = state?.mode ?? 'disabled'
  const available = state?.available ?? null

  return (
    <section className="panel p-4" data-setting="updates">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-ink-400">
        {t('updates.title')}
      </h2>

      <p className="numeric text-sm text-ink-200" data-field="currentVersion">
        {t('updates.current', { version: state?.current ?? '—' })}
      </p>

      {/* What this build can do about it, stated before any button is offered. */}
      {mode === 'disabled' && (
        <p className="mt-2 text-[11px] leading-relaxed text-ink-500">{t('updates.disabled')}</p>
      )}
      {mode === 'notify' && (
        <p className="mt-2 text-[11px] leading-relaxed text-ink-500">{t('updates.portable')}</p>
      )}

      <p className="mt-2 text-[11px] leading-relaxed text-ink-400" data-field="updateStatus">
        {state === null
          ? t('updates.checking')
          : state.error !== null
            ? state.error
            : state.downloaded && available !== null
              ? t('updates.ready', { version: available.version })
              : available !== null
                ? t('updates.available', { version: available.version })
                : state.checkedAt === null
                  ? t('updates.never')
                  : t('updates.upToDate')}
      </p>

      {state?.checkedAt !== null && state?.checkedAt !== undefined && (
        <p className="mt-1 text-[11px] text-ink-600">
          {t('updates.checkedAt', { when: relativeTime(state.checkedAt) })}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          icon={<RefreshCw size={13} className={busy ? 'animate-spin' : ''} />}
          onClick={() => void check()}
          disabled={busy || mode === 'disabled'}
          data-action="checkUpdates"
        >
          {busy ? t('updates.checking') : t('updates.check')}
        </Button>

        {/* One action at a time, and only the one that applies. */}
        {mode === 'auto' && available !== null && !state?.downloaded && (
          <Button
            variant="primary"
            icon={<Download size={13} />}
            onClick={() => void download()}
            disabled={busy || state?.downloading === true}
            data-action="downloadUpdate"
          >
            {state?.downloading === true ? t('updates.downloading') : t('updates.download')}
          </Button>
        )}
        {mode === 'auto' && state?.downloaded === true && (
          <Button
            variant="primary"
            icon={<RefreshCw size={13} />}
            onClick={() => void install()}
            data-action="installUpdate"
          >
            {t('updates.install')}
          </Button>
        )}
        {mode === 'notify' && available !== null && (
          <Button
            variant="primary"
            icon={<ExternalLink size={13} />}
            onClick={() => void guard(() => window.api.updates.openRelease())}
            data-action="openRelease"
          >
            {t('updates.openPage')}
          </Button>
        )}
      </div>

      {settings && (
        <label className="mt-3 flex items-start justify-between gap-4">
          <span className="text-sm text-ink-200">
            {t('updates.onLaunch')}
            <span className="mt-0.5 block text-[11px] text-ink-500">
              {t('updates.onLaunchHint')}
            </span>
          </span>
          <input
            type="checkbox"
            checked={settings.checkUpdatesOnLaunch}
            onChange={(e) => void updateSettings({ checkUpdatesOnLaunch: e.target.checked })}
            className="mt-1 shrink-0 accent-gold-500"
            data-field="checkUpdatesOnLaunch"
          />
        </label>
      )}
    </section>
  )
}

/**
 * The Drive connection, and the three things you can do with it.
 *
 * Connect, name the folder, back up now, restore. Nothing to configure: the OAuth
 * client is compiled into the build, so the panel asks for no credential and cannot
 * display one — `backup:status` returns none by construction.
 *
 * The folder is named rather than browsed to. Browsing needs either Google's Picker,
 * with a second credential and a window of its own, or the full `drive` scope, which
 * is restricted and would have the consent screen announce that this app can read
 * everything in your Drive. Naming it costs a text field and keeps the narrow scope.
 */
function BackupPanel(): React.ReactElement {
  const t = useT()
  const toast = useApp((s) => s.toast)
  const openBackup = useApp((s) => s.openBackup)
  const [status, setStatus] = useState<BackupStatus | null>(null)
  const [folder, setFolder] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = async (): Promise<void> => {
    const next = await guard(() => window.api.backup.status())
    if (!next) return
    setStatus(next)
    // The field follows the stored name, so it never shows something that is not
    // what the next backup will actually use.
    setFolder(next.folderName)
  }

  useEffect(() => {
    void refresh()
  }, [])

  const connect = async (): Promise<void> => {
    setBusy(true)
    const ok = await guard(() => window.api.backup.connect())
    setBusy(false)
    if (!ok) return
    toast('success', t('settings.backupConnected'))
    void refresh()
  }

  const disconnect = async (): Promise<void> => {
    const ok = await guard(() => window.api.backup.disconnect())
    if (!ok) return
    toast('info', t('settings.backupDisconnected'))
    void refresh()
  }

  const saveFolder = async (): Promise<void> => {
    const saved = await guard(() => window.api.backup.setFolderName(folder))
    if (saved === undefined) return
    // Echoed back from the main process rather than assumed: a blank entry falls back
    // to the default there, and the field should show what was actually stored.
    setFolder(saved)
    toast('success', t('settings.backupFolderSaved', { name: saved }))
    void refresh()
  }

  const backUpNow = async (): Promise<void> => {
    setBusy(true)
    const result = await guard(() => window.api.backup.save(false))
    setBusy(false)
    if (!result) return
    toast(
      result.uploaded ? 'success' : 'info',
      result.uploaded
        ? t('backup.saved', { size: megabytes(result.bytes), label: status?.label ?? 'Drive' })
        : t('backup.nothingSent')
    )
    void refresh()
  }

  return (
    <section className="panel p-4" data-setting="backup">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-ink-400">
        {t('settings.backupTitle')}
      </h2>

      <p className="text-[11px] leading-relaxed text-ink-500">{t('settings.backupIntro')}</p>

      {/* Only a build with no client of its own has to explain itself. When one is
          compiled in there is nothing to set up, and saying so would be noise. */}
      {status !== null && !status.bundled && (
        <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-warn">
          <AlertCircle size={12} className="mt-0.5 shrink-0" />
          {t('settings.backupNoClient')}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {status?.connected ? (
          <Button icon={<Link2Off size={13} />} onClick={() => void disconnect()}>
            {t('settings.backupDisconnect')}
          </Button>
        ) : (
          <Button
            variant="primary"
            icon={<Link2 size={13} />}
            onClick={() => void connect()}
            disabled={busy || status?.configured !== true}
            data-action="backupConnect"
          >
            {t('settings.backupConnect')}
          </Button>
        )}
        <Button
          icon={<CloudUpload size={13} />}
          onClick={() => void backUpNow()}
          disabled={busy || status?.connected !== true}
          data-action="backupNow"
        >
          {t('settings.backupNow')}
        </Button>
        {/* Through the dialog, not straight from here: a restore replaces everything
            on this machine, so it goes past the same acknowledgement either way in. */}
        <Button
          variant="danger"
          icon={<Download size={13} />}
          onClick={() => openBackup('restore')}
          disabled={status?.connected !== true || status?.remote === null}
          data-action="backupRestore"
        >
          {t('settings.backupRestore')}
        </Button>
      </div>

      {status?.error !== null && status?.error !== undefined && (
        <p className="mt-3 flex items-start gap-1.5 text-[11px] leading-relaxed text-bad">
          <AlertCircle size={12} className="mt-0.5 shrink-0" />
          {status.error}
        </p>
      )}

      {/* Where the snapshot lands. Named even before a choice is made, because
          "somewhere in your Drive" is not something a backup should leave vague. */}
      {/*
        Editable whether or not you are connected: a folder name needs no token, and a
        control greyed out for reasons it does not explain is worse than no control.
      */}
      <label
        className="mt-3 flex flex-col gap-1.5 text-[11px] text-ink-400"
        data-field="backupFolder"
      >
        {t('settings.backupFolder')}
        <div className="flex gap-2">
          <input
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void saveFolder()
            }}
            placeholder={t('settings.backupFolderPlaceholder')}
            spellCheck={false}
            className="field min-w-0 flex-1 text-sm outline-none placeholder:text-ink-600"
            data-field="backupFolderName"
          />
          <Button
            icon={<FolderOpen size={13} />}
            onClick={() => void saveFolder()}
            data-action="backupSaveFolder"
          >
            {t('common.save')}
          </Button>
        </div>
        <span className="text-[11px] leading-relaxed text-ink-500">
          {t('settings.backupFolderHint')}
        </span>
      </label>

      <p className="mt-3 text-[11px] text-ink-500">
        {status?.lastBackupAt
          ? t('settings.backupLast', { when: relativeTime(status.lastBackupAt) })
          : t('backup.never')}
      </p>

    </section>
  )
}

function BoosterDataPanel(): React.ReactElement {
  const t = useT()
  const toast = useApp((s) => s.toast)
  const invalidate = useApp((s) => s.invalidate)
  const [sets, setSets] = useState<{ set_code: string; cards: number; fetched: boolean }[]>([])
  const [busy, setBusy] = useState(false)
  /** Sets whose download failed — worth another attempt, unlike a 404. */
  const [failed, setFailed] = useState<string[]>([])

  const reload = (): void => {
    void window.api.boosters
      .sets()
      .then(setSets)
      .catch(() => setSets([]))
  }
  useEffect(reload, [])

  const missing = sets.filter((set) => !set.fetched)

  const run = async (): Promise<void> => {
    setBusy(true)
    const result = await guard(() => window.api.boosters.loadForCollection())
    setBusy(false)
    if (result) {
      setFailed(result.failed)
      toast(
        result.failed.length ? 'warn' : 'success',
        result.failed.length
          ? t('boosters.loadAllFailed', {
              sets: result.sets,
              failed: result.failed.join(', ')
            })
          : t('boosters.loadAllDone', { sets: result.sets, skipped: result.skipped })
      )
      if (result.noData.length) {
        // Worth saying out loud: these are settled, not pending, so they will not
        // be offered again.
        toast('warn', t('boosters.loadAllNoData', { sets: result.noData.join(', ') }))
      }
      reload()
      // Booster odds are shown inside card details opened from any screen, and
      // every visited view stays mounted — so without this the panel behind this
      // one keeps answering from before the run.
      invalidate()
    }
  }

  return (
    <section className="panel p-4">
      <h2 className="mb-3 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-ink-400">
        <PackageOpen size={12} />
        {t('boosters.title')}
      </h2>

      <p className="mb-3 text-[11px] leading-relaxed text-ink-500">{t('boosters.loadAllHint')}</p>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          icon={<RefreshCw size={13} className={busy ? 'animate-spin' : ''} />}
          onClick={() => void run()}
          disabled={busy || missing.length === 0}
        >
          {t('boosters.loadAll')}
        </Button>
        <span className="numeric text-[11px] text-ink-500">
          {missing.length === 0
            ? t('boosters.loadAllNothing')
            : `${count(missing.length)} / ${count(sets.length)}`}
        </span>
      </div>

      {failed.length > 0 && (
        <p className="mt-2.5 flex flex-wrap items-center gap-2 rounded-lg border border-warn/30
          bg-warn/[0.08] px-3 py-2 text-[11px] leading-relaxed text-warn">
          <AlertCircle size={13} className="shrink-0" />
          <span className="min-w-0 flex-1">
            {t('boosters.retryHint', { sets: failed.join(', ') })}
          </span>
          <Button size="sm" onClick={() => void run()} disabled={busy}>
            {t('boosters.retry', { count: failed.length })}
          </Button>
        </p>
      )}

      {sets.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {sets.map((set) => (
            <span
              key={set.set_code}
              title={t('boosters.setCards', { count: set.cards })}
              className={`numeric rounded px-1.5 py-0.5 text-[10px] uppercase ${
                set.fetched ? 'bg-good/15 text-good' : 'bg-ink-800 text-ink-400'
              }`}
            >
              {set.set_code}
            </span>
          ))}
        </div>
      )}
    </section>
  )
}
