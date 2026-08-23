import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  ArrowDown,
  ArrowUp,
  Boxes,
  Download,
  LayoutGrid,
  Copy,
  ArrowRightLeft,
  ListChecks,
  MapPin,
  Rows3,
  Trash2
} from 'lucide-react'
import type {
  CollectionPage,
  CardContext,
  CollectionRow,
  Condition,
  Deck,
  FacetCounts,
  Finish,
  PickSource,
  DeckSource,
  PickDestination,
  SortField,
  TranslationKey
} from '@shared/types'
import {
  CONDITIONS,
  FINISHES,
  FOIL_TREATMENTS,
  SORT_FIELDS,
  foilTreatmentLabel
} from '@shared/types'
import { guard, useApp } from '../store/app'
import { useT } from '../hooks/useT'
import type { ViewProps } from '../App'
import FilterBar from '../components/FilterBar'
import ColumnStepper from '../components/ColumnStepper'
import CardZoom from '../components/CardZoom'
import AddToListDialog from '../components/AddToListDialog'
import FoilBadge from '../components/FoilBadge'
import SetIcon from '../components/SetIcon'
import SortMenu from '../components/SortMenu'
import GalleryGrid from '../components/GalleryGrid'
import CardTile from '../components/CardTile'
import {
  Button,
  CardImage,
  ColorPips,
  EmptyState,
  LangChip,
  Modal,
  QuantityStepper,
  RarityPip,
  Select
} from '../components/primitives'
import {
  FINISH_LABEL,
  PROXY_PRICE_HINT,
  bigMoney,
  count,
  hasDistinctPrintedName,
  money,
  proxyMoney
} from '../lib/format'

/**
 * What opening this row lets you change. Only copies you entered are editable —
 * a derived deck row mirrors Archidekt and has no printing of its own to set.
 */
function collectionCardContext(row: CollectionRow): CardContext | undefined {
  if (row.source !== 'collection' || row.id === null) return undefined
  return {
    kind: 'collection',
    itemId: row.id,
    forcedLang: row.language_forced ? row.printing.lang : null
  }
}

/**
 * Whether a row can be put in a pick list.
 *
 * A real collection row always can. A derived deck row can too — pulling a card
 * out of a deck is a job you might want on a list — as long as the deck still has
 * a copy that nothing else has claimed. `available` is 0 for a deck row, so its
 * quantity is what to look at.
 */
function stageable(row: CollectionRow): boolean {
  return row.source === 'collection' ? row.available > 0 : row.quantity > 0
}

const PAGE_SIZE = 200
const ROW_HEIGHT = 52

