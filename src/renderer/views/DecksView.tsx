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
  RotateCcw,
  Rows3,
  Sparkles,
  Tags,
  Trash2
} from 'lucide-react'
import {
  DEFAULT_DECK_FILTERS,
  NO_LABEL,
  UNCATEGORIZED,
  allocateCopies,
  type Deck,
  type DeckBreakdown,
  type CardContext,
  foilTreatmentLabel,
  twoSides,
  type DeckCardRow,
  type DeckFilters,
  type PickDestination,
  type Finish
} from '@shared/types'
import { guard, useApp } from '../store/app'
import type { ViewProps } from '../App'
import ColumnStepper from '../components/ColumnStepper'
import CardTile from '../components/CardTile'
import LabelPossessionPanel from '../components/LabelPossessionPanel'
import DeckToolbar from '../components/DeckToolbar'
import DeckBulkBar from '../components/DeckBulkBar'
import { useCardPreview } from '../components/CardHoverPreview'
import CardZoom from '../components/CardZoom'
import AddToListDialog from '../components/AddToListDialog'
import FoilBadge from '../components/FoilBadge'
import Popover from '../components/Popover'
import { FINISH_LABEL } from '../lib/format'
import { useT } from '../hooks/useT'
import { useRangeSelection, type PickMode } from '../hooks/useRangeSelection'
import { Button, CardImage, EmptyState, LangChip, Modal, RarityPip } from '../components/primitives'
import { bigMoney, count, money, proxyMoney, relativeTime } from '../lib/format'
import {
  FLAT_CARDS,
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
  /** Which single deck is being re-fetched, if any. */
  const [syncingId, setSyncingId] = useState<number | null>(null)
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

  /*
    One deck. Its own busy flag rather than the view-wide `syncing`, so a single row spins
    instead of the whole screen going grey — and so the two controls can lock each other
    out without either pretending the other is idle.
  */
  const syncDeck = async (deck: Deck): Promise<void> => {
    if (!deck.external_id) return
    setSyncingId(deck.id)
    const result = await guard(() => window.api.decks.syncOne(deck.external_id as string))
    setSyncingId(null)
    if (result) {
      toast('success', t('decks.syncedOne', { name: result.name }))
      invalidate()
    }
  }

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
            // What the profile listed, reported by the sync itself. Deriving it as
            // reported-minus-hidden was wrong once "hidden" stopped counting the
            // decks you had already added by URL.
            shared: result.listedCount
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
            disabled={syncing || syncingId !== null || !username}
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
            /*
              A row, not a button. It used to be one full-width button, and a button cannot
              contain a button — so selecting the deck and re-syncing it are two siblings
              inside a positioned wrapper.
            */
            <div key={deck.id} className="group relative">
              <button
                onClick={() => setActiveId(deck.id)}
                className={`w-full rounded-lg py-2 pl-2.5 pr-9 text-left transition-colors ${
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
              {/*
                Re-syncs this deck alone, and always re-fetches: the all-decks sync skips a
                deck Archidekt reports as unchanged, so a deck you only re-labelled is never
                read again.

                Quiet until you go looking — except on a deck that failed, which is the one
                you most want to retry, so hiding its retry behind a hover would be exactly
                the wrong way round.
              */}
              <button
                onClick={() => void syncDeck(deck)}
                disabled={syncing || syncingId !== null}
                data-sync-deck={deck.id}
                title={t('decks.syncOne')}
                aria-label={t('decks.syncOne')}
                className={`absolute right-1.5 top-1.5 rounded p-1.5 text-ink-400 transition-all
                  hover:bg-ink-750 hover:text-gold-400 disabled:opacity-40
                  focus-visible:opacity-100 group-hover:opacity-100 ${
                    deck.sync_error || syncingId === deck.id ? 'opacity-100' : 'opacity-0'
                  }`}
              >
                <RefreshCw size={12} className={syncingId === deck.id ? 'animate-spin' : ''} />
              </button>
            </div>
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
  /*
    Cards on screen, counted once.

    Summing the sections would read "249 of 161" on a deck whose categories overlap, which
    is true of the rows and nonsense about the deck.
  */
  const shown = useMemo(() => {
    const seen = new Set<number>()
    let total = 0
    for (const section of sections) {
      for (const card of section.cards) {
        if (seen.has(card.id)) continue
        seen.add(card.id)
        total += card.quantity
      }
    }
    return total
  }, [sections])

  /** Open while the dialog is asking which list and what happens to the copies. */
  const [listDialog, setListDialog] = useState(false)
  /*
    The closer look, opened from a row's thumbnail.

    The deck screen had no way to it at all: in grid mode the artwork opens the card's
    details, and in list mode the thumbnail did nothing of its own. The collection's list
    has offered this from its thumbnail all along, and there is no reason the same picture
    should be two clicks further away here.
  */
  const [zoom, setZoom] = useState<{
    scryfallId: string
    title: string
    hasBack: boolean
  } | null>(null)
  const [busy, setBusy] = useState(false)

  /*
    Selection, from the hook the collection also uses. `deckCardSelectable` returns
    the reason a card cannot be picked, so a falsy answer is what makes it pickable.
  */
  const selectableCards = useMemo(
    () => ordered.map((card) => ({ key: card.id, selectable: !deckCardSelectable(card) })),
    [ordered]
  )
  const {
    selected,
    pick: dispatchSelect,
    clear: clearSelection,
    selectAllShown,
    keep
  } = useRangeSelection(selectableCards)

  /*
    Every card in the deck, filtered or not — and every selected one, from that.

    The selection used to be pruned to what the filters showed, so that a bulk action could
    not reach cards you could no longer see. The reason was sound and the mechanism was the
    problem: everything below derives from `ordered`, the *filtered* cards, so an off-filter
    selection would have been silently skipped rather than refused. Now the actions resolve
    against the whole deck instead, which is what lets a selection be built across filters.

    A memo over the breakdown rather than a cache of what has been drawn: the deck is
    already here in full, `buildDeckSections` only chooses what to show from it, and a
    derivation that cannot go stale beats one that has to be kept fresh. It also prunes
    itself — a card that leaves the deck leaves this with it.

    Order is the deck's, not the order things were clicked, so a partial refusal reports
    the same way it always has.
  */
  /*
    Every entry once.

    This used to flatten the sections, which was the same list while each card belonged to
    exactly one. Now that a card is drawn under every category it carries, flattening hands
    the same card back several times -- and a bulk action would then act on it several times.
    `breakdown.cards` is the distinct list, built once in the main process.
  */
  const allDeckCards = breakdown.cards
  const selectedCards = useMemo(
    () => allDeckCards.filter((card) => selected.has(card.id)),
    [allDeckCards, selected]
  )

  /*
    What is gone is dropped; what is merely hidden is not.

    This is the prune that remains, and it is about existence: a card moved out to the
    collection, or dropped by an Archidekt re-sync, cannot stay selected. A filter, by
    contrast, is a viewport.
  */
  useEffect(() => {
    const inDeck = new Set(allDeckCards.map((card) => card.id))
    keep((id) => inDeck.has(id))
  }, [allDeckCards, keep])


  /** Oracle ids for the selection — what the language calls are keyed on. */
  const selectedOracleIds = useMemo(() => {
    const ids = new Set<string>()
    for (const card of selectedCards) if (card.oracle_id) ids.add(card.oracle_id)
    return [...ids]
  }, [selectedCards])

  /**
   * Whether every selected entry is already a proxy, so one button can toggle.
   *
   * "All of them" rather than "any of them": with a mixed selection the useful
   * action is to bring the rest up to proxied, not to clear the ones already set.
   */
  const allSelectedProxied = useMemo(
    () => selectedCards.length > 0 && selectedCards.every((card) => card.proxied),
    [selectedCards]
  )

  /**
   * Stages the selected entries for pulling out of this deck.
   *
   * The deck is unambiguous here, which is why this is the simpler of the two
   * entry points: the Collection has to ask which deck a grouped row leaves.
   *
   * Entries the pull refuses — a slot filled by a proxy, a label that is not
   * "owned" — are reported rather than skipped silently, because a selection of
   * twenty that stages fifteen needs to say why.
   */
  const stageForPull = async (
    target: number | 'new',
    destination: PickDestination
  ): Promise<void> => {
    const chosen = selectedCards.filter((card) => card.oracle_id)
    if (!chosen.length) return
    setBusy(true)
    const listId =
      target === 'new'
        ? await guard(() => window.api.pickLists.create(t('picks.defaultName')))
        : target
    if (listId === null || listId === undefined) {
      setBusy(false)
      return
    }

    let added = 0
    let refused = 0
    for (const card of chosen) {
      // One at a time: addMany would abort the whole batch on the first refusal,
      // and a mixed selection is exactly when this is used.
      const result = await window.api.pickLists
        .add(
          listId,
          {
            kind: 'deck',
            deckId: deck.id,
            oracleId: card.oracle_id as string,
            destination
          },
          1
        )
        .catch(() => null)
      if (result) added += result.added
      else refused += 1
    }
    setBusy(false)

    if (added > 0) {
      toast(
        'success',
        `${t.p('coll.staged', added)}${
          refused > 0 ? ` ${t.p('decks.pullRefused', refused)}` : ''
        }`
      )
      invalidate()
    } else {
      toast('warn', t('decks.pullNothing'))
    }
  }

  /**
   * Moves the selected entries into the collection, with no list involved.
   *
   * The direct route, for when you are simply taking cards out of a deck and
   * keeping them. A pick list is for a batch of jobs you will do later; this is the
   * job itself.
   */
  const moveSelectedToCollection = async (): Promise<void> => {
    /*
      Through the selection, not through the drawn rows.

      `ordered` holds each card once, but this used to read the rows: with the same card drawn
      under three categories, moving it would have called the IPC three times and taken three
      copies out of the deck. `selectedCards` is one entry per card, which is what a move means.
    */
    const chosen = selectedCards.filter((card) => card.oracle_id)
    if (!chosen.length) return
    setBusy(true)
    let moved = 0
    let refused = 0
    for (const card of chosen) {
      // One at a time: a batch call would abort on the first refusal, and a mixed
      // selection is exactly when this is used.
      const result = await window.api.decks
        // The row that was selected, not just the card: the deck can hold two printings
        // of it, and taking the other one out is not what was asked for.
        .moveToCollection(deck.id, card.oracle_id as string, 1, card.scryfall_id)
        .catch(() => null)
      if (result) moved += result.moved
      else refused += 1
    }
    setBusy(false)
    if (moved > 0) {
      toast(
        'success',
        `${t.p('decks.movedToCollection', moved)}${
          refused > 0 ? ` ${t.p('decks.pullRefused', refused)}` : ''
        }`
      )
      invalidate()
    } else {
      toast('warn', t('decks.pullNothing'))
    }
  }

  const setLanguage = async (lang: string): Promise<void> => {
    if (selectedOracleIds.length === 0) return
    setBusy(true)
    const result = await guard(() =>
      window.api.decks.setCardsLanguage(deck.id, selectedOracleIds, lang)
    )
    setBusy(false)
    if (result) {
      const upper = lang.toUpperCase()
      const parts: string[] = []
      if (result.converted) parts.push(t('bulk.langSet', { count: result.converted, lang: upper }))
      // Not a shortfall: the card kept the print it is on and now says you hold that
      // print in this language, which is the answer rather than the absence of one.
      if (result.declared) parts.push(t.p('bulk.langDeclared', result.declared, { lang: upper }))
      if (result.failed) parts.push(t('bulk.langFailed', { count: result.failed }))
      toast(result.failed ? 'warn' : 'success', `${parts.join(', ')}.`)
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
          ? t.p('bulk.finishDone', changed, {
              finish: treatment ? foilTreatmentLabel(treatment) : FINISH_LABEL[finish]
            })
          : t.p('bulk.finishCleared', changed)
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
          ? t.p('proxy.marked', changed)
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
              /* A stable handle: the collection's toggle has one, and a check that
                 reached this by its translated label would break with the language. */
              data-view="rows"
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
              data-view="grid"
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
            Card counts, not row counts. An entry of Forest ×8 contributes eight, which is
            why these three always sum to the deck total.

            Three, not two: a card sitting in your bulk is yours, but the deck is not
            finished until it is in the deck. The middle figure only appears when there is
            one, so a deck that is simply complete stays quiet.
          */}
          <span className="numeric text-good">
            {t('decks.owned', { count: count(totals.ownedCards) })}
          </span>
          {totals.inCollectionCards > 0 && (
            <span className="numeric text-warn" title={t('decks.inCollectionHint')}>
              {t('decks.inCollection', { count: count(totals.inCollectionCards) })}
            </span>
          )}
          <span className="numeric text-bad">
            {t('decks.missing', { count: count(totals.missingCards) })}
          </span>
          <span
            className="numeric text-ink-400"
            title={totals.missingValueIsProxy ? t('price.borrowed') : undefined}
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
            onAddToList={() => setListDialog(true)}
            onMoveToCollection={() => void moveSelectedToCollection()}
            onClear={clearSelection}
          />
        )}
      </AnimatePresence>

      {listDialog && (
        <AddToListDialog
          // Always offered here: everything selectable on this screen is a deck
          // card, so the question always has two answers.
          showDestination
          onCancel={() => setListDialog(false)}
          onConfirm={(target, destination) => {
            setListDialog(false)
            void stageForPull(target, destination)
          }}
        />
      )}

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
            onZoom={(scryfallId, title, hasBack) => setZoom({ scryfallId, title, hasBack })}
          />
        )}
      </div>

      {zoom && (
        <CardZoom
          open
          scryfallId={zoom.scryfallId}
          title={zoom.title}
          hasBack={zoom.hasBack}
          onClose={() => setZoom(null)}
        />
      )}
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
  ready,
  onZoom
}: {
  items: DeckBodyItem[]
  deck: Deck
  mode: 'rows' | 'grid'
  currency: 'usd' | 'eur'
  scrollRef: React.RefObject<HTMLDivElement | null>
  selected: Set<number>
  onSelect: (id: number, mode: PickMode) => void
  tileWidth: number
  density: ReturnType<typeof useGridMetrics>['density']
  ready: boolean
  /** Opens the closer look on the card whose thumbnail was clicked. */
  onZoom: (scryfallId: string, title: string, hasBack: boolean) => void
}): React.ReactElement {
  const tileRowHeight = tileWidth * CARD_ASPECT + GRID_GAP
  // Declared before the `ready` bail-out below, because a hook cannot be conditional.
  const preview = useCardPreview()

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
                currency={currency}
                selected={selected.has(item.card.id)}
                onSelect={onSelect}
                onPreview={preview.onEnter}
                onPreviewEnd={preview.onLeave}
                onZoom={onZoom}
                section={item.section}
              />
            ) : item.kind === 'tiles' ? (
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
                    currency={currency}
                    density={density}
                    selected={selected.has(card.id)}
                    onSelect={onSelect}
                  />
                ))}
              </div>
            ) : null}
          </div>
        )
      })}
      {/*
        One panel for the whole list. Inside a row it would be clipped by the scroller and
        would overflow the height that row declares -- which is the failure check:geometry
        exists to catch.
      */}
      {preview.panel}
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
        {group.name === UNCATEGORIZED
          ? t('deck.uncategorized')
          : group.name === FLAT_CARDS
            ? t('deck.flatCards')
            : group.name}
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
            title={group.missingValueIsProxy ? t('price.borrowed') : undefined}
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
  currency,
  selected,
  onSelect,
  onPreview,
  onPreviewEnd,
  onZoom,
  section
}: {
  card: DeckCardRow
  deck: Deck
  /** The active currency, for the price the row shows. */
  currency: 'usd' | 'eur'
  /** Which category drew this row; the same card is drawn under each one it carries. */
  section: string
  selected: boolean
  onSelect: (id: number, mode: PickMode) => void
  onZoom: (scryfallId: string, title: string, hasBack: boolean) => void
  /** Show this card, big, beside the row. Stable, so this memoized row keeps its memo. */
  onPreview: (scryfallId: string | null, anchor: HTMLElement | null) => void
  onPreviewEnd: () => void
}): React.ReactElement {
  const t = useT()
  const openCard = useApp((s) => s.openCard)
  // Derived through the same helper the totals use, so a row can never disagree with
   // the deck header about what is in the deck and what is merely yours.
  const allocated = allocateCopies(card)
  // Owning the card only in another printing is worth flagging: the physical
  // card you have is not the one the deck lists.
  const onlyOtherPrinting = card.owned_exact === 0 && card.owned_any > 0
  const blocked = deckCardSelectable(card)

  const onRowClick = (e: React.MouseEvent): void => {
    if (blocked) return
    if (e.ctrlKey || e.metaKey) onSelect(card.id, 'toggle')
    else if (e.shiftKey) onSelect(card.id, 'range')
    // A plain click selects just this one, as it does in the collection's list. Both are
    // lists of cards whose name opens the card, so both answer a click the same way.
    else onSelect(card.id, 'only')
  }

  return (
    <div
      onClick={onRowClick}
      /* A stable hook for the live checks: selection here is ctrl+click, with no
         checkbox to find, so a check that hunts for one selects nothing. */
      data-deck-card={card.id}
      /* The same card is drawn under every category it carries, so the id alone no longer
         identifies a row. */
      data-deck-section={section}
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

      {/*
        A button, like the collection's: hovering shows the card beside the row and clicking
        opens the closer look. The click is stopped here rather than falling through to the
        row, so pointing at the art and asking to see it does not also change the selection.

        Focus and blur as well as hover, because a button can be reached with the keyboard
        and arrowing through a deck should show you what pointing at it does.
      */}
      <button
        onClick={(e) => {
          e.stopPropagation()
          if (!card.scryfall_id) return
          const sides = twoSides({
            scryfall_id: card.scryfall_id,
            name: card.name,
            printed_name: null,
            layout: card.layout
          })
          onZoom(card.scryfall_id, card.name, sides !== null)
        }}
        onMouseEnter={(e) => onPreview(card.scryfall_id, e.currentTarget)}
        onMouseLeave={onPreviewEnd}
        onFocus={(e) => onPreview(card.scryfall_id, e.currentTarget)}
        onBlur={onPreviewEnd}
        aria-label={t('coll.zoomHint')}
        data-action="zoomArt"
        data-thumb=""
        className="shrink-0 cursor-zoom-in rounded"
      >
        <CardImage scryfallId={card.scryfall_id} className="h-8 w-6 shrink-0" alt={card.name} />
      </button>

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

      {/* Narrowed for the price too; the foil label was already truncated. */}
      <span className="w-20 shrink-0 truncate text-right text-[10px]">
        {card.finish === 'nonfoil' ? (
          <span className="text-ink-700">—</span>
        ) : (
          <span
            title={
              card.foil_treatment
                ? `${foilTreatmentLabel(card.foil_treatment)}${
                    card.treatment_forced ? ` ${t('decks.youSetThis')}` : ''
                  }`
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

      {/* Narrowed from w-20 to make room for the price: a set code is three or four
          characters, and the row was already 200px wider than the smallest window. */}
      <span className="w-14 shrink-0 truncate text-[11px] uppercase text-ink-500">
        {card.set_code ?? '—'}
      </span>

      {/*
        What the deck holds, and what your bulk holds towards the rest.

        This read `held`, which was the two added together -- so a deck holding none of a
        card you had four of said "have 4" in green.
      */}
      <span
        className={`numeric w-32 shrink-0 text-right text-xs ${
          allocated.inDeck >= card.quantity
            ? 'text-good'
            : allocated.missing === 0
              ? 'text-warn'
              : 'text-bad'
        }`}
      >
        {allocated.inDeck >= card.quantity
          ? t('decks.have', { held: allocated.inDeck })
          : t('decks.haveOf', { held: allocated.inDeck, needed: card.quantity })}
        {allocated.fromCollection > 0 && (
          <span className="ml-1 text-ink-500" title={t('decks.inCollectionHint')}>
            {t('decks.inBulk', { count: allocated.fromCollection })}
          </span>
        )}
      </span>

      {/*
        What one copy costs — the same figure, in the same shape, as the collection's Unit
        column.

        Every other number on this screen is missing-copy money: the header's pile and each
        section's figure multiply the price by what you still have to buy, so a card you
        already own contributes nothing to any of them and its value appeared nowhere. This
        is the card's own price, per copy, which is the question the collection answers about
        the same card.

        A `span` rather than a button, and no visible word "proxy": the selection probe finds
        the card name as the row's third button and skips any row whose text says Proxy, so a
        clickable or wordier cell here breaks it somewhere else entirely.
      */}
      <span
        className="numeric w-20 shrink-0 truncate text-right text-xs text-ink-300"
        title={card.price_is_proxy ? t('price.borrowed') : undefined}
      >
        {card.price_is_proxy
          ? proxyMoney(card.unit_value, currency)
          : money(card.unit_value, currency)}
      </span>

      {/* Also narrowed for the price. Four badges, rarely more than one at a time. */}
      <span className="flex w-32 shrink-0 justify-end gap-1">
        {card.moved !== 0 && <PulledBadge card={card} />}
        {card.proxied && (
          <span
            title={t('proxy.deckSlot')}
            className="rounded bg-ink-750 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-ink-300"
          >
            {t('proxy.badge')}
          </span>
        )}
        {card.label_possession && (
          <PossessionBadge card={card} held={allocated.fromCollection} />
        )}
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
  currency,
  density,
  selected,
  onSelect
}: {
  card: DeckCardRow
  deck: Deck
  /** The active currency, for the price in the tile's footer. */
  currency: 'usd' | 'eur'
  density: ReturnType<typeof useGridMetrics>['density']
  selected: boolean
  onSelect: (id: number, mode: PickMode) => void
}): React.ReactElement {
  const t = useT()
  const openCard = useApp((s) => s.openCard)
  const allocated = allocateCopies(card)
  // Complete means the deck holds it. Copies in your bulk are yours, not sleeved.
  const complete = allocated.inDeck >= card.quantity
  const coveredByBulk = !complete && allocated.missing === 0
  // Computed once per tile: pure, and read four times below.
  const sides =
    card.scryfall_id === null
      ? null
      : twoSides({
          scryfall_id: card.scryfall_id,
          name: card.name,
          printed_name: null,
          layout: card.layout
        })
  const blocked = deckCardSelectable(card)

  return (
    <CardTile
      scryfallId={card.scryfall_id}
      /*
        `card.name` is already "A // B" for a two-faced card, which is what Archidekt
        reports, so the title agrees with the tile rather than being composed twice.
      */
      title={sides ? `${sides.front.title} // ${sides.back.title}` : card.name}
      backScryfallId={sides?.back.scryfallId ?? null}
      backFace={sides?.back.face}
      density={density}
      selected={selected}
      disabledReason={blocked ?? undefined}
      ringClass={
        card.is_commander
          ? 'ring-gold-500/60 hover:ring-gold-400'
          : complete
            ? 'ring-good/50 hover:ring-good'
            : // Yours, but in your bulk rather than in the deck: neither done nor to buy.
              coveredByBulk
              ? 'ring-warn/50 hover:ring-warn'
              : 'ring-bad/40 hover:ring-bad'
      }
      onOpen={() =>
        card.scryfall_id && openCard(card.scryfall_id, deckCardContext(card, deck))
      }
      onSelect={(selectMode) => onSelect(card.id, selectMode)}
      badges={
        <>
          {card.moved !== 0 && (
            <span
              title={t.p(
                card.moved < 0 ? 'decks.movedOutHint' : 'decks.movedInHint',
                Math.abs(card.moved)
              )}
              className={`rounded px-1.5 py-0.5 text-[9px] font-bold uppercase text-ink-950 ${
                card.moved < 0 ? 'bg-warn' : 'bg-good'
              }`}
            >
              {t(card.moved < 0 ? 'decks.movedOutBadge' : 'decks.movedInBadge')}
            </span>
          )}
          {card.proxied && (
            <span
              title={t('proxy.deckSlot')}
              className="rounded bg-ink-100 px-1.5 py-0.5 text-[9px] font-bold uppercase text-ink-950"
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
              className="rounded bg-warn px-1.5 py-0.5 text-[9px] font-bold uppercase text-ink-950"
            >
              {/* The mark, not a word: "no fr" was English on a French screen, and the
                  row variant beside it already says it this way. */}
              !{card.language_unavailable.toUpperCase()}
            </span>
          )}
          {card.override_lang && (
            <span
              title={t('decks.langOverride', { lang: card.override_lang.toUpperCase() })}
              className="rounded bg-gold-500 px-1.5 py-0.5 text-[9px] font-bold uppercase text-ink-950"
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
                    (allocated.fromCollection > 0
                      ? t('decks.notOwnedButHeld', { held: allocated.fromCollection })
                      : '')
              }
              className="rounded px-1.5 py-0.5 text-[9px] font-bold text-ink-950"
              style={{ backgroundColor: card.label_color ?? '#d99a3c' }}
            >
              {card.label_possession === 'owned'
              ? 'have'
              : allocated.fromCollection > 0
                ? 'in bulk'
                : 'want'}
            </span>
          )}
          {!card.counts && (
            <span className="rounded bg-ink-950 px-1.5 py-0.5 text-[9px] font-bold uppercase text-ink-50">
              SB
            </span>
          )}
        </>
      }
      footer={
        density === 'full' ? (
          /*
            Two lines, because the first one is full at the smallest tile this density
            covers: language, quantity and what the deck holds already spend 160px. The
            footer is absolutely positioned over the art, so a second line costs the tile no
            height and the virtualizer nothing at all.
          */
          <div className="flex w-full flex-col gap-1">
            <div className="flex items-center gap-1.5">
              <LangChip lang={card.lang} />
              <span className="numeric rounded bg-ink-950 px-1.5 text-[10px] text-ink-50">
                x{card.quantity}
              </span>
              <span
                className={`numeric ml-auto text-[10px] ${complete ? 'text-good' : 'text-bad'}`}
              >
                {t('decks.have', { held: allocated.inDeck })}
              </span>
            </div>
            <span
              className="numeric text-right text-[10px] text-ink-200"
              title={card.price_is_proxy ? t('price.borrowed') : undefined}
            >
              {card.price_is_proxy
                ? proxyMoney(card.unit_value, currency)
                : money(card.unit_value, currency)}
            </span>
          </div>
        ) : (
          <span
            className={`numeric rounded px-1.5 text-[10px] ${
              complete ? 'bg-good/80 text-ink-950' : 'bg-bad/80 text-white'
            }`}
          >
            {allocated.inDeck}/{card.quantity}
          </span>
        )
      }
    />
  )
})

