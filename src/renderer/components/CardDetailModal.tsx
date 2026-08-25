import { motion } from 'motion/react'
import { useEffect, useState } from 'react'
import {
  ExternalLink,
  Layers,
  ListChecks,
  MapPin,
  Package,
  RefreshCw,
  Trash2,
  ZoomIn
} from 'lucide-react'
import { foilTreatmentLabel, foilTreatmentOf, twoSides } from '@shared/types'
import type { CardLocations, Printing } from '@shared/types'
import { guard, useApp } from '../store/app'
import {
  CardImage,
  ColorPips,
  LangChip,
  Modal,
  QuantityStepper,
  RarityPip
} from './primitives'
import { FINISH_LABEL, languageName, rarityName } from '../lib/format'
import { useT } from '../hooks/useT'
import FinishPicker from './FinishPicker'
import CardZoom from './CardZoom'
import PrintingPicker from './PrintingPicker'
import WhereToGetIt from './WhereToGetIt'

/**
 * Everything known about one card, in one place.
 *
 * This absorbed the old side panel, so it carries both the reference detail
 * (large image, set, language, printed rules text, prices) and the "where is it"
 * answer — loose copies, pick-list reservations, and decks. Deck matches keep the
 * exact/other-printing distinction, which matters physically: an oracle-only
 * match means the copy in that deck is a different printing than yours.
 */
