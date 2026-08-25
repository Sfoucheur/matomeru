import { useEffect, useState } from 'react'
import { AnimatePresence, MotionConfig, motion } from 'motion/react'
import {
  BarChart3,
  Boxes,
  FileUp,
  Layers,
  ListChecks,
  PlusCircle,
  Settings as SettingsIcon,
  X
} from 'lucide-react'
import { guard, useApp, type ViewName } from './store/app'
import CollectionView from './views/CollectionView'
import AddCardsView from './views/AddCardsView'
import PickListView from './views/PickListView'
import DecksView from './views/DecksView'
import ImportExportView from './views/ImportExportView'
import StatsView from './views/StatsView'
import SettingsView from './views/SettingsView'
import CardDetailModal from './components/CardDetailModal'
import BackupDialog from './components/BackupDialog'
import UpdateDialog, { UpdateDot } from './components/UpdateDialog'
import type { TranslationKey } from '@shared/i18n/index'
import { useT } from './hooks/useT'

const NAV: { view: ViewName; label: TranslationKey; icon: React.ReactNode }[] = [
  { view: 'collection', label: 'nav.collection', icon: <Boxes size={16} /> },
  { view: 'add', label: 'nav.add', icon: <PlusCircle size={16} /> },
  { view: 'picks', label: 'nav.picks', icon: <ListChecks size={16} /> },
  { view: 'decks', label: 'nav.decks', icon: <Layers size={16} /> },
  { view: 'import', label: 'nav.import', icon: <FileUp size={16} /> },
  { view: 'stats', label: 'nav.stats', icon: <BarChart3 size={16} /> },
  { view: 'settings', label: 'nav.settings', icon: <SettingsIcon size={16} /> }
]

/**
 * Every view takes `active`. Because visited views stay mounted (see below), a
 * hidden view must not run its data effects — otherwise one `invalidate()` would
 * fan out into a query from every screen at once.
 */
export interface ViewProps {
  active: boolean
}

const VIEWS: Record<ViewName, React.ComponentType<ViewProps>> = {
  collection: CollectionView,
  add: AddCardsView,
  picks: PickListView,
  decks: DecksView,
  import: ImportExportView,
  stats: StatsView,
  settings: SettingsView
}

