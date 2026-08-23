import { useEffect, useState } from 'react'
import { AlertCircle, ExternalLink, PackageOpen, RefreshCw, Save } from 'lucide-react'
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
import { count, relativeTime } from '../lib/format'

export default function SettingsView(_props: ViewProps): React.ReactElement {
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

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        <div className="max-w-2xl space-y-4">
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
            <h2 className="mb-1 text-xs font-semibold uppercase tracking-wider text-ink-400">
              {t('settings.labelsTitle')}
            </h2>
            <LabelPossessionPanel />
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

          <BoosterDataPanel />

          <section className="panel p-4 text-[11px] leading-relaxed text-ink-500">
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-400">
              {t('settings.dataTitle')}
            </h2>
            <p>{t('settings.dataNote1')}</p>
            <p className="mt-2">{t('settings.dataNote2')}</p>
          </section>
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