/**
 * Says a card has physically left this deck, and offers to put it back.
 *
 * The badge exists because nothing else can say this: Archidekt still lists the
 * card, so the deck's own quantity is unchanged, and `held` is unchanged too —
 * the pull moved the copy into the collection, so there is still nothing to buy.
 * What changed is where the card physically is, and that is the one thing only
 * this can report.
 *
 * Reverting is offered per pull rather than per card so a card pulled twice into
 * two different lists can be put back one at a time.
 */
function PulledBadge({ card }: { card: DeckCardRow }): React.ReactElement {
  const t = useT()
  const toast = useApp((s) => s.toast)
  // Straight from the store rather than a prop threaded down through DeckBody:
  // the badge sits inside a virtualized row, and passing a callback through two
  // components that have no other use for it would be noise.
  const invalidate = useApp((s) => s.invalidate)
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)

  const revert = async (moveId: number): Promise<void> => {
    setOpen(false)
    // guard() surfaces the refusal when the copies were sold on through another
    // list — putting them back would be claiming a card that no longer exists.
    const result = await guard(() => window.api.decks.revertMove(moveId))
    if (result) {
      toast('success', t.p('decks.moveReverted', result.quantity))
      invalidate()
    }
  }

  return (
    <>
      <button
        ref={trigger}
        onClick={(e) => {
          e.stopPropagation()
          setOpen((v) => !v)
        }}
        title={t.p(
          card.moved < 0 ? 'decks.movedOutHint' : 'decks.movedInHint',
          Math.abs(card.moved)
        )}
        className={`rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase transition-colors ${
          card.moved < 0
            ? 'bg-warn/20 text-warn hover:bg-warn/30'
            : 'bg-good/20 text-good hover:bg-good/30'
        }`}
      >
        {t(card.moved < 0 ? 'decks.movedOutBadge' : 'decks.movedInBadge')}
      </button>

      <Popover open={open} onClose={() => setOpen(false)} trigger={trigger} width={252}>
        <p className="px-2 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wider text-ink-500">
          {t(card.moved < 0 ? 'decks.movedOutTitle' : 'decks.movedInTitle')}
        </p>
        <p className="px-2 pb-1.5 text-[11px] leading-relaxed text-ink-400">
          {t('decks.movedExplain')}
        </p>
        {card.moves.map((move) => (
          <button
            key={move.id}
            onClick={() => void revert(move.id)}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs
              transition-colors hover:bg-ink-750"
          >
            <RotateCcw size={12} className="shrink-0 text-gold-300" />
            <span className="min-w-0 flex-1 truncate text-ink-100">
                {/* Which way it went, and how many. */}
              {move.quantity < 0
                ? t.p('decks.movedOut', -move.quantity)
                : t.p('decks.movedIn', move.quantity)}
            </span>
            <span className="numeric shrink-0 text-[10px] text-ink-500">
              {count(Math.abs(move.quantity))}
            </span>
          </button>
        ))}
      </Popover>
    </>
  )
}

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
