import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence } from 'motion/react'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  AlertCircle,
  Check,
  Crown,
  ExternalLink,
  LayoutGrid,
  Layers,
  Link2,
  Lock,
  RefreshCw,
  Rows3,
  Sparkles,
  Tags,
  Trash2
} from 'lucide-react'
import {
  DEFAULT_DECK_FILTERS,
  NO_LABEL,
  type Deck,
  type DeckBreakdown,
  type CardContext,
  foilTreatmentLabel,
  type DeckCardRow,
  type DeckFilters,
  type Finish
} from '@shared/types'
import { guard, useApp } from '../store/app'
import type { ViewProps } from '../App'
import ColumnStepper from '../components/ColumnStepper'
import CardTile from '../components/CardTile'
import LabelPossessionPanel from '../components/LabelPossessionPanel'
import DeckToolbar from '../components/DeckToolbar'
import DeckBulkBar from '../components/DeckBulkBar'
import FoilBadge from '../components/FoilBadge'
import { FINISH_LABEL } from '../lib/format'
import { useT } from '../hooks/useT'
import { Button, CardImage, EmptyState, LangChip, Modal, RarityPip } from '../components/primitives'
import { PROXY_PRICE_HINT, bigMoney, count, relativeTime } from '../lib/format'
import {
  buildDeckBody,
  buildDeckSections,
  deckCardSelectable,
  type DeckBodyItem,
  type FilteredGroup
} from '../lib/deckGroups'
import { CARD_ASPECT, useGridMetrics } from '../hooks/useGridMetrics'

/**
 * What opening this card lets you change: which printing this deck entry uses.
 * Without a context the detail view is read-only reference, as it used to be.
 */
function deckCardContext(card: DeckCardRow, deck: Deck): CardContext | undefined {
  if (!card.oracle_id) return undefined
  return {
    kind: 'deck',
    deckId: deck.id,
    oracleId: card.oracle_id,
    deckName: deck.name,
    forcedLang: card.language_forced ? card.lang : null
  }
}

/** Row heights, in px. Exact rather than estimated, so nothing needs re-measuring. */
const HEADER_HEIGHT = 42
const ROW_HEIGHT = 48
const GRID_GAP = 16