export default function App(): React.ReactElement {
  const view = useApp((s) => s.view)
  const setView = useApp((s) => s.setView)
  const loadSettings = useApp((s) => s.loadSettings)
  const setProgress = useApp((s) => s.setProgress)
  const detailFor = useApp((s) => s.detailFor)
  const reduceMotion = useApp((s) => s.settings?.reduceMotion ?? false)
  const toast = useApp((s) => s.toast)
  const invalidate = useApp((s) => s.invalidate)
  const t = useT()
  const [updateOpen, setUpdateOpen] = useState(false)
  const updateState = useApp((s) => s.updateState)
  const setUpdateState = useApp((s) => s.setUpdateState)
  const backupMode = useApp((s) => s.backupMode)
  const openBackup = useApp((s) => s.openBackup)

  /**
   * Views are mounted on first visit and then kept mounted, hidden rather than
   * unmounted. Keying a single pane by `view` used to remount every screen on
   * navigation, discarding its state: which deck was open, Add-cards results, an
   * in-progress CSV import, and scroll position. Keeping them alive retains all
   * of that for free.
   */
  const [visited, setVisited] = useState<Set<ViewName>>(() => new Set([view]))

  useEffect(() => {
    setVisited((current) => (current.has(view) ? current : new Set(current).add(view)))
  }, [view])

  useEffect(() => {
    void loadSettings()
  }, [loadSettings])

  useEffect(() => {
    return window.api.onProgress((event) => {
      setProgress(event.finished ? null : event)
    })
  }, [setProgress])

  /*
    An update announcing itself.

    The dialog opens whenever a push arrives carrying one, which includes the check that
    runs at launch — the case that used to reach nobody. It reappears on every start while
    an update is pending: dismissing it means "not now", and the dot on the Settings entry
    stays regardless.
  */
  useEffect(() => {
    return window.api.updates.onUpdate((state) => {
      setUpdateState(state)
      if (state.available !== null) setUpdateOpen(true)
    })
  }, [setUpdateState])

  // Alt+1..7 jumps between views — faster than reaching for the mouse while sorting.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!e.altKey) return
      const index = Number.parseInt(e.key, 10) - 1
      if (index >= 0 && index < NAV.length) {
        e.preventDefault()
        setView(NAV[index].view)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [setView])

  /*
    Ctrl+S opens the backup dialog. It never sends anything by itself.

    The same input guard as undo, for the same reason: inside a text field the
    keystroke belongs to the field, not to the app. `preventDefault` is not optional
    here — without it Chromium opens its own Save-page dialog over ours.

    A shortcut that wrote straight to Drive would be the wrong shape. Ctrl+S in most
    apps saves to a place you already chose; here it copies 33 MB to someone's
    cloud and may overwrite what another machine put there, and both of those are
    facts you should see before agreeing to them.
  */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!e.ctrlKey && !e.metaKey) return
      if (e.key.toLowerCase() !== 's' || e.shiftKey) return
      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return
      e.preventDefault()
      openBackup('save')
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [openBackup])

  /*
    Ctrl+Z and Ctrl+Y, for everything you change locally.

    Skipped entirely while a text field has focus. Inside an input, Ctrl+Z means
    "undo my typing" and the browser already does that well; stealing it to roll
    back a database write would be both surprising and destructive — you would be
    trying to fix a typo in the search box and lose your last bulk edit.

    Ctrl+Shift+Z is accepted as well as Ctrl+Y, because both are in common use for
    redo and there is no cost to honouring the two.
  */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!e.ctrlKey && !e.metaKey) return
      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return

      const key = e.key.toLowerCase()
      const isUndo = key === 'z' && !e.shiftKey
      const isRedo = key === 'y' || (key === 'z' && e.shiftKey)
      if (!isUndo && !isRedo) return
      e.preventDefault()

      void (async () => {
        const step = await guard(() =>
          isUndo ? window.api.undo.undo() : window.api.undo.redo()
        )
        // `null` means the stack was empty, which is not an error — say so rather
        // than leaving the keypress looking broken.
        if (step === null) {
          toast('warn', t(isUndo ? 'undo.nothing' : 'undo.nothingRedo'))
          return
        }
        if (step === undefined) return
        toast('success', t(isUndo ? 'undo.done' : 'undo.redone', { label: step.label }))
        invalidate()
      })()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [invalidate, toast, t])

  return (
    /*
      Motion animates by writing inline styles from JS, so the `.reduce-motion`
      CSS in index.css never reached any of it — the setting looked like it did
      nothing. MotionConfig is what actually stills the JS-driven animations.
    */
    <MotionConfig reducedMotion={reduceMotion ? 'always' : 'never'}>
      <div className="flex h-full bg-ink-900">
        <Sidebar view={view} onSelect={setView} />

        <main className="relative flex min-w-0 flex-1 flex-col">
          {/*
            One pane per visited view. `hidden` keeps the subtree mounted with its
            scroll position intact; AnimatePresence cannot cross-fade two mounted
            panes, so the entrance animation lives on the active pane instead.
          */}
          {(Object.keys(VIEWS) as ViewName[])
            .filter((name) => visited.has(name))
            .map((name) => {
              const View = VIEWS[name]
              const isActive = name === view
              return (
                <motion.div
                  key={name}
                  animate={{ opacity: isActive ? 1 : 0, y: isActive ? 0 : 6 }}
                  initial={false}
                  transition={{ duration: 0.18, ease: [0.25, 1, 0.5, 1] }}
                  className={`flex min-h-0 flex-1 flex-col ${isActive ? '' : 'hidden'}`}
                >
                  <View active={isActive} />
                </motion.div>
              )
            })}
          <ProgressBar />
        </main>

        {detailFor && <CardDetailModal scryfallId={detailFor} />}
        {updateOpen && updateState !== null && (
          <UpdateDialog state={updateState} onClose={() => setUpdateOpen(false)} />
        )}

        {backupMode !== null && (
          <BackupDialog initialMode={backupMode} onClose={() => openBackup(null)} />
        )}

        <Toasts />
      </div>
    </MotionConfig>
  )
}

