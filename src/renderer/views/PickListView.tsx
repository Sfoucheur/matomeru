import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import {
  AlertTriangle,
  Check,
  Download,
  LayoutGrid,
  ListChecks,
  Plus,
  RotateCcw,
  Rows3,
  Trash2,
  Undo2,
  X
} from 'lucide-react'
import { foilTreatmentLabel } from '@shared/types'
import { useT } from '../hooks/useT'
import type { PickList, PickListItem } from '@shared/types'
import { guard, useApp } from '../store/app'
import type { ViewProps } from '../App'
import ColumnStepper from '../components/ColumnStepper'
import FoilBadge from '../components/FoilBadge'
import GalleryGrid from '../components/GalleryGrid'
import CardTile from '../components/CardTile'
import {
  Button,
  CardImage,
  EmptyState,
  LangChip,
  Modal,
  QuantityStepper,
  RarityPip
} from '../components/primitives'
import { FINISH_LABEL, bigMoney, count, money, relativeTime } from '../lib/format'

export default function PickListView({ active: isActive }: ViewProps): React.ReactElement {
  const t = useT()
  const dataVersion = useApp((s) => s.dataVersion)
  const invalidate = useApp((s) => s.invalidate)
  const toast = useApp((s) => s.toast)
  const settings = useApp((s) => s.settings)
  const openCard = useApp((s) => s.openCard)
  const scrollRef = useRef<HTMLDivElement>(null)
  const currency = settings?.currency ?? 'usd'

  const [lists, setLists] = useState<PickList[]>([])
  const [activeId, setActiveId] = useState<number | null>(null)
  const [items, setItems] = useState<PickListItem[]>([])
  const [confirming, setConfirming] = useState(false)
  const [loading, setLoading] = useState(true)
  // Persisted, so the choice survives navigation and a restart.
  const mode = useApp((s) => s.viewModeFor('picks'))
  const setViewMode = useApp((s) => s.setViewMode)

  const loadLists = useCallback(async () => {
    try {
      const next = await window.api.pickLists.list()
      setLists(next)
      setActiveId((current) => {
        if (current && next.some((list) => list.id === current)) return current
        return next.find((list) => list.status === 'open')?.id ?? next[0]?.id ?? null
      })
    } catch (err) {
      toast('error', (err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [toast])

  // A hidden view must not query: with every visited view kept mounted, one
  // invalidate() would otherwise fan out into a request from each screen. The
  // effect still re-runs on becoming active, picking up anything missed.
  useEffect(() => {
    if (!isActive) return
    void loadLists()
  }, [isActive, loadLists, dataVersion])

  useEffect(() => {
    if (!isActive) return
    if (activeId === null) {
      setItems([])
      return
    }
    window.api.pickLists
      .items(activeId)
      .then(setItems)
      .catch((err) => toast('error', (err as Error).message))
  }, [isActive, activeId, dataVersion, toast])

  const active = lists.find((list) => list.id === activeId) ?? null

  // Grouping by set is how you actually pull cards from a physical box.
  const grouped = useMemo(() => {
    const groups = new Map<string, PickListItem[]>()
    for (const item of items) {
      const key = `${item.set_code.toUpperCase()} — ${item.set_name}`
      const bucket = groups.get(key)
      if (bucket) bucket.push(item)
      else groups.set(key, [item])
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [items])

  const inDecks = items.filter((item) => item.decks.length > 0)
  const cardCount = items.reduce((sum, item) => sum + item.quantity, 0)
  const totalValue = items.reduce(
    (sum, item) => sum + (item.unit_value ?? 0) * item.quantity,
    0
  )

  const createList = async (): Promise<void> => {
    const id = await guard(() => window.api.pickLists.create(t('picks.defaultName')))
    if (id) {
      await loadLists()
      setActiveId(id)
    }
  }

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex w-60 shrink-0 flex-col border-r border-ink-800">
        <div className="flex shrink-0 items-center justify-between px-4 pb-2 pt-4">
          <h2 className="text-[10px] font-semibold uppercase tracking-wider text-ink-500">
            {t('picks.title')}
          </h2>
          <button
            onClick={() => void createList()}
            className="rounded p-1 text-ink-400 transition-colors hover:bg-ink-800 hover:text-gold-400"
            aria-label={t('picks.new')}
            title={t('picks.new')}
          >
            <Plus size={14} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-3">
          <AnimatePresence initial={false}>
            {lists.map((list) => (
              <motion.button
                key={list.id}
                layout
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, height: 0 }}
                onClick={() => setActiveId(list.id)}
                className={`relative w-full rounded-lg px-2.5 py-2 text-left transition-colors ${
                  activeId === list.id ? 'bg-ink-800 text-ink-50' : 'text-ink-300 hover:bg-ink-850'
                }`}
              >
                <p className="flex items-center gap-1.5 truncate text-xs font-medium">
                  <StatusDot status={list.status} />
                  <span className="truncate">{list.name}</span>
                </p>
                <p className="numeric mt-0.5 pl-3.5 text-[10px] text-ink-500">
                  {t('picks.cardsAndValue', {
                    cards: count(list.cardCount),
                    value: bigMoney(list.totalValue, currency)
                  })}
                </p>
              </motion.button>
            ))}
          </AnimatePresence>

          {!loading && lists.length === 0 && (
            <p className="px-2.5 py-4 text-[11px] leading-relaxed text-ink-600">
              {t('picks.none')}
            </p>
          )}
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        {!active ? (
          <EmptyState
            icon={<ListChecks size={30} />}
            title={t('picks.noneSelected')}
            hint={t('picks.noneSelectedHint')}
            action={
              <Button variant="primary" icon={<Plus size={14} />} onClick={() => void createList()}>
                {t('picks.new')}
              </Button>
            }
          />
        ) : (
          <>
            <ListHeader
              list={active}
              cardCount={cardCount}
              totalValue={totalValue}
              currency={currency}
              itemCount={items.length}
              mode={mode}
              onMode={(next) => setViewMode('picks', next)}
              onConfirm={() => setConfirming(true)}
              onChanged={invalidate}
              onReload={loadLists}
            />

            {active.status === 'open' && inDecks.length > 0 && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                className="shrink-0 overflow-hidden border-b border-warn/25 bg-warn/[0.07] px-5 py-2.5"
              >
                <p className="flex items-start gap-2 text-[11px] leading-relaxed text-warn">
                  <AlertTriangle size={13} className="mt-px shrink-0" />
                  <span>{t.p('picks.deckWarning', inDecks.length)}</span>
                </p>
              </motion.div>
            )}

            <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              {items.length === 0 ? (
                <EmptyState
                  title={t('picks.emptyTitle')}
                  hint={t('picks.emptyHint')}
                />
              ) : mode === 'grid' ? (
                <PickGrid
                  items={items}
                  currency={currency}
                  onOpenCard={openCard}
                  scrollRef={scrollRef}
                />
              ) : (
                <div className="space-y-5">
                  {grouped.map(([setLabel, setItems]) => (
                    <section key={setLabel}>
                      <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-500">
                        {setLabel}
                        <span className="numeric ml-2 font-normal normal-case text-ink-600">
                          {t('picks.cardsInGroup', {
                            count: setItems.reduce((sum, item) => sum + item.quantity, 0)
                          })}
                        </span>
                      </h3>
                      <div className="space-y-1">
                        <AnimatePresence initial={false}>
                          {setItems.map((item) => (
                            <PickRow
                              key={item.id}
                              item={item}
                              currency={currency}
                              editable={active.status === 'open'}
                              onChanged={invalidate}
                            />
                          ))}
                        </AnimatePresence>
                      </div>
                    </section>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {active && (
        <ConfirmDialog
          open={confirming}
          list={active}
          items={items}
          currency={currency}
          onClose={() => setConfirming(false)}
          onDone={() => {
            setConfirming(false)
            invalidate()
            void loadLists()
          }}
        />
      )}
    </div>
  )
}

function StatusDot({ status }: { status: PickList['status'] }): React.ReactElement {
  const color =
    status === 'open' ? 'bg-warn' : status === 'confirmed' ? 'bg-good' : 'bg-ink-600'
  return <span className={`h-2 w-2 shrink-0 rounded-full ${color}`} title={status} />
}

function ListHeader({
  list,
  cardCount,
  totalValue,
  currency,
  itemCount,
  mode,
  onMode,
  onConfirm,
  onChanged,
  onReload
}: {
  list: PickList
  cardCount: number
  totalValue: number
  currency: 'usd' | 'eur'
  itemCount: number
  mode: 'rows' | 'grid'
  onMode: (mode: 'rows' | 'grid') => void
  onConfirm: () => void
  onChanged: () => void
  onReload: () => Promise<void>
}): React.ReactElement {
  const t = useT()
  const toast = useApp((s) => s.toast)
  const [name, setName] = useState(list.name)
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => setName(list.name), [list.name, list.id])

  const rename = async (): Promise<void> => {
    if (name.trim() === list.name) return
    await guard(() => window.api.pickLists.rename(list.id, name))
    await onReload()
  }

  const cancel = async (): Promise<void> => {
    const ok = await guard(() => window.api.pickLists.cancel(list.id))
    if (ok) {
      toast('success', t('picks.cancelled'))
      onChanged()
      await onReload()
    }
  }

  const reopen = async (): Promise<void> => {
    const ok = await guard(() => window.api.pickLists.reopen(list.id))
    if (ok) {
      onChanged()
      await onReload()
    }
  }

  const remove = async (): Promise<void> => {
    const ok = await guard(() => window.api.pickLists.remove(list.id))
    if (ok) {
      toast('success', t('picks.deleted'))
      onChanged()
      await onReload()
    }
  }

  /**
   * Undoes a validated pull.
   *
   * Not the same thing as Ctrl+Z, which is session-only: this is here so a pull
   * validated weeks ago can still be put back. It reports the two directions
   * separately because they mean different things — cards restored to the
   * collection left your possession, cards returned to decks never did.
   */
  const revert = async (): Promise<void> => {
    const result = await guard(() => window.api.pickLists.revert(list.id))
    if (result) {
      toast(
        'success',
        t('picks.reverted', {
          restored: result.cardsRestored,
          returned: result.cardsReturnedToDecks
        })
      )
      onChanged()
      await onReload()
    }
  }

  const exportCsv = async (): Promise<void> => {
    const result = await guard(() => window.api.pickLists.exportCsv(list.id))
    if (result && !result.canceled) toast('success', t('picks.exported', { count: result.count }))
  }

  return (
    <header className="shrink-0 border-b border-ink-800 px-5 pb-3 pt-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          {list.status === 'open' ? (
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => void rename()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void rename()
              }}
              className="w-full max-w-sm rounded border border-transparent bg-transparent text-lg
                font-semibold tracking-tight text-ink-50 outline-none transition-colors
                hover:border-ink-700 focus:border-gold-500"
            />
          ) : (
            <h1 className="text-lg font-semibold tracking-tight text-ink-50">{list.name}</h1>
          )}
          <p className="mt-0.5 text-xs text-ink-400">
            <span
              className={
                list.status === 'open'
                  ? 'text-warn'
                  : list.status === 'confirmed'
                    ? 'text-good'
                    : 'text-ink-500'
              }
            >
              {list.status === 'open'
                ? t('picks.statusOpen')
                : list.status === 'confirmed'
                  ? t('picks.statusConfirmed', { when: relativeTime(list.closed_at) })
                  : t('picks.statusCancelled')}
            </span>
            {' · '}
            {t('picks.summary', {
              cards: count(cardCount),
              rows: count(itemCount),
              value: bigMoney(totalValue, currency)
            })}
          </p>
        </div>

        {mode === 'grid' && <ColumnStepper grid="picks" />}

        <div className="flex items-center overflow-hidden rounded-lg border border-ink-700">
          <button
            onClick={() => onMode('rows')}
            className={`px-2.5 py-1.5 transition-colors ${
              mode === 'rows' ? 'bg-ink-750 text-gold-400' : 'text-ink-400 hover:bg-ink-800'
            }`}
            aria-label={t('picks.rowView')}
            title={t('picks.rowView')}
          >
            <Rows3 size={15} />
          </button>
          <button
            onClick={() => onMode('grid')}
            className={`border-l border-ink-700 px-2.5 py-1.5 transition-colors ${
              mode === 'grid' ? 'bg-ink-750 text-gold-400' : 'text-ink-400 hover:bg-ink-800'
            }`}
            aria-label={t('picks.gridView')}
            title={t('picks.gridView')}
          >
            <LayoutGrid size={15} />
          </button>
        </div>

        <Button size="sm" icon={<Download size={13} />} onClick={() => void exportCsv()}>
          {t('picks.export')}
        </Button>

        {list.status === 'open' ? (
          <>
            <Button size="sm" icon={<X size={13} />} onClick={() => void cancel()}>
              {t('picks.cancelPull')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              icon={<Check size={14} />}
              disabled={itemCount === 0}
              onClick={onConfirm}
            >
              {t('picks.validatePull')}
            </Button>
          </>
        ) : list.status === 'cancelled' ? (
          <>
            <Button size="sm" icon={<RotateCcw size={13} />} onClick={() => void reopen()}>
              {t('picks.reopen')}
            </Button>
            <Button variant="danger" size="sm" icon={<Trash2 size={13} />} onClick={() => void remove()}>
              {t('picks.delete')}
            </Button>
          </>
        ) : (
          /*
            A validated list used to offer nothing at all — just a line saying it
            was kept as history. That left no way to undo a mistaken pull and no
            way to clear one out, so they accumulated without limit.
          */
          <>
            {/* Hooks so checks can find these without matching a label that
                changes with the language. */}
            <Button
              size="sm"
              icon={<Undo2 size={13} />}
              data-action="revertPull"
              onClick={() => void revert()}
            >
              {t('picks.revertPull')}
            </Button>
            <Button
              variant="danger"
              size="sm"
              icon={<Trash2 size={13} />}
              data-action="deleteList"
              onClick={() => setConfirmDelete(true)}
            >
              {t('picks.delete')}
            </Button>
            <span className="text-[11px] text-ink-500">{t('picks.confirmedKept')}</span>
          </>
        )}
      </div>

      {/*
        Deleting a validated list is confirmed because it cannot be reconstructed:
        the snapshot it carries is the only remaining record of what was pulled.
        Any pull markers it produced deliberately survive it — the cards really
        did leave their decks, and deleting the paperwork must not put them back.
      */}
      <Modal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={t('picks.deleteTitle')}
        width="max-w-md"
      >
        <div className="px-5 py-4">
          <p className="text-[12px] leading-relaxed text-ink-300">{t('picks.deleteBody')}</p>
          <div className="mt-4 flex justify-end gap-2">
            <Button size="sm" onClick={() => setConfirmDelete(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="danger"
              size="sm"
              icon={<Trash2 size={13} />}
              onClick={() => {
                setConfirmDelete(false)
                void remove()
              }}
            >
              {t('picks.delete')}
            </Button>
          </div>
        </div>
      </Modal>
    </header>
  )
}

function PickRow({
  item,
  currency,
  editable,
  onChanged
}: {
  item: PickListItem
  currency: 'usd' | 'eur'
  editable: boolean
  onChanged: () => void
}): React.ReactElement {
  const t = useT()
  const openCard = useApp((s) => s.openCard)
  // Available to this row = what is still in the collection. The backend caps
  // this too; the UI limit just avoids a pointless round trip.
  const max = item.owned_quantity ?? item.quantity

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: -24, height: 0 }}
      transition={{ duration: 0.2, ease: [0.25, 1, 0.5, 1] }}
      className="flex items-center gap-3 rounded-lg border border-ink-800 bg-ink-850 px-3 py-2"
    >
      <CardImage
        scryfallId={item.scryfall_id}
        className="h-9 w-7 shrink-0"
        alt={item.name}
      />

      <div className="min-w-0 flex-1 leading-tight">
        <p className="truncate text-sm text-ink-100">{item.printed_name ?? item.name}</p>
        <p className="truncate text-[11px] text-ink-500">
          #{item.collector_number} ·{' '}
                    {item.foil_treatment
                      ? foilTreatmentLabel(item.foil_treatment)
                      : FINISH_LABEL[item.finish]}{' '}
                    · {item.condition}
          {item.owned_quantity === null && (
            <span className="ml-2 text-ink-600">{t('picks.rowGone')}</span>
          )}
        </p>
      </div>

      <LangChip lang={item.lang} />
      <RarityPip rarity={item.rarity} />

      {item.decks.length > 0 && (
        <button
          onClick={() => openCard(item.scryfall_id)}
          title={item.decks.map((d) => `${d.deck_name} (${d.match})`).join('\n')}
          className="inline-flex items-center gap-1 rounded bg-warn/15 px-1.5 py-0.5 text-[10px]
            font-semibold text-warn transition-colors hover:bg-warn/25"
        >
          <AlertTriangle size={9} />
          {t.p('picks.deckCount', item.decks.length)}
          {/* Which way this one goes, when the list mixes the two. */}
          {item.destination !== null && (
            <span
              className={`ml-1.5 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase ${
                item.destination === 'gone'
                  ? 'bg-bad/20 text-bad'
                  : 'bg-good/20 text-good'
              }`}
            >
              {t(item.destination === 'gone' ? 'picks.destGone' : 'picks.destKeep')}
            </span>
          )}
        </button>
      )}

      {editable ? (
        <QuantityStepper
          value={item.quantity}
          min={1}
          max={max}
          size="sm"
          onChange={async (quantity) => {
            const ok = await guard(() => window.api.pickLists.setQuantity(item.id, quantity))
            if (ok) onChanged()
          }}
        />
      ) : (
        <span className="numeric w-20 text-center text-sm text-ink-200">×{item.quantity}</span>
      )}

      <span className="numeric w-16 text-right text-xs text-ink-300">
        {money(item.unit_value === null ? null : item.unit_value * item.quantity, currency)}
      </span>

      {editable && (
        <button
          onClick={async () => {
            const ok = await guard(() => window.api.pickLists.removeItem(item.id))
            if (ok) onChanged()
          }}
          className="rounded p-1 text-ink-600 transition-colors hover:bg-bad/15 hover:text-bad"
          aria-label={t('picks.removeItem')}
        >
          <Trash2 size={13} />
        </button>
      )}
    </motion.div>
  )
}

/**
 * Grid view of a pick list. Quantity editing stays in row mode and the detail
 * modal — a stepper does not fit a 90px tile — so tiles carry the staged count
 * and the deck warning, which are the two things you scan for.
 */
function PickGrid({
  items,
  currency,
  onOpenCard,
  scrollRef
}: {
  items: PickListItem[]
  currency: 'usd' | 'eur'
  onOpenCard: (scryfallId: string) => void
  scrollRef: React.RefObject<HTMLDivElement | null>
}): React.ReactElement {
  const t = useT()

  return (
    <GalleryGrid grid="picks" items={items} scrollRef={scrollRef}>
      {(item, { density }) => (
        <CardTile
          key={item.id}
          scryfallId={item.scryfall_id}
          title={item.printed_name ?? item.name}
          density={density}
          selectable={false}
          onOpen={() => onOpenCard(item.scryfall_id)}
          badges={
            <>
              <FoilBadge
                finish={item.finish}
                treatment={item.foil_treatment}
                density={density}
              />
              {item.decks.length > 0 ? (
              <span
                title={item.decks.map((d) => `${d.deck_name} (${d.match})`).join(', ')}
                className="inline-flex items-center gap-0.5 rounded bg-warn px-1.5 py-0.5 text-[9px] font-bold text-ink-950"
              >
                  <AlertTriangle size={8} />
                  {item.decks.length}
                </span>
              ) : null}
            </>
          }
          footer={
            density === 'full' ? (
              <>
                <LangChip lang={item.lang} />
                <span className="numeric rounded bg-gold-500 px-1.5 text-[10px] font-semibold text-ink-950">
                  {t('picks.picked', { count: item.quantity })}
                </span>
                <span className="numeric ml-auto text-[10px] text-gold-300">
                  {money(
                    item.unit_value === null ? null : item.unit_value * item.quantity,
                    currency
                  )}
                </span>
              </>
            ) : (
              <span className="numeric rounded bg-gold-500 px-1.5 text-[10px] font-semibold text-ink-950">
                {item.quantity}
              </span>
            )
          }
        />
      )}
    </GalleryGrid>
  )
}

function ConfirmDialog({
  open,
  list,
  items,
  currency,
  onClose,
  onDone
}: {
  open: boolean
  list: PickList
  items: PickListItem[]
  currency: 'usd' | 'eur'
  onClose: () => void
  onDone: () => void
}): React.ReactElement {
  const t = useT()
  const toast = useApp((s) => s.toast)
  const [busy, setBusy] = useState(false)

  const cardCount = items.reduce((sum, item) => sum + item.quantity, 0)
  const emptying = items.filter(
    (item) => item.owned_quantity !== null && item.owned_quantity === item.quantity
  )
  const inDecks = items.filter((item) => item.decks.length > 0)

  const confirm = async (): Promise<void> => {
    setBusy(true)
    const result = await guard(() => window.api.pickLists.confirm(list.id))
    setBusy(false)
    if (result) {
      toast(
        'success',
        `${t.p('picks.pulled', result.cardsRemoved)}${
          result.rowsDeleted ? t('picks.pulledRows', { count: result.rowsDeleted }) : ''
        }.${
          // Said separately because it is a different fact: these copies moved
          // out of a deck into your bulk, they did not leave your possession.
          result.cardsFreedFromDecks
            ? ` ${t('picks.freedFromDecks', { count: result.cardsFreedFromDecks })}`
            : ''
        }`
      )
      onDone()
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={t('picks.confirmTitle')}>
      <div className="space-y-4 px-5 py-4">
        <p className="text-sm leading-relaxed text-ink-200">
          {t.p('picks.confirmBody', cardCount)}
        </p>

        {inDecks.length > 0 && (
          <div className="rounded-lg border border-warn/30 bg-warn/[0.08] px-3.5 py-3">
            <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-warn">
              <AlertTriangle size={13} />
              {t.p('picks.inDeck', inDecks.length)}
            </p>
            <ul className="space-y-0.5 text-[11px] leading-relaxed text-ink-300">
              {inDecks.slice(0, 8).map((item) => (
                <li key={item.id} className="truncate">
                  {item.printed_name ?? item.name} —{' '}
                  <span className="text-warn">
                    {item.decks.map((deck) => deck.deck_name).join(', ')}
                  </span>
                </li>
              ))}
              {inDecks.length > 8 && (
                <li className="text-ink-500">
                  {t('picks.andMore', { count: inDecks.length - 8 })}
                </li>
              )}
            </ul>
          </div>
        )}

        {emptying.length > 0 && (
          <p className="rounded-lg border border-ink-700 bg-ink-800 px-3.5 py-2.5 text-[11px] leading-relaxed text-ink-300">
            {t.p('picks.emptying', emptying.length)}
          </p>
        )}

        <div className="max-h-56 overflow-y-auto rounded-lg border border-ink-800">
          <table className="w-full text-xs">
            <tbody>
              {items.map((item) => (
                <tr key={item.id} className="border-b border-ink-850 last:border-0">
                  <td className="numeric w-10 px-3 py-1.5 text-ink-400">×{item.quantity}</td>
                  <td className="truncate px-1 py-1.5 text-ink-200">
                    {item.printed_name ?? item.name}
                  </td>
                  <td className="w-14 px-1 py-1.5">
                    <LangChip lang={item.lang} />
                  </td>
                  <td className="w-20 px-1 py-1.5 text-ink-500">
                    {item.set_code.toUpperCase()} #{item.collector_number}
                  </td>
                  <td className="numeric w-16 px-3 py-1.5 text-right text-ink-300">
                    {money(
                      item.unit_value === null ? null : item.unit_value * item.quantity,
                      currency
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <footer className="flex shrink-0 justify-end gap-2 border-t border-ink-700 px-5 py-3">
        <Button onClick={onClose} disabled={busy}>
          {t('picks.notYet')}
        </Button>
        <Button variant="primary" icon={<Check size={14} />} onClick={() => void confirm()} disabled={busy}>
          {busy ? t('picks.removing') : t('picks.confirmAction', { count: cardCount })}
        </Button>
      </footer>
    </Modal>
  )
}
