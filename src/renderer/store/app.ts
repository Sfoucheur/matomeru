import { create } from 'zustand'
import type { CardContext } from '@shared/types'
import { resolveLocale, type Locale } from '@shared/i18n/index'
import { setFormatLocale } from '../lib/format'
import {
  DEFAULT_FILTERS,
  DEFAULT_PRINTING_FILTERS,
  DEFAULT_GRID_COLUMNS,
  DEFAULT_VIEW_MODES,
  GRID_MAX_COLUMNS,
  GRID_MIN_COLUMNS,
  type AppSettings,
  type CollectionFilters,
  type GridKey,
  type PrintingFilters,
  type ProgressEvent,
  type ViewModes
} from '@shared/types'

export type ViewName = 'collection' | 'add' | 'picks' | 'decks' | 'import' | 'stats' | 'settings'

export interface Toast {
  id: number
  kind: 'info' | 'success' | 'warn' | 'error'
  message: string
}

interface AppState {
  view: ViewName
  setView: (view: ViewName) => void

  settings: AppSettings | null
  setSettings: (settings: AppSettings) => void
  /** The resolved app language — `system` already turned into 'en' or 'fr'. */
  locale: Locale
  loadSettings: () => Promise<void>
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>

  filters: CollectionFilters
  setFilters: (patch: Partial<CollectionFilters>) => void
  resetFilters: () => void

  /**
   * Narrowing for a card's printings, shared by the Add-cards picker and the
   * card-detail one. In the store rather than in a component because the detail
   * modal unmounts every time it closes, and because entering a French collection
   * should mean setting the language once, not once per card. Session-only — not a
   * display preference, so it is deliberately never written to disk.
   */
  printingFilters: PrintingFilters
  setPrintingFilters: (patch: Partial<PrintingFilters>) => void
  resetPrintingFilters: () => void

  /** Bumped whenever the collection changes, so views know to refetch. */
  dataVersion: number
  invalidate: () => void

  progress: ProgressEvent | null
  setProgress: (event: ProgressEvent | null) => void

  toasts: Toast[]
  toast: (kind: Toast['kind'], message: string) => void
  dismissToast: (id: number) => void

  /** Scryfall id whose detail modal is open, if any. */
  detailFor: string | null
  /**
   * What the open card belongs to, when it belongs to something editable. Without
   * it the modal is a read-only reference view, which is all it used to be.
   */
  detailContext: CardContext | null
  openCard: (scryfallId: string | null, context?: CardContext | null) => void

  /** Column count for one grid, falling back to its default before settings load. */
  columnsFor: (grid: GridKey) => number
  /**
   * Nudges a grid's column count. Positive `delta` adds columns (smaller cards);
   * pass null to reset to the default for that grid.
   */
  nudgeColumns: (grid: GridKey, delta: number | null) => void

  /** List/grid choice for one screen, persisted so it survives a restart. */
  viewModeFor: <K extends keyof ViewModes>(screen: K) => ViewModes[K]
  setViewMode: <K extends keyof ViewModes>(screen: K, mode: ViewModes[K]) => void
}

/**
 * Settings that change query results, and therefore need a refetch when written.
 * Everything else — view modes, grid columns, reduce motion, deck grouping — only
 * changes how already-fetched data is drawn.
 */
const DATA_AFFECTING_SETTINGS = new Set<keyof AppSettings>([
  'currency',
  'deckMatchExact',
  'labelPossession'
])

let toastId = 0

export const useApp = create<AppState>((set, get) => ({
  view: 'collection',
  setView: (view) => set({ view }),

  settings: null,
  locale: 'en',
  setSettings: (settings) => {
    const locale = resolveLocale(settings.locale, navigator.language)
    set({ settings, locale })
    // Money, counts and dates read the locale from module state rather than
    // taking it as a parameter at hundreds of call sites.
    setFormatLocale(locale)
    // The motion toggle lives on <html> so plain CSS transitions honour it too.
    document.documentElement.classList.toggle('reduce-motion', settings.reduceMotion)
    // And the document language, which index.html hardcodes to English.
    document.documentElement.lang = locale
  },
  loadSettings: async () => {
    const settings = await window.api.settings.get()
    get().setSettings(settings)
  },
  updateSettings: async (patch) => {
    const settings = await window.api.settings.update(patch)
    get().setSettings(settings)
    // Only settings that change what a query *returns* force a refetch. Toggling
    // a display preference used to re-query the whole collection and re-run the
    // active deck's breakdown, which is a visible stall for a purely visual change.
    if (Object.keys(patch).some((key) => DATA_AFFECTING_SETTINGS.has(key as keyof AppSettings))) {
      get().invalidate()
    }
  },

  filters: DEFAULT_FILTERS,
  setFilters: (patch) => set({ filters: { ...get().filters, ...patch } }),
  resetFilters: () => set({ filters: DEFAULT_FILTERS }),

  printingFilters: DEFAULT_PRINTING_FILTERS,
  setPrintingFilters: (patch) =>
    set({ printingFilters: { ...get().printingFilters, ...patch } }),
  resetPrintingFilters: () => set({ printingFilters: DEFAULT_PRINTING_FILTERS }),

  dataVersion: 0,
  invalidate: () => set({ dataVersion: get().dataVersion + 1 }),

  progress: null,
  setProgress: (progress) => set({ progress }),

  toasts: [],
  toast: (kind, message) => {
    const id = ++toastId
    set({ toasts: [...get().toasts, { id, kind, message }] })
    // Errors stay put until dismissed; everything else clears itself.
    if (kind !== 'error') {
      setTimeout(() => get().dismissToast(id), 4200)
    }
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),

  detailFor: null,
  detailContext: null,
  openCard: (detailFor, detailContext = null) => set({ detailFor, detailContext }),

  columnsFor: (grid) => get().settings?.gridColumns[grid] ?? DEFAULT_GRID_COLUMNS[grid],

  nudgeColumns: (grid, delta) => {
    const settings = get().settings
    if (!settings) return
    const current = settings.gridColumns[grid] ?? DEFAULT_GRID_COLUMNS[grid]
    const next =
      delta === null
        ? DEFAULT_GRID_COLUMNS[grid]
        : Math.min(GRID_MAX_COLUMNS, Math.max(GRID_MIN_COLUMNS, current + delta))
    if (next === current) return

    // Optimistic: the stepper and Ctrl+scroll must feel instant, so update local
    // state first and let the persisted write catch up.
    get().setSettings({ ...settings, gridColumns: { ...settings.gridColumns, [grid]: next } })
    void window.api.settings
      .update({ gridColumns: { ...settings.gridColumns, [grid]: next } })
      .catch(() => undefined)
  },

  viewModeFor: (screen) => get().settings?.viewModes[screen] ?? DEFAULT_VIEW_MODES[screen],

  setViewMode: (screen, mode) => {
    const settings = get().settings
    if (!settings) return
    if (settings.viewModes[screen] === mode) return
    const viewModes = { ...settings.viewModes, [screen]: mode }
    // Optimistic, like the column stepper: the toggle must feel instant.
    get().setSettings({ ...settings, viewModes })
    void window.api.settings.update({ viewModes }).catch(() => undefined)
  }
}))

/** Wraps an async action so failures surface as a toast instead of a silent no-op. */
export async function guard<T>(
  fn: () => Promise<T>,
  successMessage?: string
): Promise<T | undefined> {
  const { toast } = useApp.getState()
  try {
    const result = await fn()
    if (successMessage) toast('success', successMessage)
    return result
  } catch (err) {
    toast('error', (err as Error).message)
    return undefined
  }
}