export default function CollectionView({ active }: ViewProps): React.ReactElement {
  const t = useT()
  const filters = useApp((s) => s.filters)
  const setFilters = useApp((s) => s.setFilters)
  const dataVersion = useApp((s) => s.dataVersion)
  const invalidate = useApp((s) => s.invalidate)
  const settings = useApp((s) => s.settings)
  const openCard = useApp((s) => s.openCard)
  const toast = useApp((s) => s.toast)

  const [page, setPage] = useState<CollectionPage | null>(null)
  const [facets, setFacets] = useState<FacetCounts | null>(null)
  const [decks, setDecks] = useState<Deck[]>([])
  const [loading, setLoading] = useState(true)
  // Persisted, so the choice survives navigation and a restart.
  const mode = useApp((s) => s.viewModeFor('collection'))
  const setMode = useApp((s) => s.setViewMode)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  /** Anchor for shift-click ranges in the gallery. */
  const lastPicked = useRef<string | null>(null)
  const currency = settings?.currency ?? 'usd'

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [nextPage, nextFacets] = await Promise.all([
        window.api.collection.query(filters, PAGE_SIZE, 0),
        window.api.collection.facets(filters)
      ])
      setPage(nextPage)
      setFacets(nextFacets)
    } catch (err) {
      toast('error', (err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [filters, toast])

  // A hidden view must not query: with every visited view kept mounted, one
  // invalidate() would otherwise fan out into a request from each screen. The
  // effect still re-runs on becoming active, picking up anything missed.
  useEffect(() => {
    if (!active) return
    void load()
  }, [active, load, dataVersion])

  useEffect(() => {
    if (!active) return
    void window.api.decks.list().then(setDecks).catch(() => undefined)
  }, [active, dataVersion])

  // Drop selections that are no longer on screen, so bulk actions never act on
  // rows the user cannot see.
  useEffect(() => {
    if (!page) return
    const visible = new Set(page.rows.map((r) => r.key))
    setSelected((current) => {
      const next = new Set([...current].filter((id) => visible.has(id)))
      return next.size === current.size ? current : next
    })
  }, [page])

  const rows = page?.rows ?? []

  // Column headers drive the *primary* level only; whatever tie-breaker the sort
  // menu has set stays put.
  const toggleSort = (field: SortField): void => {
    if (filters.sort === field) {
      setFilters({ dir: filters.dir === 'asc' ? 'desc' : 'asc' })
    } else {
      setFilters({ sort: field, dir: field === 'name' || field === 'set_code' ? 'asc' : 'desc' })
    }
  }

  const toggleRow = (key: string): void => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
    lastPicked.current = key
  }

  /**
   * Gallery selection. Plain click opens the card, so selecting is Ctrl-click to
   * toggle and Shift-click to take a range from the last card touched.
   */
  const selectRow = (key: string, mode: 'toggle' | 'range'): void => {
    if (mode === 'toggle' || lastPicked.current === null) {
      toggleRow(key)
      return
    }
    const from = rows.findIndex((r) => r.key === lastPicked.current)
    const to = rows.findIndex((r) => r.key === key)
    if (from === -1 || to === -1) {
      toggleRow(key)
      return
    }
    const [start, end] = from <= to ? [from, to] : [to, from]
    setSelected((current) => {
      const next = new Set(current)
      // Only real rows can be acted on, so a range never picks up deck copies.
      for (let i = start; i <= end; i += 1) {
        if (stageable(rows[i])) next.add(rows[i].key)
      }
      return next
    })
    lastPicked.current = key
  }

  /*
    Both kinds of row can be selected now. A derived deck row still has no id and
    nothing that edits a collection row will touch it — `collectionCardContext`
    keeps returning undefined for it — but it can be staged, because a card
    sleeved in a deck is still a card you hold.
  */
  /*
    A staging run waiting on the user to say which deck each ambiguous card
    leaves. Holds the already-resolved entries too, so both halves are staged in
    one call once the dialog is answered.
  */
  const [pendingPick, setPendingPick] = useState<{
    target: number | 'new'
    entries: { source: PickSource; quantity: number }[]
    ambiguous: PendingChoice[]
    destination: PickDestination
  } | null>(null)

  /** Open while the dialog is asking which list and what happens to the copies. */
  const [listDialog, setListDialog] = useState(false)

  /*
    The card being looked at closely, from a list row.

    Held here rather than in the row: rows are virtualized, so one can unmount
    while its overlay is open — scrolling with the keyboard, or the list
    re-querying underneath — and the overlay would vanish with it.
  */
  const [zoom, setZoom] = useState<{ scryfallId: string; title: string } | null>(null)

  /** The rows waiting on a deck and a quantity before they move. */
  const [pendingMove, setPendingMove] = useState<CollectionRow[] | null>(null)

  const selectedRows = useMemo(
    () => rows.filter((row) => selected.has(row.key)),
    [rows, selected]
  )

  /**
   * Stages the selection into a named list.
   *
   * `null` is deliberately not accepted: on the main side it means
   * `ensureDefaultPickList()`, which silently reuses whichever open list was
   * created last — the behaviour this control exists to replace. 'new' creates
   * one explicitly instead.
   */
  const addSelectedToPickList = async (
    target: number | 'new',
    destination: PickDestination
  ): Promise<void> => {
    /*
      The same predicate selection uses, not a restatement of it.

      This read `row.available > 0`, which is 0 for a sleeved card by design — that
      number means bulk stock free to stage — so every deck row was dropped and
      confirming reported "nothing to pick". Selection said one thing and staging
      said another; sharing the predicate is what stops them disagreeing again.
    */
    const staged = selectedRows.filter(stageable)
    if (!staged.length) {
      toast('warn', t('coll.nothingToPick'))
      return
    }

    /*
      A collection row is its own address. A derived deck row is not: it groups a
      card across every deck holding it, so the copy has to be told which deck it
      is leaving before it can be staged. Decks are asked for on demand, and only
      for the rows that need it.
    */
    const entries: { source: PickSource; quantity: number }[] = []
    const ambiguous: PendingChoice[] = []

    for (const row of staged) {
      if (row.source === 'collection' && row.id !== null) {
        entries.push({ source: { kind: 'collection', itemId: row.id }, quantity: row.available })
        continue
      }
      const decks = await window.api.decks
        .pullSources(row.scryfall_id, row.finish)
        .catch(() => [] as DeckSource[])
      if (decks.length === 1) {
        entries.push({
          source: {
            kind: 'deck',
            deckId: decks[0].deck_id,
            oracleId: decks[0].oracle_id,
            destination
          },
          quantity: Math.min(row.quantity, decks[0].quantity)
        })
      } else if (decks.length > 1) {
        ambiguous.push({ row, decks })
      }
      // No pullable deck at all means every copy is spoken for already; the
      // toast below reports the shortfall rather than staging nothing silently.
    }

    if (ambiguous.length) {
      // Resolved by the dialog, which stages both halves together so a partial
      // list is never left behind if the dialog is dismissed.
      setPendingPick({ target, entries, ambiguous, destination })
      return
    }
    if (!entries.length) {
      toast('warn', t('coll.nothingToPick'))
      return
    }
    await stageEntries(target, entries)
  }

  /**
   * Moves the chosen copies out of the collection and into a deck.
   *
   * Direct and immediate — nothing is staged, because nothing is being decided
   * later. A pick list is for cards leaving your possession; this only changes
   * where a card of yours lives.
   */
  const moveToDeck = async (deckId: number, deckName: string, quantity: number): Promise<void> => {
    const rows = pendingMove ?? []
    setPendingMove(null)
    let moved = 0
    let refused = 0
    for (const row of rows) {
      if (row.id === null) continue
      /*
        Capped at what can actually move, not at what the row holds: copies
        reserved by an open pick list are promised to leaving your possession, and
        the repository refuses them. `available` is quantity less those.
      */
      const take = Math.min(quantity, row.available)
      if (take <= 0) {
        refused += 1
        continue
      }
      const result = await window.api.decks
        .moveToDeck(deckId, row.id, take)
        .catch(() => null)
      if (result) moved += result.moved
      else refused += 1
    }
    if (moved > 0) {
      // Refusals are counted and said out loud, as the Decks screen already does.
      // Reporting only the total meant a partly-refused batch looked like a clean
      // one, and there was no way to tell how many cards had not moved.
      toast(
        'success',
        `${t('coll.movedToDeck', { count: moved, deck: deckName })}${
          refused > 0 ? ` ${t.p('coll.moveRefused', refused)}` : ''
        }`
      )
      invalidate()
    } else {
      toast('warn', t('coll.nothingToMove'))
    }
  }

  /**
   * Sends resolved entries to a list and reports where they landed.
   *
   * Split out because the which-deck dialog finishes the same job: both halves
   * of a mixed selection have to be staged in one call, or dismissing the dialog
   * would leave a half-filled list behind.
   */
  const stageEntries = async (
    target: number | 'new',
    entries: { source: PickSource; quantity: number }[]
  ): Promise<void> => {
    const listId =
      target === 'new'
        ? await guard(() => window.api.pickLists.create(t('picks.defaultName')))
        : target
    if (listId === null || listId === undefined) return

    const result = await guard(() => window.api.pickLists.addMany(listId, entries))
    if (result) {
      // Name the destination: with several lists open, "staged 4 cards" alone
      // leaves you to guess where they went, which is the whole complaint.
      const lists = await window.api.pickLists.list().catch(() => [])
      const name = lists.find((list) => list.id === result.pickListId)?.name ?? ''
      toast(
        'success',
        `${t.p('coll.staged', result.added)}${
          result.capped ? t('coll.stagedCapped', { count: result.capped }) : ''
        }${name ? t('coll.stagedInto', { list: name }) : '.'}`
      )
      invalidate()
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header
        page={page}
        currency={currency}
        mode={mode}
        onMode={(next) => setMode('collection', next)}
      />
      <FilterBar facets={facets} decks={decks} />

      {zoom && (
        <CardZoom
          open
          scryfallId={zoom.scryfallId}
          title={zoom.title}
          onClose={() => setZoom(null)}
        />
      )}

      {listDialog && (
        <AddToListDialog
          /*
            Only offered when the selection actually contains a sleeved card. A
            collection row has one possible answer — it leaves your possession,
            which is what a pick list is for.
          */
          showDestination={selectedRows.some((row) => row.source === 'deck')}
          onCancel={() => setListDialog(false)}
          onConfirm={(target, destination) => {
            setListDialog(false)
            void addSelectedToPickList(target, destination)
          }}
        />
      )}

      {pendingMove && (
        <MoveToDeckDialog
          rows={pendingMove}
          onCancel={() => setPendingMove(null)}
          onConfirm={(deckId, deckName, quantity) => void moveToDeck(deckId, deckName, quantity)}
        />
      )}

      {pendingPick && (
        <WhichDeckDialog
          ambiguous={pendingPick.ambiguous}
          destination={pendingPick.destination}
          onCancel={() => setPendingPick(null)}
          onConfirm={(chosen) => {
            const pending = pendingPick
            setPendingPick(null)
            void stageEntries(pending.target, [...pending.entries, ...chosen])
          }}
        />
      )}

      <AnimatePresence>
        {selectedRows.length > 0 && (
          <BulkBar
            rows={selectedRows}
            onClear={() => setSelected(new Set())}
            onAddToList={() => setListDialog(true)}
            onMove={() =>
            setPendingMove(selectedRows.filter((row) => row.id !== null && row.available > 0))
          }
            onDone={invalidate}
          />
        )}
      </AnimatePresence>

      {loading && !page ? (
        <SkeletonRows />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Boxes size={30} />}
          title={
            page && page.total === 0 && !hasAnyFilter(filters)
              ? t('coll.emptyTitle')
              : t('coll.noMatchTitle')
          }
          hint={
            page && page.total === 0 && !hasAnyFilter(filters)
              ? t('coll.emptyHint')
              : t('coll.noMatchHint')
          }
        />
      ) : mode === 'table' ? (
        <TableView
          rows={rows}
          currency={currency}
          selected={selected}
          onToggleRow={toggleRow}
          onToggleAll={() => {
            const selectable = rows.filter(stageable)
            setSelected(
              selected.size === selectable.length
                ? new Set()
                : new Set(selectable.map((r) => r.key))
            )
          }}
          sort={filters.sort}
          dir={filters.dir}
          onSort={toggleSort}
          onOpenCard={openCard}
          onZoom={(scryfallId, title) => setZoom({ scryfallId, title })}
          onChanged={invalidate}
        />
      ) : (
        <GalleryView
          rows={rows}
          currency={currency}
          selected={selected}
          onSelect={selectRow}
          onOpenCard={openCard}
        />
      )}

      {page && page.total > rows.length && (
        <div className="shrink-0 border-t border-ink-800 px-5 py-2 text-center text-[11px] text-ink-500">
          {t('coll.showingFirst', { shown: count(rows.length), total: count(page.total) })}
        </div>
      )}
    </div>
  )
}

