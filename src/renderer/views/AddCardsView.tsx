import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Check, Search, Sparkles, Trash2, Zap } from 'lucide-react'
import {
  CONDITIONS,
  FINISHES,
  LANGUAGES,
  bothSidesTitle,
  effectiveFinishFor,
  foilTreatmentLabel,
  foilTreatmentOf,
  priceOfPrinting,
  twoSides,
  type Condition,
  type Finish,
  type PrintingChoice,
  type TileDensity
} from '@shared/types'
import { guard, useApp } from '../store/app'
import type { ViewProps } from '../App'
import ColumnStepper from '../components/ColumnStepper'
import GalleryGrid from '../components/GalleryGrid'
import PrintingFilterBar from '../components/PrintingFilterBar'
import { matchesPrintingFilters } from '../lib/printingFilter'
import Popover from '../components/Popover'
import {
  Button,
  CardImage,
  EmptyState,
  StackedArt,
  LangChip,
  QuantityStepper,
  RarityPip,
  Select
} from '../components/primitives'
import {
  FINISH_LABEL,
  count,
  foilLabelForDensity,
  languageName,
  money,
  proxyMoney
} from '../lib/format'
import { useT } from '../hooks/useT'
import { parseCollectorNumber } from '@shared/quickEntry'

export default function AddCardsView({ active }: ViewProps): React.ReactElement {
  const t = useT()
  const [tab, setTab] = useState<'search' | 'quick'>('search')

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="shrink-0 px-5 pb-3 pt-4">
        <h1 className="text-lg font-semibold tracking-tight text-ink-50">{t('add.title')}</h1>
        <p className="mt-0.5 text-xs text-ink-400">
          {t('add.cacheNote')}
        </p>
      </header>

      <div className="flex shrink-0 gap-1 border-b border-ink-800 px-5">
        {(
          [
            { key: 'search', label: t('add.tabSearch'), icon: <Search size={13} /> },
            { key: 'quick', label: t('add.tabQuick'), icon: <Zap size={13} /> }
          ] as const
        ).map((item) => (
          <button
            key={item.key}
            onClick={() => setTab(item.key)}
            className={`relative flex items-center gap-1.5 px-3 py-2.5 text-sm transition-colors ${
              tab === item.key ? 'text-gold-400' : 'text-ink-400 hover:text-ink-200'
            }`}
          >
            {item.icon}
            {item.label}
            {tab === item.key && (
              <motion.span
                layoutId="add-tab"
                transition={{ type: 'spring', stiffness: 520, damping: 36 }}
                className="absolute inset-x-0 -bottom-px h-0.5 bg-gold-500"
              />
            )}
          </button>
        ))}
      </div>

      {tab === 'search' ? <SearchTab active={active} /> : <QuickTab active={active} />}
    </div>
  )
}

// ---------- Search by name ----------