export default function DecksView({ active }: ViewProps): React.ReactElement {
  const t = useT()
  const dataVersion = useApp((s) => s.dataVersion)
  const invalidate = useApp((s) => s.invalidate)
  const toast = useApp((s) => s.toast)
  const setView = useApp((s) => s.setView)
  // Narrow selectors: subscribing to the whole `settings` or `filters` object made
  // this view re-render whenever an unrelated screen changed a filter, and every
  // visited view stays mounted.
  const currency = useApp((s) => s.settings?.currency ?? 'usd')
  const username = useApp((s) => s.settings?.archidektUsername ?? '')
  const deckMatchExact = useApp((s) => s.settings?.deckMatchExact ?? false)
  const groupByCategory = useApp((s) => s.settings?.deckGroupByCategory ?? true)
  const deckScope = useApp((s) => s.filters.deckScope)

  const [decks, setDecks] = useState<Deck[]>([])
  const [activeId, setActiveId] = useState<number | null>(null)
  const [breakdown, setBreakdown] = useState<DeckBreakdown | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [urlInput, setUrlInput] = useState('')
  const [loading, setLoading] = useState(true)
  const [labelsOpen, setLabelsOpen] = useState(false)

  // Deck filters are task state, not a display preference: they live here so they
  // survive navigation (views stay mounted) without being written to disk. Shared
  // across decks on purpose — "missing only" should not reset every time you
  // switch deck — but see the pruning effect below.
  const [deckFilters, setDeckFilters] = useState<DeckFilters>(DEFAULT_DECK_FILTERS)
  const patchFilters = useCallback(
    (patch: Partial<DeckFilters>) => setDeckFilters((current) => ({ ...current, ...patch })),
    []
  )

  const loadDecks = useCallback(async () => {
    try {
      const next = await window.api.decks.list()
      setDecks(next)
      setActiveId((current) => {
        if (current && next.some((deck) => deck.id === current)) return current
        // Honour a deck filter set from the locations panel.
        if (typeof deckScope === 'number') {
          const target = next.find((deck) => deck.id === deckScope)
          if (target) return target.id
        }
        return next.find((deck) => !deck.sync_error)?.id ?? next[0]?.id ?? null
      })
    } catch (err) {
      toast('error', (err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [toast, deckScope])

  // A hidden view must not query: with every visited view kept mounted, one
  // invalidate() would otherwise fan out into a request from each screen. The
  // effect still re-runs on becoming active, picking up anything missed.
  useEffect(() => {
    if (!active) return
    void loadDecks()
  }, [active, loadDecks, dataVersion])

  useEffect(() => {
    if (!active) return
    if (activeId === null) {
      setBreakdown(null)
      return
    }
    window.api.decks
      .breakdown(activeId)
      .then(setBreakdown)
      .catch(() => setBreakdown(null))
  }, [active, activeId, dataVersion, deckMatchExact])

  // Categories and labels are the user's own per-deck groupings, so a selection
  // the newly-shown deck has no cards in would silently hide everything. Drop
  // exactly those and keep the rest.
  useEffect(() => {
    if (!breakdown) return
    const categories = new Set(breakdown.categories.map((c) => c.name))
    const labels = new Set(breakdown.labels.map((l) => l.color ?? l.name ?? ''))
    const languages = new Set(breakdown.languages.map((l) => l.lang))
    setDeckFilters((current) => {
      const keptCategories = current.categories.filter((name) => categories.has(name))
      const keptLabels = current.labels.filter((label) => label === NO_LABEL || labels.has(label))
      const keptLangs = current.langs.filter((lang) => languages.has(lang))
      if (
        keptCategories.length === current.categories.length &&
        keptLabels.length === current.labels.length &&
        keptLangs.length === current.langs.length
      ) {
        return current
      }
      return { ...current, categories: keptCategories, labels: keptLabels, langs: keptLangs }
    })
  }, [breakdown])

  const sync = async (): Promise<void> => {
    setSyncing(true)
    const result = await guard(() => window.api.decks.syncUser())
    setSyncing(false)
    if (result) {
      const parts = [t('decks.syncSynced', { count: result.synced })]
      if (result.skipped) parts.push(t('decks.syncUnchanged', { count: result.skipped }))
      if (result.failed) parts.push(t('decks.syncUnavailable', { count: result.failed }))
      toast('success', t('decks.syncResult', { parts: parts.join(', ') }))
      if (result.privateCount > 0) {
        toast(
          'warn',
          t('decks.privateWarning', {
            reported: result.deckCountReported ?? 0,
            shared: (result.deckCountReported ?? 0) - result.privateCount
          })
        )
      }
      invalidate()
    }
  }

  const addByUrl = async (): Promise<void> => {
    if (!urlInput.trim()) return
    const result = await guard(() => window.api.decks.addByUrl(urlInput.trim()))
    if (result) {
      toast('success', t('decks.added', { name: result.name }))
      setUrlInput('')
      invalidate()
      setActiveId(result.deckId)
    }
  }

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex w-64 shrink-0 flex-col border-r border-ink-800">
        <div className="shrink-0 space-y-2.5 px-4 pb-3 pt-4">
          <h2 className="text-[10px] font-semibold uppercase tracking-wider text-ink-500">
            {t('decks.sidebarTitle')}
          </h2>

          <Button
            variant="primary"
            size="sm"
            className="w-full"
            icon={<RefreshCw size={13} className={syncing ? 'animate-spin' : ''} />}
            onClick={() => void sync()}
            disabled={syncing || !username}
          >
            {syncing
              ? t('decks.syncing')
              : username
                ? t('decks.syncUser', { username })
                : t('decks.setUsernameFirst')}
          </Button>

          {!username && (
            <button
              onClick={() => setView('settings')}
              className="w-full text-left text-[11px] leading-relaxed text-ink-500 underline-offset-2 hover:text-ink-300 hover:underline"
            >
              {t('decks.addUsernameHint')}
            </button>
          )}

          <Button
            size="sm"
            className="w-full"
            icon={<Tags size={13} />}
            onClick={() => setLabelsOpen(true)}
          >
            {t('decks.labelMeanings')}
          </Button>

          <div className="flex gap-1.5">
            <input
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void addByUrl()
              }}
              placeholder={t('decks.urlPlaceholder')}
              className="field min-w-0 flex-1 text-xs outline-none placeholder:text-ink-600"
            />
            <Button size="sm" icon={<Link2 size={13} />} onClick={() => void addByUrl()} />
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-3">
          {decks.map((deck) => (
            <button
              key={deck.id}
              onClick={() => setActiveId(deck.id)}
              className={`w-full rounded-lg px-2.5 py-2 text-left transition-colors ${
                activeId === deck.id ? 'bg-ink-800 text-ink-50' : 'text-ink-300 hover:bg-ink-850'
              }`}
            >
              <p className="flex items-center gap-1.5 truncate text-xs font-medium">
                {deck.sync_error && <Lock size={10} className="shrink-0 text-warn" />}
                <span className="truncate">{deck.name}</span>
              </p>
              <p className="numeric mt-0.5 text-[10px] text-ink-500">
                {deck.sync_error ? (
                  <span className="text-warn">{deck.sync_error}</span>
                ) : (
                  <>
                    {t('decks.cardCount', { count: deck.cardCount })}
                    {deck.format ? ` · ${deck.format}` : ''}
                  </>
                )}
              </p>
            </button>
          ))}

          {!loading && decks.length === 0 && (
            <p className="px-2.5 py-4 text-[11px] leading-relaxed text-ink-600">
              {t('decks.noneYet')}
            </p>
          )}
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        {!breakdown ? (
          <EmptyState
            icon={<Layers size={30} />}
            title={decks.length ? t('decks.selectADeck') : t('decks.noneSynced')}
            hint={decks.length ? t('decks.selectHint') : t('decks.noneSyncedHint')}
          />
        ) : (
          <DeckDetail
            // Remounting per deck clears selection and scroll, which is what you
            // want when the contents change completely.
            key={breakdown.deck.id}
            breakdown={breakdown}
            currency={currency}
            filters={deckFilters}
            onFilters={patchFilters}
            onResetFilters={() => setDeckFilters(DEFAULT_DECK_FILTERS)}
            groupByCategory={groupByCategory}
            exactOnly={deckMatchExact}
            onToggleExact={(value) => void useApp.getState().updateSettings({ deckMatchExact: value })}
            onToggleGrouping={(value) =>
              void useApp.getState().updateSettings({ deckGroupByCategory: value })
            }
            onDelete={async () => {
              const ok = await guard(() => window.api.decks.remove(breakdown.deck.id))
              if (ok) {
                toast('success', t('decks.removedLocally'))
                setActiveId(null)
                invalidate()
              }
            }}
          />
        )}
      </div>

      {/*
        Same panel as Settings. Changing a colour recomputes locally, so the deck
        list behind the modal updates immediately without a re-sync.
      */}
      <Modal
        open={labelsOpen}
        onClose={() => setLabelsOpen(false)}
        title={t('decks.labelsModalTitle')}
        width="max-w-3xl"
      >
        <div className="px-5 py-4">
          <LabelPossessionPanel />
        </div>
      </Modal>
    </div>
  )
}

function DeckDetail({
  breakdown,
  currency,
  filters,
  onFilters,
  onResetFilters,
  groupByCategory,
  exactOnly,
  onToggleExact,
  onToggleGrouping,
  onDelete
}: {
  breakdown: DeckBreakdown
  currency: 'usd' | 'eur'
  filters: DeckFilters
  onFilters: (patch: Partial<DeckFilters>) => void
  onResetFilters: () => void
  groupByCategory: boolean
  exactOnly: boolean
  onToggleExact: (value: boolean) => void
  onToggleGrouping: (value: boolean) => void
  onDelete: () => Promise<void>
}): React.ReactElement {
  const { deck, totals } = breakdown
  const t = useT()
  const invalidate = useApp((s) => s.invalidate)
  const toast = useApp((s) => s.toast)
  // Persisted, so the choice survives navigation and a restart.
  const mode = useApp((s) => s.viewModeFor('decks'))
  const setViewMode = useApp((s) => s.setViewMode)
  const setMode = (next: 'rows' | 'grid'): void => setViewMode('decks', next)

  const scrollRef = useRef<HTMLDivElement>(null)
  const { columns, tileWidth, density, ready } = useGridMetrics('decks', scrollRef, {
    gap: GRID_GAP,
    enabled: mode === 'grid'
  })

  // Section counts are recomputed from the filtered set, so every number on
  // screen describes what is on screen.
  const sections = useMemo(
    () => buildDeckSections(breakdown, filters, groupByCategory),
    [breakdown, filters, groupByCategory]
  )
  const { items, ordered } = useMemo(
    () => buildDeckBody(sections, mode, columns),
    [sections, mode, columns]
  )
  const shown = sections.reduce((sum, section) => sum + section.cardCount, 0)

  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [busy, setBusy] = useState(false)
  const lastPicked = useRef<number | null>(null)

  // A card filtered out of view must leave the selection with it, or a bulk action
  // would reach cards you can no longer see.
  useEffect(() => {
    const visible = new Set(ordered.map((card) => card.id))
    setSelected((current) => {
      const next = new Set([...current].filter((id) => visible.has(id)))
      return next.size === current.size ? current : next
    })
  }, [ordered])

  const dispatchSelect = useCallback(
    (id: number, selectMode: 'toggle' | 'range') => {
      const toggle = (): void => {
        setSelected((current) => {
          const next = new Set(current)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
        lastPicked.current = id
      }

      if (selectMode === 'toggle' || lastPicked.current === null) {
        toggle()
        return
      }
      // Ranges walk the flattened display order, so a shift-click means what it
      // looks like it means even across a section heading.
      const from = ordered.findIndex((card) => card.id === lastPicked.current)
      const to = ordered.findIndex((card) => card.id === id)
      if (from === -1 || to === -1) {
        toggle()
        return
      }
      const [start, end] = from <= to ? [from, to] : [to, from]
      setSelected((current) => {
        const next = new Set(current)
        for (let i = start; i <= end; i += 1) {
          if (!deckCardSelectable(ordered[i])) next.add(ordered[i].id)
        }
        return next
      })
      lastPicked.current = id
    },
    [ordered]
  )

  const selectAllShown = useCallback(() => {
    setSelected(new Set(ordered.filter((card) => !deckCardSelectable(card)).map((c) => c.id)))
  }, [ordered])

  /** Oracle ids for the selection — what the language calls are keyed on. */
  const selectedOracleIds = useMemo(() => {
    const ids = new Set<string>()
    for (const card of ordered) {
      if (selected.has(card.id) && card.oracle_id) ids.add(card.oracle_id)
    }
    return [...ids]
  }, [ordered, selected])

  /**
   * Whether every selected entry is already a proxy, so one button can toggle.
   *
   * "All of them" rather than "any of them": with a mixed selection the useful
   * action is to bring the rest up to proxied, not to clear the ones already set.
   */
  const allSelectedProxied = useMemo(() => {
    const chosen = ordered.filter((card) => selected.has(card.id))
    return chosen.length > 0 && chosen.every((card) => card.proxied)
  }, [ordered, selected])

  const setLanguage = async (lang: string): Promise<void> => {
    if (selectedOracleIds.length === 0) return
    setBusy(true)
    const result = await guard(() =>
      window.api.decks.setCardsLanguage(deck.id, selectedOracleIds, lang)
    )
    setBusy(false)
    if (result) {
      const parts = [
        t('decks.langSet', { count: result.converted, lang: lang.toUpperCase() })
      ]
      if (result.unavailable.length) {
        parts.push(
          t('decks.langNoPrinting', {
            count: result.unavailable.length,
            lang: lang.toUpperCase()
          })
        )
      }
      if (result.failed) parts.push(t('decks.langFailed', { count: result.failed }))
      toast(
        result.unavailable.length || result.failed ? 'warn' : 'success',
        `${parts.join(', ')}.`
      )
      invalidate()
    }
  }

  const setFinish = async (finish: Finish | null, treatment: string | null): Promise<void> => {
    if (selectedOracleIds.length === 0) return
    setBusy(true)
    const changed = await guard(() =>
      window.api.decks.setCardFinish(deck.id, selectedOracleIds, finish, treatment)
    )
    setBusy(false)
    if (changed != null) {
      toast(
        'success',
        finish
          ? t('bulk.finishDone', {
              count: changed,
              finish: treatment ? foilTreatmentLabel(treatment) : FINISH_LABEL[finish]
            })
          : t('bulk.finishCleared', { count: changed })
      )
      invalidate()
    }
  }

  const setProxied = async (proxied: boolean): Promise<void> => {
    if (selectedOracleIds.length === 0) return
    setBusy(true)
    const changed = await guard(() =>
      window.api.decks.setCardProxied(deck.id, selectedOracleIds, proxied)
    )
    setBusy(false)
    if (changed != null) {
      toast(
        'success',
        proxied
          ? t('proxy.marked', { count: changed })
          : t('proxy.unmarked', { count: changed })
      )
      invalidate()
    }
  }

  const clearOverrides = async (): Promise<void> => {
    if (selectedOracleIds.length === 0) return
    setBusy(true)
    const cleared = await guard(() =>
      window.api.decks.clearCardsLanguage(deck.id, selectedOracleIds)
    )
    setBusy(false)
    if (cleared !== undefined) {
      toast('success', t('decks.clearedOverrides', { count: cleared }))
      invalidate()
    }
  }

  return (
    <>
      <header className="shrink-0 border-b border-ink-800 px-5 pb-3 pt-4">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-lg font-semibold tracking-tight text-ink-50">
              {deck.name}
            </h1>
            <p className="mt-0.5 text-xs text-ink-400">
              {deck.format ? `${deck.format} · ` : ''}
              {t('decks.cardsCount', { count: count(totals.cards) })}
              {totals.excludedCards > 0 &&
                ' ' +
                  t('decks.inDeckSplit', {
                    inDeck: count(totals.inDeckCards),
                    outside: count(totals.excludedCards)
                  })}
              {' · '}
              {t('decks.syncedAt', { when: relativeTime(deck.last_synced_at) })}
            </p>
          </div>

          {deck.url && (
            <a
              href={deck.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg border border-ink-600 px-3
                py-1.5 text-xs text-ink-300 transition-colors hover:border-ink-500 hover:bg-ink-800"
            >
              <ExternalLink size={12} />
              Archidekt
            </a>
          )}

          {mode === 'grid' && <ColumnStepper grid="decks" />}

          <div className="flex items-center overflow-hidden rounded-lg border border-ink-700">
            <button
              onClick={() => setMode('rows')}
              className={`px-2.5 py-1.5 transition-colors ${
                mode === 'rows' ? 'bg-ink-750 text-gold-400' : 'text-ink-400 hover:bg-ink-800'
              }`}
              aria-label={t('decks.rowView')}
              title={t('decks.rowView')}
            >
              <Rows3 size={15} />
            </button>
            <button
              onClick={() => setMode('grid')}
              className={`border-l border-ink-700 px-2.5 py-1.5 transition-colors ${
                mode === 'grid' ? 'bg-ink-750 text-gold-400' : 'text-ink-400 hover:bg-ink-800'
              }`}
              aria-label={t('decks.gridView')}
              title={t('decks.gridView')}
            >
              <LayoutGrid size={15} />
            </button>
          </div>

          <Button size="sm" variant="danger" icon={<Trash2 size={13} />} onClick={() => void onDelete()}>
            {t('decks.remove')}
          </Button>
        </div>

        {deck.sync_error && (
          <p className="mt-2.5 flex items-start gap-2 rounded-lg border border-warn/30 bg-warn/[0.08] px-3 py-2 text-[11px] leading-relaxed text-warn">
            <AlertCircle size={13} className="mt-px shrink-0" />
            <span>{t('decks.syncErrorNote', { error: deck.sync_error })}</span>
          </p>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
          {/*
            Card counts, not row counts. An entry of Forest ×8 contributes eight,
            which is why these two always sum to the deck total.
          */}
          <span className="numeric text-good">
            {t('decks.owned', { count: count(totals.ownedCards) })}
          </span>
          <span className="numeric text-bad">
            {t('decks.missing', { count: count(totals.missingCards) })}
          </span>
          <span
            className="numeric text-ink-400"
            title={totals.missingValueIsProxy ? PROXY_PRICE_HINT : undefined}
          >
            {t('decks.missingPile')}
            <span className="font-medium text-gold-400">
              {bigMoney(totals.missingValue, currency)}
            </span>
            {totals.missingValueIsProxy && <span className="ml-1 text-ink-600">*</span>}
          </span>
          <span className="numeric text-ink-600">
            {t('decks.entries', { count: count(totals.entries) })}
          </span>

          <label
            className="ml-auto flex items-center gap-2 text-[11px] text-ink-400"
            title={t('decks.exactOnlyHint')}
          >
            <input
              type="checkbox"
              checked={exactOnly}
              onChange={(e) => onToggleExact(e.target.checked)}
              className="accent-gold-500"
            />
            {t('decks.exactOnly')}
          </label>
        </div>
      </header>

      <DeckToolbar
        breakdown={breakdown}
        filters={filters}
        onChange={onFilters}
        onReset={onResetFilters}
        groupByCategory={groupByCategory}
        onToggleGrouping={onToggleGrouping}
        onSelectAll={selectAllShown}
        shown={shown}
        total={totals.cards}
      />

      <AnimatePresence initial={false}>
        {selected.size > 0 && (
          <DeckBulkBar
            count={selected.size}
            busy={busy}
            lastLang={deck.default_lang}
            onSetLanguage={(lang) => void setLanguage(lang)}
            onSetFinish={(finish, treatment) => void setFinish(finish, treatment)}
            onSetProxied={(proxied) => void setProxied(proxied)}
            allProxied={allSelectedProxied}
            onClearOverrides={() => void clearOverrides()}
            onClear={() => setSelected(new Set())}
          />
        )}
      </AnimatePresence>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {sections.length === 0 ? (
          <EmptyState
            title={t('decks.nothingMatches')}
            hint={t('decks.nothingMatchesHint')}
          />
        ) : (
          <DeckBody
            items={items}
            deck={deck}
            mode={mode}
            currency={currency}
            scrollRef={scrollRef}
            selected={selected}
            onSelect={dispatchSelect}
            tileWidth={tileWidth}
            density={density}
            ready={ready || mode === 'rows'}
          />
        )}
      </div>
    </>
  )
}

/**
 * The deck body: one virtualized list of section headings and card rows.
 *
 * There used to be a list per category, and in grid mode a whole `GalleryGrid`
 * per category — eighteen `ResizeObserver`s, eighteen non-passive wheel listeners
 * and every one of a deck's cards in the DOM at once. Headers and cards share one
 * flat list so the whole body costs one virtualizer and about twenty live rows.
 */
function DeckBody({
  items,
  deck,
  mode,
  currency,
  scrollRef,
  selected,
  onSelect,
  tileWidth,
  density,
  ready
}: {
  items: DeckBodyItem[]
  deck: Deck
  mode: 'rows' | 'grid'
  currency: 'usd' | 'eur'
  scrollRef: React.RefObject<HTMLDivElement | null>
  selected: Set<number>
  onSelect: (id: number, mode: 'toggle' | 'range') => void
  tileWidth: number
  density: ReturnType<typeof useGridMetrics>['density']
  ready: boolean
}): React.ReactElement {
  const tileRowHeight = tileWidth * CARD_ASPECT + GRID_GAP

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    // Every height is exact, so there is no measure-then-correct pass: a header
    // and a row are constants, and a tile row follows from the card aspect ratio.
    estimateSize: (index) => {
      const item = items[index]
      if (item.kind === 'header') return HEADER_HEIGHT
      if (item.kind === 'row') return ROW_HEIGHT
      return tileRowHeight
    },
    getItemKey: (index) => items[index].key,
    overscan: mode === 'grid' ? 4 : 10
  })

  // Column count and tile width both change row heights, and sizes are cached.
  useEffect(() => {
    virtualizer.measure()
  }, [virtualizer, tileRowHeight, mode])

  // Before the container is measured every tile row would estimate to zero, and a
  // zero estimate makes the virtualizer decide the whole deck fits on screen.
  if (!ready) return <div />

  return (
    <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
      {virtualizer.getVirtualItems().map((virtualRow) => {
        const item = items[virtualRow.index]
        return (
          <div
            key={virtualRow.key}
            style={{
              position: 'absolute',
              top: virtualRow.start,
              left: 0,
              width: '100%',
              height: virtualRow.size
            }}
          >
            {item.kind === 'header' ? (
              <SectionHeader group={item.group} currency={currency} />
            ) : item.kind === 'row' ? (
              <DeckCardLine
                card={item.card}
                deck={deck}
                selected={selected.has(item.card.id)}
                onSelect={onSelect}
              />
            ) : (
              <div
                className="grid"
                style={{
                  // item.columns, never item.cards.length: the row's height was
                  // computed from that count, and a short final chunk laid out
                  // over fewer tracks gets wider — and so taller — tiles, which
                  // then overflow and paint behind the rows below.
                  gridTemplateColumns: `repeat(${item.columns}, minmax(0, 1fr))`,
                  gap: GRID_GAP
                }}
              >
                {item.cards.map((card) => (
                  <DeckGridTile
                    key={card.id}
                    card={card}
                    deck={deck}
                    density={density}
                    selected={selected.has(card.id)}
                    onSelect={onSelect}
                  />
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

/** One category heading, the way Archidekt lays a deck out. */
const SectionHeader = memo(function SectionHeader({
  group,
  currency
}: {
  group: FilteredGroup
  currency: 'usd' | 'eur'
}): React.ReactElement {
  const t = useT()
  return (
    <div className="mb-2 flex items-center gap-2 border-b border-ink-800 pb-1.5 pt-2">
      {group.isPremier && <Crown size={13} className="shrink-0 text-gold-400" />}
      <h2
        className={`text-xs font-semibold uppercase tracking-wider ${
          group.isPremier ? 'text-gold-300' : 'text-ink-300'
        }`}
      >
        {group.name}
      </h2>
      <span className="numeric text-[11px] text-ink-500">
        {t('decks.cardsCount', { count: count(group.cardCount) })}
      </span>
      {!group.inDeck && (
        <span
          title={t('decks.notCountedHint')}
          className="rounded bg-ink-750 px-1.5 py-0.5 text-[9px] uppercase text-ink-400"
        >
          {t('decks.notInDeck')}
        </span>
      )}
      <span className="numeric ml-auto text-[11px]">
        <span className="text-good">{group.ownedCards}</span>
        <span className="text-ink-600"> / </span>
        <span className="text-bad">{group.missingCards}</span>
        {group.missingValue > 0 && (
          <span
            className="ml-2 text-ink-500"
            title={group.missingValueIsProxy ? PROXY_PRICE_HINT : undefined}
          >
            {bigMoney(group.missingValue, currency)}
            {group.missingValueIsProxy && '*'}
          </span>
        )}
      </span>
    </div>
  )
})

/**
 * One card in row mode.
 *
 * Memoized and animation-free. It used to mount a language popover per row — two
 * pieces of state, a ref and a portal for every card in the deck — which is now a
 * single control in the bulk bar, driven by the selection.
 */
const DeckCardLine = memo(function DeckCardLine({
  card,
  deck,
  selected,
  onSelect
}: {
  card: DeckCardRow
  deck: Deck
  selected: boolean
  onSelect: (id: number, mode: 'toggle' | 'range') => void
}): React.ReactElement {
  const t = useT()
  const openCard = useApp((s) => s.openCard)
  // card.held is derived in the main process alongside the owned/missing totals,
  // so the figure shown here can never disagree with the header.
  const held = card.held
  // Owning the card only in another printing is worth flagging: the physical
  // card you have is not the one the deck lists.
  const onlyOtherPrinting = card.owned_exact === 0 && card.owned_any > 0
  const blocked = deckCardSelectable(card)

  const onRowClick = (e: React.MouseEvent): void => {
    if (blocked) return
    if (e.ctrlKey || e.metaKey) onSelect(card.id, 'toggle')
    else if (e.shiftKey) onSelect(card.id, 'range')
  }

  return (
    <div
      onClick={onRowClick}
      className={`group flex h-11 items-center gap-3 rounded-lg border px-3 ${
        selected ? 'border-gold-500/60 bg-gold-500/[0.08]' : 'border-ink-800 bg-ink-850'
      }`}
    >
      <button
        onClick={(e) => {
          e.stopPropagation()
          if (blocked) return
          onSelect(card.id, e.shiftKey ? 'range' : 'toggle')
        }}
        disabled={!!blocked}
        title={blocked ?? undefined}
        aria-label={
          blocked ??
          (selected
            ? t('decks.deselect', { name: card.name })
            : t('decks.select', { name: card.name }))
        }
        className={`grid h-4 w-4 shrink-0 place-items-center rounded border transition-opacity ${
          blocked
            ? 'cursor-not-allowed border-ink-700 opacity-0 group-hover:opacity-40'
            : selected
              ? 'border-gold-500 bg-gold-500 text-ink-950 opacity-100'
              : 'border-ink-600 text-transparent opacity-0 group-hover:opacity-100'
        }`}
      >
        <Check size={10} strokeWidth={3} />
      </button>

      <span className="numeric w-7 shrink-0 text-xs text-ink-500">×{card.quantity}</span>

      <CardImage scryfallId={card.scryfall_id} className="h-8 w-6 shrink-0" alt={card.name} />

      <button
        onClick={(e) => {
          e.stopPropagation()
          if (e.ctrlKey || e.metaKey || e.shiftKey) {
            onRowClick(e)
            return
          }
          if (card.scryfall_id) openCard(card.scryfall_id, deckCardContext(card, deck))
        }}
        className="min-w-0 flex-1 truncate text-left text-sm text-ink-100 underline-offset-2 hover:underline"
      >
        {card.is_commander && <Crown size={11} className="mr-1 inline text-gold-400" />}
        {card.name}
      </button>

      <span className="flex shrink-0 items-center gap-1">
        <LangChip lang={card.lang} />
        {card.language_forced ? (
          <span
            title={t('decks.langForced')}
            className="text-[9px] font-semibold text-mana-u"
          >
            ★
          </span>
        ) : (
          card.override_lang && (
            <span
              title={t('decks.langOverride', { lang: card.override_lang.toUpperCase() })}
              className="text-[9px] text-gold-400"
            >
              ●
            </span>
          )
        )}
        {card.language_unavailable && (
          <span
            title={t('decks.langUnavailable', {
              lang: card.language_unavailable.toUpperCase()
            })}
            className="text-[9px] font-semibold text-warn"
          >
            !{card.language_unavailable.toUpperCase()}
          </span>
        )}
      </span>

      <RarityPip rarity={card.rarity} />

      <span className="w-24 shrink-0 truncate text-right text-[10px]">
        {card.finish === 'nonfoil' ? (
          <span className="text-ink-700">—</span>
        ) : (
          <span
            title={
              card.foil_treatment
                ? `${foilTreatmentLabel(card.foil_treatment)}${card.treatment_forced ? ' (you set this)' : ''}`
                : FINISH_LABEL[card.finish]
            }
            className="inline-flex items-center gap-0.5 font-semibold uppercase text-gold-300"
          >
            <Sparkles size={9} />
            {card.foil_treatment ? foilTreatmentLabel(card.foil_treatment) : FINISH_LABEL[card.finish]}
            {(card.finish_forced || card.treatment_forced) && <span>★</span>}
          </span>
        )}
      </span>

      <span className="w-20 shrink-0 truncate text-[11px] uppercase text-ink-500">
        {card.set_code ?? '—'}
      </span>

      <span
        className={`numeric w-24 shrink-0 text-right text-xs ${
          held >= card.quantity ? 'text-good' : 'text-bad'
        }`}
      >
        {held >= card.quantity
          ? t('decks.have', { held })
          : t('decks.haveOf', { held, needed: card.quantity })}
      </span>

      <span className="flex w-40 shrink-0 justify-end gap-1">
        {card.proxied && (
          <span
            title={t('proxy.deckSlot')}
            className="rounded bg-ink-750 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-ink-300"
          >
            {t('proxy.badge')}
          </span>
        )}
        {card.label_possession && <PossessionBadge card={card} held={held} />}
        {onlyOtherPrinting && (
          <span
            title={t('decks.otherPrintingHint', { count: card.owned_any })}
            className="rounded bg-mana-u/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-mana-u"
          >
            {t('decks.otherPrinting')}
          </span>
        )}
      </span>
    </div>
  )
})

/**
 * One card in grid mode.
 *
 * Its own memoized component so the badges and footer are built here rather than
 * as fresh JSX in a render prop — inline `badges`/`footer` would defeat
 * `CardTile`'s memo on every render.
 */
const DeckGridTile = memo(function DeckGridTile({
  card,
  deck,
  density,
  selected,
  onSelect
}: {
  card: DeckCardRow
  deck: Deck
  density: ReturnType<typeof useGridMetrics>['density']
  selected: boolean
  onSelect: (id: number, mode: 'toggle' | 'range') => void
}): React.ReactElement {
  const t = useT()
  const openCard = useApp((s) => s.openCard)
  const held = card.held
  const complete = held >= card.quantity
  const blocked = deckCardSelectable(card)

  return (
    <CardTile
      scryfallId={card.scryfall_id}
      title={card.name}
      density={density}
      selected={selected}
      disabledReason={blocked ?? undefined}
      ringClass={
        card.is_commander
          ? 'ring-gold-500/60 hover:ring-gold-400'
          : complete
            ? 'ring-good/50 hover:ring-good'
            : 'ring-bad/40 hover:ring-bad'
      }
      onOpen={() =>
        card.scryfall_id && openCard(card.scryfall_id, deckCardContext(card, deck))
      }
      onSelect={(selectMode) => onSelect(card.id, selectMode)}
      badges={
        <>
          {card.proxied && (
            <span
              title={t('proxy.deckSlot')}
              className="rounded bg-ink-900/90 px-1.5 py-0.5 text-[9px] font-bold uppercase text-ink-200 ring-1 ring-ink-500"
            >
              {t('proxy.badge')}
            </span>
          )}
          <FoilBadge
            finish={card.finish}
            treatment={card.foil_treatment}
            forced={card.finish_forced || card.treatment_forced}
            density={density}
          />
          {card.language_unavailable && (
            <span
              title={t('decks.langUnavailableTile', {
                lang: card.language_unavailable.toUpperCase()
              })}
              className="rounded bg-warn/80 px-1.5 py-0.5 text-[9px] font-bold uppercase text-ink-950"
            >
              no {card.language_unavailable}
            </span>
          )}
          {card.override_lang && (
            <span
              title={t('decks.langOverride', { lang: card.override_lang.toUpperCase() })}
              className="rounded bg-gold-500/85 px-1.5 py-0.5 text-[9px] font-bold uppercase text-ink-950"
            >
              {card.override_lang}
            </span>
          )}
          {card.label_possession && (
            <span
              title={
                card.label_possession === 'owned'
                  ? t('decks.ownedInArchidekt')
                  : t('decks.notOwnedInArchidekt') +
                    (held > 0 ? t('decks.notOwnedButHeld', { held }) : '')
              }
              className="rounded px-1.5 py-0.5 text-[9px] font-bold text-ink-950"
              style={{ backgroundColor: card.label_color ?? '#d99a3c' }}
            >
              {card.label_possession === 'owned' ? 'have' : held > 0 ? 'in bulk' : 'want'}
            </span>
          )}
          {!card.in_maindeck && (
            <span className="rounded bg-black/70 px-1.5 py-0.5 text-[9px] font-bold uppercase text-white/80">
              SB
            </span>
          )}
        </>
      }
      footer={
        density === 'full' ? (
          <>
            <LangChip lang={card.lang} />
            <span className="numeric rounded bg-white/15 px-1.5 text-[10px] text-white">
              x{card.quantity}
            </span>
            <span className={`numeric ml-auto text-[10px] ${complete ? 'text-good' : 'text-bad'}`}>
              have {held}
            </span>
          </>
        ) : (
          <span
            className={`numeric rounded px-1.5 text-[10px] ${
              complete ? 'bg-good/80 text-ink-950' : 'bg-bad/80 text-white'
            }`}
          >
            {held}/{card.quantity}
          </span>
        )
      }
    />
  )
})

/**
 * What a label colour says about this card.
 *
 * For a "don't own" card that your collection nonetheless has copies of, the
 * disagreement is the useful part: the deck is not holding them, so they should
 * be loose in your bulk.
 */
function PossessionBadge({
  card,
  held
}: {
  card: DeckCardRow
  held: number
}): React.ReactElement | null {
  const t = useT()
  const label = card.label_name?.trim()
  const swatch = card.label_color && (
    <span
      className="h-2 w-2 rounded-full ring-1 ring-black/40"
      style={{ backgroundColor: card.label_color }}
    />
  )

  if (card.label_possession === 'owned') {
    return (
      <span
        title={t('decks.labelOwnedHint', {
          label: label || card.label_color || '',
          count: card.quantity
        })}
        className="flex items-center gap-1 rounded bg-good/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-good"
      >
        {swatch}
        {label || t('decks.labelOwnedShort')}
      </span>
    )
  }

  if (card.label_possession !== 'not_owned') return null

  // A "don't own" card you do in fact hold: say where those copies actually are.
  if (held > 0) {
    return (
      <span
        title={t('decks.labelLooseHint', { label: label || card.label_color || '', held })}
        className="rounded bg-warn/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-warn"
      >
        {t('decks.labelLoose', { held })}
      </span>
    )
  }
  return (
    <span
      title={t('decks.labelNotOwnedHint', { label: label || card.label_color || '' })}
      className="flex items-center gap-1 rounded bg-ink-750 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-ink-400"
    >
      {swatch}
      {label || t('decks.labelNotOwnedShort')}
    </span>
  )
}