function hasAnyFilter(filters: ReturnType<typeof useApp.getState>['filters']): boolean {
  return (
    !!filters.search ||
    filters.langs.length > 0 ||
    filters.rarities.length > 0 ||
    filters.sets.length > 0 ||
    filters.finishes.length > 0 ||
    filters.conditions.length > 0 ||
    filters.colors.length > 0 ||
    !!filters.typeLine ||
    filters.cmcMin !== null ||
    filters.cmcMax !== null ||
    filters.valueMin !== null ||
    filters.valueMax !== null ||
    filters.deckScope !== null ||
    filters.onlyReserved
  )
}

function Header({
  page,
  currency,
  mode,
  onMode
}: {
  page: CollectionPage | null
  currency: 'usd' | 'eur'
  mode: 'table' | 'gallery'
  onMode: (mode: 'table' | 'gallery') => void
}): React.ReactElement {
  const t = useT()
  const filters = useApp((s) => s.filters)
  const setFilters = useApp((s) => s.setFilters)
  const toast = useApp((s) => s.toast)

  const exportCsv = async (): Promise<void> => {
    const result = await guard(() => window.api.csv.exportCollection(filters))
    if (result && !result.canceled) {
      toast('success', t('coll.exported', { count: count(result.count), path: result.path ?? '' }))
    }
  }

  return (
    <header className="flex shrink-0 items-center gap-4 px-5 pb-3 pt-4">
      <div className="min-w-0 flex-1">
        <h1 className="text-lg font-semibold tracking-tight text-ink-50">{t('coll.title')}</h1>
        <p className="mt-0.5 text-xs text-ink-400">
          {page ? (
            <>
              {t('coll.summary', {
                cards: count(page.totalQuantity),
                rows: count(page.total)
              })}
              <AnimatedValue value={page.totalValue} currency={currency} />
              {page.deckQuantity > 0 && (
                <span className="ml-2 text-ink-500" title={t('coll.deckSplitHint')}>
                  {t('coll.deckSplit', {
                    bulk: count(page.bulkQuantity),
                    deck: count(page.deckQuantity)
                  })}
                </span>
              )}
            </>
          ) : (
            t('coll.loading')
          )}
        </p>
      </div>

      <SortMenu
        fields={SORT_FIELDS}
        value={{ sort: filters.sort, dir: filters.dir, sort2: filters.sort2, dir2: filters.dir2 }}
        onChange={(patch) => setFilters(patch)}
        title={t('coll.sortTitle')}
      />

      {mode === 'gallery' && <ColumnStepper grid="collection" />}

      <div className="flex items-center overflow-hidden rounded-lg border border-ink-700">
        <button
          data-view="table"
          onClick={() => onMode('table')}
          className={`px-2.5 py-1.5 transition-colors ${
            mode === 'table' ? 'bg-ink-750 text-gold-400' : 'text-ink-400 hover:bg-ink-800'
          }`}
          aria-label={t('coll.tableView')}
          title={t('coll.tableView')}
        >
          <Rows3 size={15} />
        </button>
        <button
          data-view="gallery"
          onClick={() => onMode('gallery')}
          className={`border-l border-ink-700 px-2.5 py-1.5 transition-colors ${
            mode === 'gallery' ? 'bg-ink-750 text-gold-400' : 'text-ink-400 hover:bg-ink-800'
          }`}
          aria-label={t('coll.galleryView')}
          title={t('coll.galleryView')}
        >
          <LayoutGrid size={15} />
        </button>
      </div>

      <Button size="sm" icon={<Download size={13} />} onClick={exportCsv}>
        {t('coll.export')}
      </Button>
    </header>
  )
}