function SearchTab({ active }: { active: boolean }): React.ReactElement {
  const t = useT()
  const invalidate = useApp((s) => s.invalidate)
  const toast = useApp((s) => s.toast)
  const settings = useApp((s) => s.settings)
  const currency = settings?.currency ?? 'usd'

  const [query, setQuery] = useState('')
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [printings, setPrintings] = useState<PrintingChoice[] | null>(null)
  /** Set when a card has more printings than one lookup fetches. */
  const [truncatedTotal, setTruncatedTotal] = useState<number | null>(null)
  // Shared with the card-detail picker and kept for the session, so entering a
  // French collection means setting the language once rather than once per card.
  const scrollRef = useRef<HTMLDivElement>(null)
  const printingFilters = useApp((s) => s.printingFilters)
  const setPrintingFilters = useApp((s) => s.setPrintingFilters)
  const resetPrintingFilters = useApp((s) => s.resetPrintingFilters)
  const [loading, setLoading] = useState(false)
  const [finish, setFinish] = useState<Finish>('nonfoil')
  const [condition, setCondition] = useState<Condition>('NM')
  const [quantity, setQuantity] = useState(1)
  const [justAdded, setJustAdded] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const searchBoxRef = useRef<HTMLDivElement>(null)

  // The view is kept mounted, so focus follows becoming visible rather than
  // mounting — otherwise only the first visit would land in the field.
  useEffect(() => {
    if (active) inputRef.current?.focus()
  }, [active])

  useEffect(() => {
    if (query.trim().length < 2) {
      setSuggestions([])
      return
    }
    const timer = setTimeout(async () => {
      try {
        setSuggestions(await window.api.cards.suggest(query))
      } catch {
        setSuggestions([])
      }
    }, 220)
    return () => clearTimeout(timer)
  }, [query])

  const lookup = async (name: string): Promise<void> => {
    setQuery(name)
    setShowSuggestions(false)
    setLoading(true)
    setPrintings(null)
    setTruncatedTotal(null)
    try {
      const result = await window.api.cards.printingsPage(name)
      setPrintings(result.printings)
      setTruncatedTotal(result.truncated ? result.total : null)
      if (!result.printings.length) toast('warn', t('add.noPrintings', { name }))
    } catch (err) {
      toast('error', (err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const visible = useMemo(
    () => (printings ?? []).filter((p) => matchesPrintingFilters(p, printingFilters)),
    [printings, printingFilters]
  )

  const add = async (printing: PrintingChoice): Promise<void> => {
    // Plenty of printings exist in one finish only — foil-only promos, etched
    // Commander cards. Refusing the click just left the card unaddable, so the
    // printing's own finish wins when it does not have the one selected.
    const effectiveFinish = effectiveFinishFor(printing, finish)
    const result = await guard(() =>
      window.api.collection.add({
        scryfall_id: printing.scryfall_id,
        finish: effectiveFinish,
        condition,
        quantity
      })
    )
    if (result) {
      setJustAdded(printing.scryfall_id)
      setTimeout(() => setJustAdded(null), 1100)
      const finishNote =
        effectiveFinish === finish
          ? ''
          : t('add.addedFinishNote', { finish: FINISH_LABEL[effectiveFinish] })
      toast(
        'success',
        t('add.added', {
          quantity,
          name: printing.printed_name ?? printing.name,
          lang: printing.lang.toUpperCase(),
          note: finishNote,
          owned: result.owned
        })
      )
      // Reflect the new owned count without a second round trip for everything else.
      setPrintings((current) =>
        current?.map((p) =>
          p.scryfall_id === printing.scryfall_id ? { ...p, owned: result.owned } : p
        ) ?? null
      )
      invalidate()
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 space-y-3 px-5 py-4">
        <div className="max-w-xl">
          <div ref={searchBoxRef} className="field flex items-center gap-2 py-2">
            <Search size={15} className="shrink-0 text-ink-500" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setShowSuggestions(true)
              }}
              onFocus={() => setShowSuggestions(true)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && query.trim()) void lookup(query.trim())
                if (e.key === 'Escape') setShowSuggestions(false)
              }}
              placeholder={t('add.searchPlaceholder')}
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-ink-500"
            />
          </div>

          {/* Portalled for the same reason as the filter dropdowns: nothing
              inside the view can clip or out-paint it. Width follows the field. */}
          <Popover
            open={showSuggestions && suggestions.length > 0}
            onClose={() => setShowSuggestions(false)}
            trigger={searchBoxRef}
            width="trigger"
          >
            {suggestions.map((name) => (
              <button
                key={name}
                onClick={() => void lookup(name)}
                className="block w-full rounded px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-ink-750"
              >
                {name}
              </button>
            ))}
          </Popover>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-[11px] text-ink-400">
            {t('add.finish')}
            <Select
              className="w-28"
              value={finish}
              onChange={setFinish}
              options={FINISHES.map((f) => ({ value: f, label: FINISH_LABEL[f] }))}
            />
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-ink-400">
            {t('add.condition')}
            <Select
              className="w-24"
              value={condition}
              onChange={setCondition}
              options={CONDITIONS.map((c) => ({ value: c, label: c }))}
            />
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-ink-400">
            {t('add.quantity')}
            <QuantityStepper value={quantity} min={1} onChange={setQuantity} />
          </label>

          {printings !== null && (
            <div className="flex flex-col gap-1 pb-0 text-[11px] text-ink-400">
              {t('add.perRow')}
              <ColumnStepper grid="printings" />
            </div>
          )}

        </div>

        {truncatedTotal !== null && (
          <p className="text-[11px] leading-relaxed text-warn">
            {t('add.truncated', {
              total: count(truncatedTotal),
              shown: printings?.length ?? 0
            })}
          </p>
        )}

        {printings && printings.length > 0 && (
          <PrintingFilterBar
            printings={printings}
            filters={printingFilters}
            onChange={setPrintingFilters}
            onReset={resetPrintingFilters}
            shown={visible.length}
          />
        )}
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        {loading ? (
          <GalleryGrid grid="printings" items={Array.from({ length: 12 })}>
            {(_item, { index }) => (
              <div key={index} className="skeleton aspect-[488/680] rounded-xl" />
            )}
          </GalleryGrid>
        ) : printings === null ? (
          <EmptyState
            icon={<Search size={30} />}
            title={t('add.lookupTitle')}
            hint={t('add.lookupHint')}
          />
        ) : visible.length === 0 ? (
          <EmptyState
            title={t('add.allFilteredTitle')}
            hint={t.p('add.allFilteredHint', printings.length)}
          />
        ) : (
          <GalleryGrid grid="printings" items={visible} scrollRef={scrollRef}>
            {(printing, { index, density }) => (
              <motion.div
                key={printing.scryfall_id}
                layout
                initial={{ opacity: 0, y: 14, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={{
                  duration: 0.26,
                  delay: Math.min(index, 20) * 0.015,
                  ease: [0.25, 1, 0.5, 1]
                }}
              >
                <PrintingTile
                  printing={printing}
                  currency={currency}
                  finish={finish}
                  density={density}
                  added={justAdded === printing.scryfall_id}
                  onAdd={() => void add(printing)}
                />
              </motion.div>
            )}
          </GalleryGrid>
        )}
      </div>
    </div>
  )
}

function PrintingTile({
  printing,
  currency,
  finish,
  density,
  added,
  onAdd
}: {
  printing: PrintingChoice
  currency: 'usd' | 'eur'
  finish: Finish
  /**
   * Drives how much of the overlay fits. Taken whole rather than collapsed to a
   * boolean at the call site, so the narrowest tiles can be told from the merely
   * small ones — the foil tag's name has to give way before the tag itself does.
   */
  density: TileDensity
  added: boolean
  onAdd: () => void
}): React.ReactElement {
  const t = useT()
  const effective = effectiveFinishFor(printing, finish)
  const substituted = effective !== finish
  /*
    The printing's own price, else the English twin's, marked with a ≈.

    `priceOfPrinting` is the one definition of which column a finish reads and of the order
    the two sources are tried in; this tile used to re-implement the branch inline, and then
    drew an em dash for every French card because Scryfall prices almost none of them.
  */
  const { value: price, borrowed: priceBorrowed } = priceOfPrinting(printing, effective, currency)
  // Which kind of foil THIS PRINTING's foil version is — asked as 'foil' rather
  // than as the finish you happen to have selected, because the point of the tag
  // is telling the printings apart while browsing. Keyed off `effective` it would
  // vanish whenever Normal was selected, which is the default.
  const treatment = foilTreatmentOf(printing, 'foil')
  /*
    Two faces of one printing, which is Scryfall's own data -- a transform card, a
    double-faced token.
  */
  const sides = twoSides(printing)

  return (
    <button
      onClick={onAdd}
      title={
        substituted
          ? `${printing.printed_name ?? printing.name} comes in ${FINISH_LABEL[effective]} only — adds as ${FINISH_LABEL[effective]}`
          : t('add.addCard', { name: printing.printed_name ?? printing.name })
      }
      className={`group relative w-full overflow-hidden rounded-xl text-left ring-1 transition-all ${
        added ? 'ring-2 ring-good' : 'ring-ink-700 hover:ring-gold-500'
      }`}
    >
      {/*
        A two-faced printing stacks here for the same reason it does in the collection:
        a card with two sides looks like two cards everywhere else.
      */}
      <StackedArt
        scryfallId={printing.scryfall_id}
        size="normal"
        className="aspect-[488/680] w-full"
        alt={printing.name}
        backScryfallId={sides?.back.scryfallId ?? null}
        backFace={sides?.back.face}
      />

      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/92 via-black/72 to-transparent px-2 pb-2 pt-7">
        {density === 'full' && (
          <>
            <p className="truncate text-[11px] font-medium text-white">
              {bothSidesTitle(printing)}
            </p>
            <p className="truncate text-[10px] text-white/60">
              {printing.set_code.toUpperCase()} · #{printing.collector_number}
            </p>
          </>
        )}
        <div className={`flex items-center gap-1.5 ${density === 'full' ? 'mt-1.5' : ''}`}>
          <LangChip lang={printing.lang} />
          {substituted && (
            <span className="rounded bg-mana-u/25 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-mana-u">
              {t('add.finishOnly', { finish: FINISH_LABEL[effective] })}
            </span>
          )}
          {treatment && (
            <span
              title={t('add.foilIs', { treatment: foilTreatmentLabel(treatment) })}
              className="flex items-center gap-0.5 truncate rounded bg-gold-500/25 px-1.5 py-0.5
                text-[9px] font-semibold uppercase text-gold-200"
            >
              {/* The sparkle carries the meaning once the name no longer fits, so
                  a long product name like "Step-and-Compleat Foil" stops
                  squeezing this row on a narrow tile. */}
              <Sparkles size={8} className="shrink-0" />
              <span className="truncate">
                {foilLabelForDensity(foilTreatmentLabel(treatment), density)}
              </span>
            </span>
          )}
          {density === 'full' && <RarityPip rarity={printing.rarity} />}
          <span
            className="numeric ml-auto text-[10px] text-gold-300"
            title={priceBorrowed ? t('price.borrowed') : undefined}
          >
            {price === null ? '—' : priceBorrowed ? proxyMoney(price, currency) : money(price, currency)}
          </span>
        </div>
      </div>

      {printing.owned > 0 && (
        <span className="numeric absolute left-1.5 top-1.5 rounded bg-good px-1.5 py-0.5 text-[9px] font-bold text-ink-950">
          {t.p('add.owned', printing.owned)}
        </span>
      )}

      <AnimatePresence>
        {added && (
          <motion.div
            initial={{ opacity: 0, scale: 0.6 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 1.3 }}
            transition={{ type: 'spring', stiffness: 500, damping: 26 }}
            className="absolute inset-0 grid place-items-center bg-good/25 backdrop-blur-[1px]"
          >
            <span className="grid h-10 w-10 place-items-center rounded-full bg-good text-ink-950">
              <Check size={20} strokeWidth={3} />
            </span>
          </motion.div>
        )}
      </AnimatePresence>
    </button>
  )
}

// ---------- Fast entry ----------

interface QuickLogEntry {
  id: number
  ok: boolean
  text: string
  /**
   * The card that was added, for the thumbnail.
   *
   * Absent on a failure: there is no card to show, and the line is the message. Seeing
   * the picture is the point — it is the only way to notice that "c17 8" put Teferi's
   * Protection in your collection when you were holding a Cat Warrior.
   */
  scryfallId?: string
}

function QuickTab({ active }: { active: boolean }): React.ReactElement {
  const t = useT()
  const invalidate = useApp((s) => s.invalidate)
  const toast = useApp((s) => s.toast)
  const [setCode, setSetCode] = useState('')
  const [number, setNumber] = useState('')
  const [lang, setLang] = useState('en')
  const [quantity, setQuantity] = useState(1)
  /*
    Whether the set, the language and the quantity survive an add.

    On by default, because the case this screen exists for is a pile from one set: you
    set those once and then type numbers. Off, every field clears, which is right when
    you are working through a box of mixed singles.
  */
  const [keepFields, setKeepFields] = useState(true)
  const [finish, setFinish] = useState<Finish>('nonfoil')
  const [condition, setCondition] = useState<Condition>('NM')
  const [busy, setBusy] = useState(false)
  const [log, setLog] = useState<QuickLogEntry[]>([])
  /** The number field: where the focus belongs between cards. */
  const inputRef = useRef<HTMLInputElement>(null)
  const logId = useRef(0)

  useEffect(() => {
    if (active) inputRef.current?.focus()
  }, [active])

  const submit = async (): Promise<void> => {
    const set = setCode.trim().toLowerCase()
    // The number still carries the printed fraction, which is the whole reason the
    // number is a text field and not a spinner.
    const { collectorNumber, sheetTotal } = parseCollectorNumber(number.trim())
    if (!set || !collectorNumber) {
      toast('warn', t('add.badFormat'))
      return
    }
    setBusy(true)
    try {
      const result = await window.api.cards.quickAdd({
        set,
        collectorNumber,
        lang: lang.toLowerCase(),
        finish,
        condition,
        quantity: Math.max(1, quantity),
        sheetTotal
      })
      const printing = result.printing
      setLog((current) => [
        {
          id: ++logId.current,
          ok: true,
          /*
            The set is named because it is not always the one that was typed: "c17
            008/011" lands on TC17, and a line that only echoed the number would hide
            the one thing worth checking. Tokens are marked for the same reason -- it
            is the confirmation that the sheet, not the card at that number, was added.
          */
          scryfallId: printing.scryfall_id,
          text:
            `${Math.max(1, quantity)}× ${printing.printed_name ?? printing.name}` +
            ` · ${printing.lang.toUpperCase()}` +
            ` · ${printing.set_code.toUpperCase()} #${printing.collector_number}` +
            (printing.layout.includes('token') ? ' · token' : '')
        },
        ...current.slice(0, 40)
      ])
      /*
        Only the number, unless you asked for more. The set and the language are the
        two things a pile has in common, so clearing them after every card is what made
        this screen slower than it needed to be.
      */
      setNumber('')
      if (!keepFields) {
        setSetCode('')
        setLang('en')
        setQuantity(1)
      }
      inputRef.current?.focus()
      invalidate()
    } catch (err) {
      setLog((current) => [
        {
          id: ++logId.current,
          ok: false,
          text: `${setCode.trim().toUpperCase()} ${number.trim()} — ${(err as Error).message}`
        },
        ...current.slice(0, 40)
      ])
    } finally {
      setBusy(false)
      inputRef.current?.focus()
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col px-5 py-4">
      <div className="max-w-2xl space-y-3">
        <p className="text-xs leading-relaxed text-ink-400">{t('add.quickIntro')}</p>

        <div className="flex flex-wrap items-end gap-3">
          {/*
            Enter submits from any field, so the whole form is usable without the mouse:
            set once, then number-Enter-number-Enter down the pile.
          */}
          <label className="flex w-24 flex-col gap-1 text-[11px] text-ink-400">
            {t('add.setCode')}
            <input
              data-field="set"
              value={setCode}
              onChange={(e) => setSetCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !busy) void submit()
              }}
              placeholder="m10"
              spellCheck={false}
              className="field font-mono text-sm uppercase outline-none placeholder:text-ink-600"
            />
          </label>
          <label className="flex w-28 flex-col gap-1 text-[11px] text-ink-400">
            {t('add.number')}
            <input
              data-field="number"
              ref={inputRef}
              value={number}
              onChange={(e) => setNumber(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !busy) void submit()
              }}
              placeholder="008/011"
              spellCheck={false}
              className="field font-mono text-sm outline-none placeholder:text-ink-600"
            />
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-ink-400">
            {t('add.language')}
            <Select
              className="w-32"
              value={lang}
              onChange={setLang}
              options={LANGUAGES.map((code) => ({ value: code, label: languageName(code) }))}
            />
          </label>
          <label className="flex w-20 flex-col gap-1 text-[11px] text-ink-400">
            {t('add.quantity')}
            <input
              data-field="qty"
              type="number"
              min={1}
              value={quantity}
              onChange={(e) => setQuantity(Math.max(1, Number(e.target.value) || 1))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !busy) void submit()
              }}
              className="field numeric text-sm outline-none"
            />
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-ink-400">
            {t('add.finish')}
            <Select
              className="w-28"
              value={finish}
              onChange={setFinish}
              options={FINISHES.map((f) => ({ value: f, label: FINISH_LABEL[f] }))}
            />
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-ink-400">
            {t('add.condition')}
            <Select
              className="w-24"
              value={condition}
              onChange={setCondition}
              options={CONDITIONS.map((c) => ({ value: c, label: c }))}
            />
          </label>
          <Button variant="primary" onClick={() => void submit()} disabled={busy}>
            {busy ? t('add.adding') : t('add.add')}
          </Button>
        </div>

        <label
          className="flex items-center gap-2 text-xs text-ink-300"
          title={t('add.keepFieldsHint')}
        >
          <input
            type="checkbox"
            checked={keepFields}
            onChange={(e) => setKeepFields(e.target.checked)}
            data-action="keepFields"
            className="accent-gold-500"
          />
          {t('add.keepFields')}
        </label>
      </div>

      {log.length > 0 && (
        <div className="mt-4 flex max-w-2xl items-center justify-end">
          <Button
            size="sm"
            variant="subtle"
            icon={<Trash2 size={13} />}
            onClick={() => setLog([])}
            data-action="clearLog"
            title={t('add.clearLogHint')}
          >
            {t('add.clearLog')}
          </Button>
        </div>
      )}

      <div className="mt-3 min-h-0 flex-1 overflow-y-auto">
        {log.length === 0 ? (
          <EmptyState
            icon={<Zap size={28} />}
            title={t('add.logEmptyTitle')}
            hint={t('add.logEmptyHint')}
          />
        ) : (
          <ul className="max-w-2xl space-y-1">
            <AnimatePresence initial={false}>
              {log.map((entry) => (
                <motion.li
                  key={entry.id}
                  layout
                  initial={{ opacity: 0, x: -12 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.18 }}
                  className={`flex items-center gap-2.5 rounded-lg border px-3 py-1.5 text-xs ${
                    entry.ok
                      ? 'border-good/25 bg-good/[0.07] text-ink-200'
                      : 'border-bad/30 bg-bad/[0.07] text-bad'
                  }`}
                >
                  {entry.scryfallId && (
                    <CardImage
                      scryfallId={entry.scryfallId}
                      className="h-8 w-6 shrink-0 rounded"
                      alt=""
                    />
                  )}
                  <span className="min-w-0">{entry.text}</span>
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        )}
      </div>
    </div>
  )
}