function Sidebar({
  view,
  onSelect
}: {
  view: ViewName
  onSelect: (view: ViewName) => void
}): React.ReactElement {
  const t = useT()
  return (
    <aside className="flex w-52 shrink-0 flex-col border-r border-ink-800 bg-ink-950">
      <div className="flex items-center gap-2.5 px-4 py-4">
        {/* まとめる — the first character, matching the launcher icon. Nudged up
            a hair: the glyph's ink sits low in its em box, so optical centring
            beats geometric here. */}
        <div className="grid h-7 w-7 place-items-center rounded-md bg-gold-500 text-sm font-bold leading-none text-ink-950">
          <span className="-mt-px">ま</span>
        </div>
        <div className="leading-tight">
          <p className="text-sm font-semibold tracking-tight text-ink-100">Matomeru</p>
          <p className="text-[10px] text-ink-500">{t('app.tagline')}</p>
        </div>
      </div>

      <nav className="flex flex-1 flex-col gap-0.5 px-2">
        {NAV.map((item, index) => {
          const active = view === item.view
          return (
            <button
              key={item.view}
              onClick={() => onSelect(item.view)}
              className={`group relative flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left
                text-sm transition-colors ${
                  active ? 'text-ink-50' : 'text-ink-400 hover:bg-ink-900 hover:text-ink-200'
                }`}
            >
              {active && (
                <motion.span
                  layoutId="nav-active"
                  transition={{ type: 'spring', stiffness: 480, damping: 36 }}
                  className="absolute inset-0 -z-10 rounded-lg bg-ink-800 ring-1 ring-ink-700"
                />
              )}
              <span className={active ? 'text-gold-400' : ''}>{item.icon}</span>
              <span className="flex-1">{t(item.label)}</span>
              {item.view === 'settings' && <UpdateDot />}
              <span className="text-[10px] text-ink-600 opacity-0 transition-opacity group-hover:opacity-100">
                Alt{index + 1}
              </span>
            </button>
          )
        })}
      </nav>

      <p className="px-4 py-3 text-[10px] leading-relaxed text-ink-600">
        {t('app.credits')}
      </p>
    </aside>
  )
}

function ProgressBar(): React.ReactElement {
  const progress = useApp((s) => s.progress)
  const pct = progress && progress.total > 0 ? (progress.done / progress.total) * 100 : 0

  return (
    <AnimatePresence>
      {progress && (
        <motion.div
          initial={{ y: 60, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 60, opacity: 0 }}
          transition={{ type: 'spring', stiffness: 420, damping: 34 }}
          className="absolute bottom-0 left-0 right-0 border-t border-ink-700 bg-ink-850/95 px-5 py-2.5 backdrop-blur"
        >
          <div className="mb-1.5 flex items-baseline justify-between gap-4 text-xs">
            <span className="truncate text-ink-200">
              {progress.phase}
              {progress.message && <span className="ml-2 text-ink-500">{progress.message}</span>}
            </span>
            <span className="numeric shrink-0 text-ink-400">
              {progress.done} / {progress.total}
            </span>
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-ink-750">
            <motion.div
              className="h-full rounded-full bg-gold-500"
              animate={{ width: `${pct}%` }}
              transition={{ duration: 0.3, ease: [0.25, 1, 0.5, 1] }}
            />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/*
  Toast tones.

  All four sit on the solid floating surface and carry their tone in the text and
  the border, rather than in a 15% wash of the text's own colour — which is what
  these were. Measured, such a fill resolves to alpha 38/255, so a message floating
  over the card grid was read against whatever happened to be behind it. An error
  is the one thing that must always be legible.
*/
const TOAST_TONE: Record<string, string> = {
  info: 'border-surface-edge bg-surface text-ink-100',
  success: 'border-good/70 bg-surface text-good',
  warn: 'border-warn/70 bg-surface text-warn',
  error: 'border-bad/70 bg-surface text-bad'
}

function Toasts(): React.ReactElement {
  const t = useT()
  const toasts = useApp((s) => s.toasts)
  const dismiss = useApp((s) => s.dismissToast)

  return (
    <div className="pointer-events-none fixed bottom-5 right-5 z-[60] flex w-80 flex-col gap-2">
      <AnimatePresence>
        {toasts.map((toast) => (
          <motion.div
            key={toast.id}
            layout
            initial={{ opacity: 0, x: 40, scale: 0.95 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: 40, scale: 0.95 }}
            transition={{ type: 'spring', stiffness: 460, damping: 34 }}
            className={`pointer-events-auto flex items-start gap-2 rounded-lg border px-3.5 py-2.5
              text-xs leading-relaxed shadow-lg shadow-black/40 ${TOAST_TONE[toast.kind]}`}
          >
            <span className="flex-1">{toast.message}</span>
            <button
              onClick={() => dismiss(toast.id)}
              className="mt-0.5 rounded p-0.5 opacity-60 transition-opacity hover:opacity-100"
              aria-label={t('common.dismiss')}
            >
              <X size={12} />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}