/** Counts up to the new total rather than snapping, so value changes register. */
function AnimatedValue({
  value,
  currency
}: {
  value: number
  currency: 'usd' | 'eur'
}): React.ReactElement {
  const [shown, setShown] = useState(value)
  const previous = useRef(value)

  useEffect(() => {
    const from = previous.current
    const to = value
    previous.current = value
    if (Math.abs(to - from) < 0.01) {
      setShown(to)
      return
    }
    const start = performance.now()
    const duration = 420
    let frame = 0
    const tick = (now: number): void => {
      const t = Math.min(1, (now - start) / duration)
      const eased = 1 - Math.pow(1 - t, 3)
      setShown(from + (to - from) * eased)
      if (t < 1) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [value])

  return <span className="numeric font-medium text-gold-400">{bigMoney(shown, currency)}</span>
}

/**
 * Asks which deck the copies are going into, and how many.
 *
 * Both questions, one dialog. The quantity is capped at the smallest of the
 * selected rows, so a mixed selection cannot ask for more than one of them holds —
 * the move itself caps per row as well, but offering an impossible number and then
 * quietly doing something else is worse than not offering it.
 */
function MoveToDeckDialog({
  rows,
  onCancel,
  onConfirm
}: {
  rows: CollectionRow[]
  onCancel: () => void
  onConfirm: (deckId: number, deckName: string, quantity: number) => void
}): React.ReactElement {
  const t = useT()
  const [decks, setDecks] = useState<{ deck_id: number; deck_name: string }[] | null>(null)
  const [deckId, setDeckId] = useState<number | null>(null)
  const [quantity, setQuantity] = useState(1)

  /*
    The smallest number any selected row can actually part with. `quantity` would be
    wrong: a row with copies reserved by an open list can only move `available`, so
    offering its full quantity meant the dialog proposed an amount the repository
    would refuse and the view would then swallow.
  */
  const movable = rows.filter((row) => row.available > 0)
  const most = Math.max(1, Math.min(...movable.map((row) => row.available)))

  useEffect(() => {
    void window.api.decks
      .choices()
      .then((all) => {
        setDecks(all)
        setDeckId(all[0]?.deck_id ?? null)
      })
      .catch(() => setDecks([]))
  }, [])

  return (
    <Modal open onClose={onCancel} title={t('coll.moveTitle')} width="max-w-md">
      <div className="px-5 py-4">
        <p className="mb-3.5 text-[11px] leading-relaxed text-ink-400">{t('coll.moveHint')}</p>

        <label className="mb-3 flex items-center justify-between gap-3">
          <span className="text-sm text-ink-200">{t('coll.moveWhichDeck')}</span>
          {decks === null ? (
            <div className="skeleton h-8 w-52 rounded" />
          ) : (
            <Select
              className="w-52"
              value={deckId === null ? '' : String(deckId)}
              onChange={(value) => setDeckId(value ? Number(value) : null)}
              placeholder={decks.length ? undefined : t('coll.noDecks')}
              options={decks.map((deck) => ({
                value: String(deck.deck_id),
                label: deck.deck_name
              }))}
            />
          )}
        </label>

        <label className="flex items-center justify-between gap-3" data-field="moveHowMany">
          <span className="text-sm text-ink-200">
            {t('coll.moveHowMany')}
            <span className="mt-0.5 block text-[11px] text-ink-500">
              {t('coll.moveAvailable', { count: most })}
            </span>
          </span>
          <QuantityStepper
            value={quantity}
            min={1}
            max={most}
            onChange={setQuantity}
          />
        </label>

        <div className="mt-4 flex justify-end gap-2">
          <Button size="sm" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={deckId === null}
            onClick={() => {
              const deck = decks?.find((d) => d.deck_id === deckId)
              if (deck) onConfirm(deck.deck_id, deck.deck_name, quantity)
            }}
          >
            {t('coll.moveConfirm')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

/** One selected card that sits in more than one deck, with the decks it is in. */
interface PendingChoice {
  row: CollectionRow
  decks: DeckSource[]
}

/**
 * Asks which deck each ambiguous copy is leaving.
 *
 * A derived collection row groups a card across every deck holding it, so it
 * cannot say where a pulled copy comes from — and the pull has to know, or the
 * "out of the deck" tag would land on the wrong deck. One dialog covers every
 * ambiguous card in the selection rather than one prompt each, because a bulk
 * stage of thirty rows would otherwise be thirty interruptions.
 *
 * Defaults to each card's first deck, so confirming without touching anything is
 * still a sane answer rather than a no-op.
 */
function WhichDeckDialog({
  ambiguous,
  destination,
  onCancel,
  onConfirm
}: {
  ambiguous: PendingChoice[]
  destination: PickDestination
  onCancel: () => void
  onConfirm: (entries: { source: PickSource; quantity: number }[]) => void
}): React.ReactElement {
  const t = useT()
  const [choice, setChoice] = useState<Record<string, number>>(() =>
    Object.fromEntries(ambiguous.map((a) => [a.row.key, a.decks[0].deck_id]))
  )

  const confirm = (): void => {
    const entries: { source: PickSource; quantity: number }[] = []
    for (const item of ambiguous) {
      const deck = item.decks.find((d) => d.deck_id === choice[item.row.key])
      if (!deck) continue
      entries.push({
        source: {
          kind: 'deck',
          deckId: deck.deck_id,
          oracleId: deck.oracle_id,
          destination
        },
        // Never offer more than the chosen deck actually has: the row's own
        // figure is the total across every deck holding the card.
        quantity: Math.min(item.row.quantity, deck.quantity)
      })
    }
    onConfirm(entries)
  }

  return (
    <Modal open onClose={onCancel} title={t('coll.whichDeckTitle')} width="max-w-lg">
      <div className="px-5 py-4">
        <p className="mb-3.5 text-[11px] leading-relaxed text-ink-400">
          {t('coll.whichDeckHint')}
        </p>
        <div className="flex flex-col gap-2.5">
          {ambiguous.map((item) => (
            <label key={item.row.key} className="flex items-center justify-between gap-3">
              <span className="min-w-0 flex-1 truncate text-sm text-ink-200">
                {item.row.printing.printed_name ?? item.row.printing.name}
              </span>
              <Select
                className="w-52 shrink-0"
                value={String(choice[item.row.key])}
                onChange={(value) =>
                  setChoice((prev) => ({ ...prev, [item.row.key]: Number(value) }))
                }
                options={item.decks.map((deck) => ({
                  value: String(deck.deck_id),
                  label: `${deck.deck_name} (${count(deck.quantity)})`
                }))}
              />
            </label>
          ))}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button size="sm" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" size="sm" onClick={confirm}>
            {t('coll.whichDeckConfirm')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

function BulkBar({
  rows,
  onAddToList,
  onMove,
  onClear,
  onDone
}: {
  rows: CollectionRow[]
  /** Opens the dialog that asks which list, and what happens to the copies. */
  onAddToList: () => void
  /** Opens the dialog that moves the selection into a deck. */
  onMove: () => void
  onClear: () => void
  /**
   * Refresh the data, keeping the selection.
   *
   * Nothing here clears it: you usually want to do a second thing to the same
   * cards — set the finish, then the condition, then stage them — and a toggle
   * could not work at all if pressing it hid the bar. Removal is the exception
   * that needs no special case: those rows stop existing, so the selection
   * empties on its own.
   */
  onDone: () => void
}): React.ReactElement {
  const t = useT()
  const toast = useApp((s) => s.toast)
  /*
    Only real collection rows can be edited or removed. A selection can now mix
    them with derived deck rows, which have no id and mirror Archidekt, so `ids`
    is what the editing actions apply to and `sleeved` is what they cannot touch.
  */
  const ids = rows.map((r) => r.id).filter((id): id is number => id !== null)
  const sleeved = rows.length - ids.length
  const ownRows = rows.filter((row) => row.id !== null)
  const allProxied = ownRows.length > 0 && ownRows.every((row) => row.proxied)

  const applyFinish = async (finish: Finish): Promise<void> => {
    const ok = await guard(() => window.api.collection.bulkUpdate(ids, { finish }))
    if (ok) {
      toast('success', t('coll.setFinishDone', { count: ids.length, finish: FINISH_LABEL[finish] }))
      onDone()
    }
  }
  const applyTreatment = async (treatment: string): Promise<void> => {
    // The sentinel is how "back to whatever the printing says" is expressed
    // through a <Select>, which cannot carry null.
    const value = treatment === 'auto' ? null : treatment
    const ok = await guard(() =>
      window.api.collection.bulkUpdate(ids, { foil_treatment: value })
    )
    if (ok) {
      toast(
        'success',
        value
          ? t('coll.setTreatmentDone', {
              count: ids.length,
              treatment: foilTreatmentLabel(value)
            })
          : t('coll.clearedTreatment', { count: ids.length })
      )
      onDone()
    }
  }
  const applyProxied = async (proxied: boolean): Promise<void> => {
    const ok = await guard(() =>
      window.api.collection.bulkUpdate(ids, { proxied: proxied ? 1 : 0 })
    )
    if (ok) {
      toast(
        'success',
        proxied
          ? t('proxy.marked', { count: ids.length })
          : t('proxy.unmarked', { count: ids.length })
      )
      onDone()
    }
  }
  const applyCondition = async (condition: Condition): Promise<void> => {
    const ok = await guard(() => window.api.collection.bulkUpdate(ids, { condition }))
    if (ok) {
      toast('success', t('coll.setConditionDone', { count: ids.length, condition }))
      onDone()
    }
  }
  const removeAll = async (): Promise<void> => {
    const result = await guard(() => window.api.collection.bulkRemove(ids))
    if (result) {
      toast(
        result.skipped ? 'warn' : 'success',
        `${t('coll.removedRows', { count: result.removed })}${
          result.skipped ? t('coll.removedSkipped', { count: result.skipped }) : '.'
        }`
      )
      onDone()
    }
  }

  return (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ duration: 0.18, ease: [0.25, 1, 0.5, 1] }}
      className="shrink-0 overflow-hidden border-b border-gold-500/25 bg-gold-500/[0.07]"
    >
      <div className="flex flex-wrap items-center gap-2.5 px-5 py-2.5">
        <span className="text-xs text-ink-200">
          {t('common.selected', { count: rows.length })}
          {sleeved > 0 && (
            <span className="ml-1.5 text-[11px] text-ink-400">
              {t('coll.sleevedNote', { count: sleeved })}
            </span>
          )}
        </span>
        {/*
          One button for the whole decision. The destination used to be a dropdown
          parked here beside a separate chooser — two controls for one act, and a
          dropdown that sits there permanently reads as a setting rather than as
          part of what you are about to do. Both questions live in the dialog now.
        */}
        <Button
          variant="primary"
          size="sm"
          icon={<ListChecks size={13} />}
          onClick={onAddToList}
          data-action="addToList"
        >
          {t('coll.addToPickList')}
        </Button>
        {/* Only real rows can go into a deck: a sleeved card is already in one. */}
        {ids.length > 0 && (
          <Button
            size="sm"
            icon={<ArrowRightLeft size={13} />}
            onClick={onMove}
            data-action="moveToDeck"
          >
            {t('coll.moveToDeck')}
          </Button>
        )}
        {/*
          Hidden rather than disabled when nothing editable is selected: these
          controls change a collection row, and a derived deck row has none. The
          Select primitive takes no disabled prop, and inventing one to grey out
          a control that can never apply would say less than not offering it.
        */}
        {ids.length > 0 && (
          <>
        <Select
          className="w-28"
          value={'' as Finish}
          onChange={(finish) => finish && void applyFinish(finish)}
          placeholder={t('coll.finishPlaceholder')}
          options={FINISHES.map((f) => ({ value: f, label: FINISH_LABEL[f] }))}
        />
        <Select
          className="w-32"
          value={''}
          onChange={(treatment) => treatment && void applyTreatment(treatment)}
          placeholder={t('coll.treatmentPlaceholder')}
          options={[
            { value: 'auto', label: t('coll.fromThePrinting') },
            ...FOIL_TREATMENTS.map((tr) => ({ value: tr.tag, label: tr.label }))
          ]}
        />
        <Select
          className="w-28"
          value={'' as Condition}
          onChange={(condition) => condition && void applyCondition(condition)}
          placeholder={t('coll.conditionPlaceholder')}
          options={CONDITIONS.map((c) => ({ value: c, label: c }))}
        />
        {/* A proxy is a yes/no fact, so a pair of buttons beats a dropdown. Which
            one shows follows the selection: all proxies already, or not. */}
        <Button
          size="sm"
          icon={<Copy size={13} />}
          onClick={() => void applyProxied(!allProxied)}
          title={t('proxy.hint')}
        >
          {allProxied ? t('proxy.unmark') : t('proxy.mark')}
        </Button>
        <Button variant="danger" size="sm" icon={<Trash2 size={13} />} onClick={removeAll}>
          {t('coll.remove')}
        </Button>
          </>
        )}
        <button
          onClick={onClear}
          className="ml-auto text-[11px] text-ink-400 transition-colors hover:text-ink-100"
        >
          {t('common.clearSelection')}
        </button>
      </div>
    </motion.div>
  )
}

const COLUMNS: {
  field: SortField | null
  /** A key, resolved at render time, or null for the unlabelled action column. */
  label: TranslationKey | null
  className: string
}[] = [
  { field: 'name', label: 'coll.col.card', className: 'flex-1 min-w-52' },
  { field: 'lang', label: 'coll.col.lang', className: 'w-16' },
  { field: 'rarity', label: 'coll.col.rarity', className: 'w-12' },
  { field: 'set_code', label: 'coll.col.set', className: 'w-28' },
  { field: 'collector_number', label: null, className: 'w-14' },
  { field: 'finish', label: 'coll.col.finish', className: 'w-20' },
  { field: 'condition', label: 'coll.col.condition', className: 'w-16' },
  { field: null, label: 'coll.col.decks', className: 'w-16' },
  { field: 'quantity', label: 'coll.col.qty', className: 'w-28' },
  { field: 'unit_value', label: 'coll.col.unit', className: 'w-20 text-right' },
  { field: 'total_value', label: 'coll.col.total', className: 'w-20 text-right' },
  { field: null, label: null, className: 'w-9' }
]

function TableView({
  rows,
  currency,
  selected,
  onToggleRow,
  onToggleAll,
  sort,
  dir,
  onSort,
  onOpenCard,
  onZoom,
  onChanged
}: {
  rows: CollectionRow[]
  currency: 'usd' | 'eur'
  selected: Set<string>
  onToggleRow: (key: string) => void
  onToggleAll: () => void
  sort: SortField
  dir: 'asc' | 'desc'
  onSort: (field: SortField) => void
  onOpenCard: (scryfallId: string, context?: CardContext) => void
  onZoom: (scryfallId: string, title: string) => void
  onChanged: () => void
}): React.ReactElement {
  const t = useT()
  const parentRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12
  })

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-ink-800 bg-ink-900 px-5 py-2 text-[10px] font-semibold uppercase tracking-wider text-ink-500">
        <input
          type="checkbox"
          checked={selected.size > 0 && selected.size === rows.length}
          onChange={onToggleAll}
          className="accent-gold-500"
          aria-label={t('coll.selectAll')}
        />
        {COLUMNS.map((column) => {
          // A null label is the collector-number column (just "#") and the
          // unlabelled action column; neither needs translating.
          const heading = column.label ? t(column.label) : column.field ? '#' : ''
          return (
            <div key={(column.label ?? '') + column.className} className={column.className}>
              {column.field ? (
                <button
                  onClick={() => onSort(column.field as SortField)}
                  className={`inline-flex items-center gap-1 transition-colors hover:text-ink-200 ${
                    sort === column.field ? 'text-gold-400' : ''
                  }`}
                >
                  {heading}
                  {sort === column.field &&
                    (dir === 'asc' ? <ArrowUp size={10} /> : <ArrowDown size={10} />)}
                </button>
              ) : (
                heading
              )}
            </div>
          )
        })}
      </div>

      <div ref={parentRef} className="min-h-0 flex-1 overflow-y-auto">
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const row = rows[virtualRow.index]
            return (
              <div
                // Must be row.key, never row.id: id is null for a derived deck
                // row, and a null key falls back to positional matching, so React
                // reuses the wrong nodes and paints stale names over other rows.
                key={row.key}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: virtualRow.size,
                  transform: `translateY(${virtualRow.start}px)`
                }}
              >
                <CardRow
                  row={row}
                  currency={currency}
                  isSelected={selected.has(row.key)}
                  onToggle={() => onToggleRow(row.key)}
                  onOpenCard={() => onOpenCard(row.scryfall_id, collectionCardContext(row))}
                  onZoom={() =>
                    onZoom(
                      row.scryfall_id,
                      row.printing.printed_name ?? row.printing.name
                    )
                  }
                  onChanged={onChanged}
                />
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function CardRow({
  row,
  currency,
  isSelected,
  onToggle,
  onOpenCard,
  onZoom,
  onChanged
}: {
  row: CollectionRow
  currency: 'usd' | 'eur'
  isSelected: boolean
  onToggle: () => void
  onOpenCard: () => void
  onZoom: () => void
  onChanged: () => void
}): React.ReactElement {
  const t = useT()
  const toast = useApp((s) => s.toast)
  const printing = row.printing
  // A derived deck copy has no underlying row, so nothing here can be edited.
  const editable = row.source === 'collection' && row.id !== null

  const setQuantity = async (quantity: number): Promise<void> => {
    if (row.id === null) return
    const ok = await guard(() => window.api.collection.setQuantity(row.id as number, quantity))
    if (ok) onChanged()
  }

  return (
    <div
      className={`flex h-full items-center gap-3 border-b border-ink-850 px-5 text-sm transition-colors ${
        isSelected ? 'bg-gold-500/[0.06]' : 'hover:bg-ink-850/60'
      }`}
    >
      {editable ? (
        <input
          type="checkbox"
          checked={isSelected}
          onChange={onToggle}
          className="accent-gold-500"
          aria-label={t('coll.selectRow', { name: printing.name })}
        />
      ) : (
        <span className="w-[13px]" aria-hidden />
      )}

      <div className="flex min-w-52 flex-1 items-center gap-2.5 overflow-hidden">
        {/*
          The thumbnail opens the same closer look the detail dialog does. In list
          mode it was the only place a card's art could not be seen properly — the
          row is 36px tall. `zoom-in` is the cursor the detail artwork already uses,
          so the affordance reads the same in both places.
        */}
        <button
          onClick={onZoom}
          title={t('coll.zoomHint')}
          aria-label={t('coll.zoomHint')}
          className="shrink-0 cursor-zoom-in rounded"
        >
          <CardImage
            scryfallId={row.scryfall_id}
            className="h-9 w-7 shrink-0"
            alt={printing.name}
          />
        </button>
        <div className="min-w-0 leading-tight">
          <p className="truncate text-ink-100">
            <button
              onClick={onOpenCard}
              className="underline-offset-2 hover:underline"
              title={t('coll.cardDetails')}
            >
              {printing.printed_name ?? printing.name}
            </button>
            {row.reserved > 0 && (
              <span
                title={t('coll.reservedBadge', { count: row.reserved })}
                /*
                  Solid, not a 15% wash of the text's own colour: measured, the
                  fill was alpha 38/255, so the label sat on whatever happened to
                  be behind it.

                  The rule this follows, since tinted chips elsewhere are fine: a
                  chip on a panel may be a wash, because its text contrasts with
                  the panel underneath. A chip over card artwork must be solid —
                  nothing controls what is behind it, and `text-ink-950` on a solid
                  tone reads at 8:1 in dark and 6:1 in light because both invert.
                */
                className="ml-2 rounded bg-warn px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-ink-950"
              >
                {row.reserved} held
              </span>
            )}
          </p>
          {hasDistinctPrintedName(printing) && (
            <p className="truncate text-[11px] text-ink-500">{printing.name}</p>
          )}
        </div>
        <ColorPips colors={printing.color_identity} />
      </div>

      <div className="w-16">
        <LangChip lang={printing.lang} />
      </div>
      <div className="w-12">
        <RarityPip rarity={printing.rarity} />
      </div>
      <div
        className="flex w-28 items-center gap-1.5 truncate text-xs uppercase text-ink-400"
        title={printing.set_name}
      >
        <SetIcon code={printing.set_code} size={11} />
        <span className="truncate">{printing.set_code}</span>
      </div>
      <div className="numeric w-14 text-xs text-ink-400">{printing.collector_number}</div>
      <div className="w-20 truncate text-xs text-ink-300">
        {printing.finishes.length > 1 || row.finish !== 'nonfoil' ? (
          <span
            className={row.finish === 'nonfoil' ? '' : 'text-gold-300'}
            title={row.foil_treatment ? foilTreatmentLabel(row.foil_treatment) : undefined}
          >
            {/* The foil type is the more specific fact, so it replaces the bare
                "Foil" rather than crowding in beside it. */}
            {row.foil_treatment ? foilTreatmentLabel(row.foil_treatment) : FINISH_LABEL[row.finish]}
            {row.treatment_forced && <span title={t('coll.youSetThis')}>★</span>}
          </span>
        ) : (
          <span className="text-ink-500">—</span>
        )}
      </div>
      <div className="flex w-16 items-center gap-1 text-xs text-ink-300">
        {row.condition ?? <span className="text-ink-600">—</span>}
        {row.proxied && <ProxyChip />}
      </div>

      <div className="w-16">
        {row.deck_count > 0 ? (
          <button
            onClick={onOpenCard}
            title={t.p('coll.inDecksHint', row.deck_count)}
            className="inline-flex items-center gap-1 rounded bg-mana-u/15 px-1.5 py-0.5 text-[10px]
              font-semibold text-mana-u transition-colors hover:bg-mana-u/25"
          >
            <MapPin size={9} />
            {row.deck_count}
          </button>
        ) : (
          <span className="text-[10px] text-ink-600">—</span>
        )}
      </div>

      <div className="w-28">
        {editable ? (
          <QuantityStepper
            value={row.quantity}
            min={Math.max(0, row.reserved)}
            onChange={(quantity) => void setQuantity(quantity)}
            size="sm"
          />
        ) : (
          <span
            title={t('coll.sleevedIn', { decks: row.deck_names.join(', ') })}
            className="numeric inline-flex items-center gap-1.5 text-xs text-ink-300"
          >
            ×{row.quantity}
            <span className="rounded bg-mana-u/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-mana-u">
              {t('coll.inDeckBadge')}
            </span>
          </span>
        )}
      </div>

      <div
        className="numeric w-20 text-right text-xs text-ink-300"
        title={row.price_is_proxy ? PROXY_PRICE_HINT : undefined}
      >
        {row.price_is_proxy
          ? proxyMoney(row.unit_value, currency)
          : money(row.unit_value, currency)}
      </div>
      <div
        className="numeric w-20 text-right text-xs text-ink-100"
        title={row.price_is_proxy ? PROXY_PRICE_HINT : undefined}
      >
        {row.price_is_proxy
          ? proxyMoney(row.total_value, currency)
          : money(row.total_value, currency)}
      </div>

      <div className="flex w-9 justify-end">
        {editable && (
          <button
            onClick={async () => {
              const ok = await guard(() => window.api.collection.remove(row.id as number))
              if (ok) {
                toast('success', t('coll.rowRemoved'))
                onChanged()
              }
            }}
            className="rounded p-1 text-ink-600 transition-colors hover:bg-bad/15 hover:text-bad"
            aria-label={t('coll.removeRow')}
            title={t('coll.removeRow')}
          >
            <Trash2 size={13} />
          </button>
        )}
      </div>
    </div>
  )
}

function GalleryView({
  rows,
  currency,
  selected,
  onSelect,
  onOpenCard
}: {
  rows: CollectionRow[]
  currency: 'usd' | 'eur'
  selected: Set<string>
  onSelect: (key: string, mode: 'toggle' | 'range') => void
  onOpenCard: (scryfallId: string, context?: CardContext) => void
}): React.ReactElement {
  const t = useT()
  const scrollRef = useRef<HTMLDivElement>(null)

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-5">
      <GalleryGrid grid="collection" items={rows} scrollRef={scrollRef}>
        {(row, { density }) => (
          <CardTile
            key={row.key}
            scryfallId={row.scryfall_id}
            title={row.printing.printed_name ?? row.printing.name}
            density={density}
            selected={selected.has(row.key)}
            selectable={stageable(row)}
            onOpen={() => onOpenCard(row.scryfall_id, collectionCardContext(row))}
            onSelect={(mode) => onSelect(row.key, mode)}
            badges={
              <>
                {row.proxied && <ProxyChip tile />}
                <FoilBadge
                  finish={row.finish}
                  treatment={row.foil_treatment}
                  forced={row.treatment_forced}
                  density={density}
                />
                {/*
                  Badges here sit on card artwork, so they are solid.

                  Nothing controls what is behind them: a translucent chip is read
                  against whatever the art happens to be, and the worst of these put
                  a colour on a 25% wash of the same colour. `text-ink-950` is the
                  label throughout because it inverts opposite to the tone under it
                  — near-black on a light tone in dark mode, white on a dark tone in
                  light. A tinted chip is still fine on a panel, where its text
                  contrasts with the panel behind it.
                */}
                {row.source === 'deck' && (
                  <span
                    title={t('coll.sleevedInShort', { decks: row.deck_names.join(', ') })}
                    className="rounded bg-mana-u px-1.5 py-0.5 text-[9px] font-bold uppercase text-on-identity"
                  >
                    {t('coll.inDeckBadge')}
                  </span>
                )}
                {row.source === 'collection' && row.deck_count > 0 && (
                  <span
                    title={t('coll.inDeckCount', { count: row.deck_count })}
                    className="inline-flex items-center gap-0.5 rounded bg-mana-u px-1.5 py-0.5 text-[9px] font-bold text-on-identity"
                  >
                    <MapPin size={8} />
                    {row.deck_count}
                  </span>
                )}
                {row.reserved > 0 && (
                  <span
                    title={t('coll.reservedBadge', { count: row.reserved })}
                    className="rounded bg-warn px-1.5 py-0.5 text-[9px] font-bold text-ink-950"
                  >
                    {row.reserved}
                  </span>
                )}
              </>
            }
            footer={
              density === 'full' ? (
                <>
                  <LangChip lang={row.printing.lang} />
                  <span className="numeric rounded bg-ink-950 px-1.5 text-[10px] text-ink-50">
                    x{row.quantity}
                  </span>
                  <span className="numeric ml-auto text-[10px] text-gold-300">
                    {row.price_is_proxy
                      ? proxyMoney(row.total_value, currency)
                      : money(row.total_value, currency)}
                  </span>
                </>
              ) : (
                <span className="numeric rounded bg-ink-950 px-1.5 text-[10px] text-ink-50">
                  x{row.quantity}
                </span>
              )
            }
          />
        )}
      </GalleryGrid>
    </div>
  )
}

/**
 * Picks the pick list a selection is staged into.
 *
 * Replaces a button that silently used `ensureDefaultPickList()` — the most
 * recently created open list — so with two lists open the cards went wherever
 * you had last pressed New, and nothing said which.
 *
 * Portalled through `Popover` rather than positioned in place: the bulk bar
 * animates its own height behind `overflow-hidden`, which would clip an in-tree
 * menu outright. The lists are fetched when the menu opens, not on render — the
 * query runs several sub-selects per list for its totals, and this bar
 * re-renders on every change of selection.
 */
/**
 * Marks a copy as a proxy.
 *
 * Deliberately a different word from the app's other "proxy": `price_is_proxy`
 * means a price borrowed from another printing. This one means a card you
 * printed, which is worth nothing and still playable.
 */
function ProxyChip({ tile = false }: { tile?: boolean }): React.ReactElement {
  const t = useT()
  return (
    <span
      title={t('proxy.hint')}
      className={
        tile
          ? 'rounded bg-ink-100 px-1.5 py-0.5 text-[9px] font-bold uppercase text-ink-950'
          : 'rounded bg-ink-750 px-1 py-0.5 text-[9px] font-semibold uppercase text-ink-400'
      }
    >
      {t('proxy.badge')}
    </span>
  )
}

function SkeletonRows(): React.ReactElement {
  return (
    <div className="flex-1 space-y-px p-5">
      {Array.from({ length: 12 }).map((_, index) => (
        <div key={index} className="skeleton h-11 rounded" style={{ opacity: 1 - index * 0.06 }} />
      ))}
    </div>
  )
}