export default function CardDetailModal({ scryfallId }: { scryfallId: string }): React.ReactElement {
  const t = useT()
  const close = useApp((s) => s.openCard)
  const setView = useApp((s) => s.setView)
  const setFilters = useApp((s) => s.setFilters)
  const dataVersion = useApp((s) => s.dataVersion)
  const invalidate = useApp((s) => s.invalidate)
  const context = useApp((s) => s.detailContext)
  const settings = useApp((s) => s.settings)
  const currency = settings?.currency ?? 'usd'

  const [printing, setPrinting] = useState<Printing | null>(null)
  /*
    The other side, when this card has a different token on each face.

    Its own printing rather than a second image on this one: Scryfall files a
    Commander 2017 Cat Warrior and the Rat on its back as two unrelated cards, so
    "the back" here is simply another printing -- which makes flipping easier, not
    harder. Null for every ordinary card.
  */
  const [paired, setPaired] = useState<Printing | null>(null)
  const [locations, setLocations] = useState<CardLocations | null>(null)
  const [loading, setLoading] = useState(true)
  const [face, setFace] = useState(0)
  /**
   * The side the words are showing, which trails `face` until the card is edge-on.
   *
   * Driven from the rotation rather than from a timer, so it stays right when the spring
   * is retuned -- and when reduce-motion resolves the animation instantly, this lands on
   * the final value straight away.
   */
  const [settled, setSettled] = useState(0)
  const [zoomed, setZoomed] = useState(false)

  useEffect(() => {
    setLoading(true)
    setFace(0)
    setSettled(0)
    Promise.all([
      window.api.cards.printing(scryfallId),
      window.api.collection.locations(scryfallId),
      window.api.cards.paired(scryfallId)
    ])
      .then(([p, l, other]) => {
        setPrinting(p)
        setLocations(l)
        setPaired(other)
      })
      .catch(() => {
        setPrinting(null)
        setLocations(null)
        setPaired(null)
      })
      .finally(() => setLoading(false))
  }, [scryfallId, dataVersion])

  // Editing a quantity here has to refresh the screens behind the modal too, so
  // the collection list and the deck totals do not go stale under it.
  const reload = (nextScryfallId?: string): void => {
    invalidate()
    if (nextScryfallId && nextScryfallId !== scryfallId) close(nextScryfallId, context)
  }

  const title = printing
    ? (printing.printed_name ?? printing.name)
    : (locations?.printed_name ?? locations?.name ?? t('detail.card'))

  /*
    Which side is showing, and how far the card has turned.

    `turned` is the intent -- someone pressed the control -- and `settled` is what the
    words beside the card follow, updated as the rotation passes edge-on. Without the
    second one the rules text changed before the picture had moved.
  */
  const nameFaces = printing?.printed_name?.split(' // ') ?? printing?.name.split(' // ') ?? []
  /*
    Two kinds of two-sidedness, and they need different handling.

    A transform card is one printing with two pictures, so its faces come out of its
    own name and the flip moves an index. A paired token is *two printings*, so its
    faces are the two cards' names and the flip swaps which printing is on screen --
    picture, rules text, set and number together, because all of that genuinely
    belongs to the other card.
  */
  /*
    The two sides, from the one helper every card tile already uses, so the dialog and the
    grid can never disagree about what the back of a card is. It answers for both kinds:
    one printing with two faces, and two printings that share a physical card.
  */
  const sides = printing ? twoSides(printing, paired) : null
  const faces = sides ? [sides.front.title, sides.back.title] : nameFaces
  const isTwoFaced = faces.length > 1

  const turned = isTwoFaced && face % 2 === 1
  const showingBack = isTwoFaced && settled % 2 === 1
  // A split or adventure card has two names and one picture: the control still turns its
  // words over, and `sides` is null, so there is nothing to rotate.
  const flipped = showingBack && paired !== null
  const shown = flipped ? paired : printing
  const shownId = flipped && paired ? paired.scryfall_id : scryfallId

  return (
    /*
      One size for every card. The dialog used to be as tall as its contents, so turning a
      card over -- which swaps the rules text -- moved the dialog under the pointer, and
      every card opened at a different size.
    */
    <Modal
      open
      onClose={() => close(null)}
      title={title}
      width="max-w-4xl"
      height="h-[min(85vh,36rem)]"
      scrollBody={false}
    >
      {loading ? (
        <div className="grid gap-5 p-5 sm:grid-cols-[16rem_1fr]">
          <div className="skeleton aspect-[488/680] rounded-xl" />
          <div className="space-y-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="skeleton h-6 rounded" />
            ))}
          </div>
        </div>
      ) : (
        <div className="grid gap-5 p-5 sm:h-full sm:grid-cols-[16rem_1fr]">
          <div className="space-y-2.5">
            {/* The artwork is the obvious thing to want a closer look at, so it
                is the control: click for a full-size view, which also offers the
                copy. */}
            <button
              onClick={() => setZoomed(true)}
              title={t('zoom.open')}
              className="group relative block w-full cursor-zoom-in overflow-hidden rounded-xl
                ring-1 ring-ink-700 transition-all hover:ring-gold-500"
            >
              {/*
                The card turns over rather than cutting between two pictures.

                Both faces are drawn at once inside a 3D container, each hiding its own
                back, so the far side becomes visible exactly as the rotation passes
                edge-on. `preserve-3d` must not sit on an element with `overflow` other
                than visible -- that flattens the whole thing -- which is why the rounding
                and clipping stay on the button outside this wrapper.

                Reduce-motion needs nothing here: App wraps the tree in a MotionConfig
                that stills the rotation, so the card simply appears turned.
              */}
              {sides ? (
                <div className="[perspective:1400px]" data-flip="stage">
                  <motion.div
                    className="relative [transform-style:preserve-3d]"
                    animate={{ rotateY: turned ? 180 : 0 }}
                    transition={{ type: 'spring', stiffness: 260, damping: 26 }}
                    onUpdate={(latest: { rotateY?: number | string }) => {
                      const angle = Number(latest.rotateY ?? 0)
                      // Past edge-on, the far side is the one being read.
                      const half = angle > 90 ? 1 : 0
                      setSettled((current) => (current % 2 === half ? current : current + 1))
                    }}
                    data-flip="card"
                  >
                    <div className="[backface-visibility:hidden]" data-flip-face="front">
                      <CardImage
                        scryfallId={sides.front.scryfallId}
                        size="large"
                        face={sides.front.face}
                        className="aspect-[488/680] w-full"
                        alt={sides.front.title}
                      />
                    </div>
                    <div
                      className="absolute inset-0 [backface-visibility:hidden]
                        [transform:rotateY(180deg)]"
                      data-flip-face="back"
                    >
                      <CardImage
                        scryfallId={sides.back.scryfallId}
                        size="large"
                        face={sides.back.face}
                        className="aspect-[488/680] w-full"
                        alt={sides.back.title}
                      />
                    </div>
                  </motion.div>
                </div>
              ) : (
                <CardImage
                  scryfallId={shownId}
                  size="large"
                  className="aspect-[488/680] w-full"
                  alt={title}
                />
              )}
              <span
                className="absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-lg
                  bg-black/60 text-white opacity-0 transition-opacity group-hover:opacity-100"
              >
                <ZoomIn size={14} />
              </span>
            </button>
            {isTwoFaced && (
              <button
                onClick={() => setFace((f) => (f + 1) % faces.length)}
                className="flex w-full items-center justify-center gap-1.5 rounded-lg border
                  border-ink-700 py-1.5 text-xs text-ink-300 transition-colors
                  hover:border-ink-500 hover:bg-ink-800"
              >
                <RefreshCw size={12} />
                {faces[(face + 1) % faces.length]}
              </button>
            )}
            {shown && (
              <a
                href={`https://scryfall.com/card/${shown.set_code}/${shown.collector_number}/${shown.lang}`}
                target="_blank"
                rel="noreferrer"
                className="flex items-center justify-center gap-1.5 text-[11px] text-ink-500
                  underline-offset-2 transition-colors hover:text-gold-400 hover:underline"
              >
                <ExternalLink size={11} />
                {t('detail.viewOnScryfall')}
              </a>
            )}
          </div>

          {/*
            The column that scrolls, so the artwork stays put while a wordy card is read.
            Only from `sm:`, where there are two columns at all: below that the two stack
            past the fixed height and the body keeps its own scroll instead.
          */}
          <div className="min-w-0 space-y-4 sm:min-h-0 sm:overflow-y-auto sm:pr-1">
            {/* The side on screen, so the rules text and the set follow the flip. */}
            {shown && <Identity printing={shown} face={flipped ? 0 : face} />}
            {context && printing && (
              <PrintingPicker
                name={printing.name}
                currentScryfallId={scryfallId}
                currency={currency}
                context={context}
                forcedLang={context.forcedLang}
                onChanged={reload}
              />
            )}
            {shown && <PriceTable printing={shown} />}
            {printing && (
              <WhereToGetIt
                scryfallId={scryfallId}
                setCode={printing.set_code}
                setName={printing.set_name}
              />
            )}
            {locations && printing && (
              <Locations
                locations={locations}
                printing={printing}
                currency={currency}
                onChanged={reload}
                onGoPicks={() => {
                  close(null)
                  setView('picks')
                }}
                onGoDeck={(deckId) => {
                  close(null)
                  setFilters({ deckScope: deckId })
                  setView('decks')
                }}
              />
            )}
            {!printing && !locations && (
              <p className="text-xs text-ink-400">{t('detail.notCached')}</p>
            )}
          </div>
        </div>
      )}
      <CardZoom
        scryfallId={shownId}
        title={title}
        open={zoomed}
        onClose={() => setZoomed(false)}
      />
    </Modal>
  )
}

function Identity({ printing, face }: { printing: Printing; face: number }): React.ReactElement {
  const t = useT()
  const hasLocalizedName = !!printing.printed_name && printing.printed_name !== printing.name
  // Printed text is the localized rules text; fall back to the English oracle
  // text, which is all Scryfall has for English printings.
  const rules = printing.printed_text ?? printing.oracle_text
  const rulesFaces = rules?.split(/\n\/\/\n/) ?? []
  const shownRules = rulesFaces.length > 1 ? rulesFaces[face] ?? rulesFaces[0] : rules

  return (
    <section className="space-y-2.5">
      <div>
        <h3 className="text-base font-semibold leading-tight text-ink-50">
          {printing.printed_name ?? printing.name}
        </h3>
        {hasLocalizedName && (
          <p className="text-xs text-ink-500">{printing.name}</p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-ink-300">
        <LangChip lang={printing.lang} />
        <span className="text-ink-400">{languageName(printing.lang)}</span>
        <RarityPip rarity={printing.rarity} />
        <span className="text-ink-400">{rarityName(printing.rarity)}</span>
        <ColorPips colors={printing.color_identity} />
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <Row label={t('detail.set')}>
          {printing.set_name}{' '}
          <span className="uppercase text-ink-500">({printing.set_code})</span>
        </Row>
        <Row label={t('detail.number')}>#{printing.collector_number}</Row>
        {printing.mana_cost && <Row label={t('detail.cost')}>{printing.mana_cost}</Row>}
        <Row label={t('detail.type')}>{printing.printed_type_line ?? printing.type_line ?? '—'}</Row>
        <Row label={t('detail.released')}>{printing.released_at ?? '—'}</Row>
        <Row label={t('detail.finishes')}>
          {printing.finishes.map((f) => FINISH_LABEL[f] ?? f).join(', ')}
        </Row>
        {/* Which kind of foil the foil version of this printing is. Only the foil
            one: a surge-foil card is sold nonfoil too, and that copy is ordinary. */}
        {foilTreatmentOf(printing, 'foil') && (
          <Row label={t('detail.foilType')}>
            <span className="text-gold-300">
              {foilTreatmentLabel(foilTreatmentOf(printing, 'foil')!)}
            </span>
          </Row>
        )}
      </dl>

      {shownRules && (
        <p className="whitespace-pre-line rounded-lg border border-ink-800 bg-ink-900 px-3 py-2
          text-xs leading-relaxed text-ink-200">
          {shownRules}
        </p>
      )}
    </section>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <>
      <dt className="text-ink-500">{label}</dt>
      <dd className="min-w-0 truncate text-ink-200">{children}</dd>
    </>
  )
}

/**
 * The full price grid. Non-English printings frequently have no prices at all,
 * so every cell must be able to read `—` rather than implying zero.
 */
function PriceTable({ printing }: { printing: Printing }): React.ReactElement {
  const t = useT()
  const prices = printing.prices
  const cell = (raw: string | null | undefined): string =>
    raw === null || raw === undefined ? '—' : Number(raw).toFixed(2)

  return (
    <section>
      <h4 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-500">
        {t('detail.prices')}
      </h4>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-[10px] uppercase tracking-wider text-ink-600">
            <th className="w-14 text-left font-normal" />
            <th className="text-right font-normal">{t('detail.normal')}</th>
            <th className="text-right font-normal">{t('detail.foil')}</th>
            <th className="text-right font-normal">{t('detail.etched')}</th>
          </tr>
        </thead>
        <tbody className="numeric">
          <tr>
            <td className="text-ink-500">USD</td>
            <td className="text-right text-ink-200">{cell(prices?.usd)}</td>
            <td className="text-right text-ink-200">{cell(prices?.usd_foil)}</td>
            <td className="text-right text-ink-200">{cell(prices?.usd_etched)}</td>
          </tr>
          <tr>
            <td className="text-ink-500">EUR</td>
            <td className="text-right text-ink-200">{cell(prices?.eur)}</td>
            <td className="text-right text-ink-200">{cell(prices?.eur_foil)}</td>
            {/* Scryfall publishes no separate etched price in EUR. */}
            <td className="text-right text-ink-600">{t('detail.na')}</td>
          </tr>
        </tbody>
      </table>
    </section>
  )
}

function Locations({
  locations,
  printing,
  currency,
  onChanged,
  onGoPicks,
  onGoDeck
}: {
  locations: CardLocations
  /** Needed for the finishes and promo tags the finish picker reads. */
  printing: Printing
  currency: 'usd' | 'eur'
  onChanged: () => void
  onGoPicks: () => void
  onGoDeck: (deckId: number) => void
}): React.ReactElement {
  const t = useT()
  const totalLoose = locations.loose.reduce((sum, e) => sum + e.quantity, 0)
  const totalReserved = locations.loose.reduce((sum, e) => sum + e.reserved, 0)

  return (
    <div className="space-y-3.5">
      <h4 className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-500">
        <MapPin size={10} /> {t('detail.whereItIs')}
      </h4>

      <Section
        icon={<Package size={12} />}
        title={t('detail.inCollection')}
        badge={
          totalReserved
            ? t('detail.totalHeldReserved', { total: totalLoose, held: totalReserved })
            : t('detail.totalHeld', { total: totalLoose })
        }
      >
        {locations.loose.length === 0 ? (
          <Empty>{t('detail.dontOwnPrinting')}</Empty>
        ) : (
          locations.loose.map((entry) => (
            <Line key={entry.collection_item_id}>
              <span className="flex min-w-0 flex-1 items-center gap-1 text-ink-200">
                <FinishPicker
                  printing={printing}
                  finish={entry.finish}
                  treatment={entry.foil_treatment}
                  onApply={(finish, treatment) => {
                    void guard(async () => {
                      await window.api.collection.update(entry.collection_item_id, {
                        finish,
                        foil_treatment: treatment
                      })
                      onChanged()
                    })
                  }}
                />
                <span className="shrink-0 text-ink-400">· {entry.condition}</span>
              </span>
              {entry.reserved > 0 && (
                <span className="numeric rounded bg-warn/15 px-1.5 py-0.5 text-[10px] text-warn">
                  {t('detail.heldBadge', { count: entry.reserved })}
                </span>
              )}
              {/*
                Editable here, not just in the collection table: in gallery mode
                there is no row to edit, and dropping to zero is the only way to
                remove a copy without deleting every copy you own.
              */}
              <QuantityStepper
                value={entry.quantity}
                min={Math.max(0, entry.reserved)}
                size="sm"
                onChange={(quantity) => {
                  void guard(async () => {
                    if (quantity === 0) await window.api.collection.remove(entry.collection_item_id)
                    else
                      await window.api.collection.setQuantity(entry.collection_item_id, quantity)
                    onChanged()
                  })
                }}
              />
              <button
                onClick={() => {
                  void guard(async () => {
                    await window.api.collection.remove(entry.collection_item_id)
                    onChanged()
                  })
                }}
                title={
                  entry.reserved > 0
                    ? t('detail.reservedTooltip')
                    : t('detail.removeRow')
                }
                disabled={entry.reserved > 0}
                className="rounded p-1 text-ink-500 transition-colors hover:bg-bad/15 hover:text-bad disabled:opacity-30"
              >
                <Trash2 size={12} />
              </button>
            </Line>
          ))
        )}
      </Section>

      <Section icon={<ListChecks size={12} />} title={t('detail.stagedIn')}>
        {locations.reservations.length === 0 ? (
          <Empty>{t('detail.notStaged')}</Empty>
        ) : (
          locations.reservations.map((entry) => (
            <Line key={entry.pick_list_id}>
              <button
                onClick={onGoPicks}
                className="flex-1 truncate text-left text-ink-200 underline-offset-2 hover:underline"
              >
                {entry.pick_list_name}
              </button>
              <span className="numeric text-warn">{entry.quantity}</span>
            </Line>
          ))
        )}
      </Section>

      <Section
        icon={<Layers size={12} />}
        title={t('detail.inDecks')}
        badge={locations.decks.length ? String(locations.decks.length) : undefined}
      >
        {locations.decks.length === 0 ? (
          <Empty>{t('detail.noDecks')}</Empty>
        ) : (
          locations.decks.map((deck) => (
            <Line key={deck.deck_id}>
              <button
                onClick={() => onGoDeck(deck.deck_id)}
                className="min-w-0 flex-1 truncate text-left text-ink-200 underline-offset-2 hover:underline"
              >
                {deck.deck_name}
              </button>
              <span
                title={
                  deck.match === 'exact' ? t('detail.matchExact') : t('detail.matchOracle')
                }
                className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${
                  deck.match === 'exact' ? 'bg-good/15 text-good' : 'bg-mana-u/15 text-mana-u'
                }`}
              >
                {deck.match === 'exact' ? t('detail.exact') : t('detail.otherPrinting')}
              </span>
              {/*
                Archidekt reports only foil/not, and a deck sync rebuilds its
                rows — so this is the one place a sleeved card's real finish can
                be recorded. Needs the oracle id, which is what the override is
                keyed on.
              */}
              {locations.oracle_id && (
                <FinishPicker
                  printing={printing}
                  finish={deck.finish}
                  treatment={deck.foil_treatment}
                  forced={!!deck.finish_forced}
                  onApply={(finish, treatment) => {
                    void guard(async () => {
                      await window.api.decks.setCardFinish(
                        deck.deck_id,
                        [locations.oracle_id!],
                        finish,
                        treatment
                      )
                      onChanged()
                    })
                  }}
                />
              )}
              <span className="numeric shrink-0 text-ink-300">×{deck.quantity}</span>
            </Line>
          ))
        )}
      </Section>

      {locations.decks.some((d) => d.match === 'oracle') && (
        <p className="rounded-lg border border-mana-u/25 bg-mana-u/[0.07] px-3 py-2 text-[11px] leading-relaxed text-ink-300">
          {t('detail.oracleNote1')}{' '}
          <span className="text-mana-u">{t('detail.otherPrinting')}</span>{' '}
          {t('detail.oracleNote2')}
        </p>
      )}

      <p className="text-[10px] text-ink-600">
        {t('detail.excludedNote', { currency: currency === 'eur' ? 'EUR' : 'USD' })}
      </p>
    </div>
  )
}

function Section({
  icon,
  title,
  badge,
  children
}: {
  icon: React.ReactNode
  title: string
  badge?: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <section>
      <h5 className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-500">
        {icon}
        {title}
        {badge && <span className="ml-auto font-normal normal-case text-ink-600">{badge}</span>}
      </h5>
      <div className="space-y-1">{children}</div>
    </section>
  )
}

function Line({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-ink-800 bg-ink-900 px-2.5 py-1.5 text-xs">
      {children}
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }): React.ReactElement {
  return <p className="px-2.5 py-1 text-[11px] text-ink-600">{children}</p>
}
