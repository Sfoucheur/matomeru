import { motion } from 'motion/react'
import { useCallback, useEffect, useRef, useState } from 'react'
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
  /*
    The printing the pointer is over in the list below, drawn in the frame instead of this
    card's own artwork.

    Deliberately separate from `face` and `settled`: a preview is a still picture of another
    printing, so there is nothing to rotate, and leaving the list returns the card to
    whichever side you had turned it to rather than resetting it.
  */
  const [preview, setPreview] = useState<string | null>(null)
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** What is on screen, readable without making the hover callback depend on it. */
  const showing = useRef<string | null>(null)

  /*
    Patient in both directions, but not equally.

    The rows are 4px apart, and each one clears the preview as the pointer leaves it. With
    the show delayed and the clear immediate, crossing a gap read as leaving on purpose:
    running the cursor down the list flashed the card's own art between every pair. So the
    clear waits too -- longer than crossing a gap takes, short enough that leaving the list
    still puts the card back while you are still looking at it.

    The switch from one row to the next, on the other hand, is immediate. The delay exists
    to stop twenty printings strobing the frame on the way past, and that is about the
    first appearance; once a preview is up, waiting again only adds the stutter it was
    meant to prevent. A ref mirrors the state so this stays one stable callback rather than
    a new one per hover, which would re-render the whole list underneath the pointer.
  */
  const hoverPrinting = useCallback((scryfallId: string | null) => {
    if (previewTimer.current) clearTimeout(previewTimer.current)
    const show = (next: string | null): void => {
      showing.current = next
      setPreview(next)
    }
    if (scryfallId === null) {
      previewTimer.current = setTimeout(() => show(null), 140)
      return
    }
    if (showing.current !== null) return show(scryfallId)
    previewTimer.current = setTimeout(() => show(scryfallId), 180)
  }, [])

  // A dialog closing mid-hover must not fire a state update into nothing.
  useEffect(
    () => () => {
      if (previewTimer.current) clearTimeout(previewTimer.current)
    },
    []
  )

  /*
    Turning back to the front belongs to changing the card, not to refreshing it.

    This used to sit in the fetch below, which re-runs on every `dataVersion` bump --
    so bumping a quantity while looking at the back of a card silently turned it over.
  */
  useEffect(() => {
    setFace(0)
    setSettled(0)
    /*
      And the preview goes with it. A different card is showing, so a preview of the last
      one's printing has nothing to do with what is on screen — and now that the clear
      waits, it would otherwise outlive the card it belonged to.
    */
    showing.current = null
    setPreview(null)
  }, [scryfallId])

  /** The card whose data is on screen, so a refetch can tell itself from a first load. */
  const loadedFor = useRef<string | null>(null)

  useEffect(() => {
    /*
      The skeleton is for a first load, not a refetch.

      This raised `loading` unconditionally, which swapped the whole body for the
      skeleton every time anything invalidated -- and editing a quantity here
      invalidates by design, to keep the screens behind the dialog honest. The
      scrolling column was unmounted and remounted, and the scroll position went with
      it: you nudged a quantity and the dialog jumped back to the top.

      A refresh of the card already on screen now replaces the data underneath a
      mounted body, and only a card with nothing on screen yet gets the skeleton.
    */
    if (loadedFor.current !== scryfallId) setLoading(true)
    Promise.all([
      window.api.cards.printing(scryfallId),
      window.api.collection.locations(scryfallId)
    ])
      .then(([p, l]) => {
        setPrinting(p)
        setLocations(l)
        loadedFor.current = scryfallId
      })
      .catch(() => {
        setPrinting(null)
        setLocations(null)
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
    second one the rules text changed before the picture had started moving.
  */
  const nameFaces = printing?.printed_name?.split(' // ') ?? printing?.name.split(' // ') ?? []
  /*
    The two sides, from the one helper every card tile already uses, so the dialog and the
    grid can never disagree about what the back of a card is.
  */
  const sides = printing ? twoSides(printing) : null
  const faces = sides ? [sides.front.title, sides.back.title] : nameFaces
  const isTwoFaced = faces.length > 1

  const turned = isTwoFaced && face % 2 === 1

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
      /*
        As tall as the card needs, and no taller than the window can show.

        This was a fixed 92vh for every card, which left a short card sitting in a lot of
        empty space. It grows with its content now and stops at the window -- and it still
        cannot move while you are using it: turning a card over never changes the height,
        because both faces' text occupies one grid cell and the taller of the two sets it.
      */
      width="max-w-[110rem]"
      maxHeight="max-h-[92vh]"
    >
      {loading ? (
        <div className="grid gap-5 p-5 sm:grid-cols-[minmax(14rem,24rem)_1fr]">
          <div className="skeleton aspect-[488/680] rounded-xl" />
          <div className="space-y-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="skeleton h-6 rounded" />
            ))}
          </div>
        </div>
      ) : (
        <div className="grid gap-5 p-5 sm:grid-cols-[auto_1fr]">
          {/*
            The artwork scales to the row rather than setting it.

            A card image is tall, so a column sized by its own width would make every
            dialog nearly window-height whatever the card -- which is the empty space this
            change is undoing. `min-h-0` plus a height-bounded image lets the details
            column decide the row, and the picture fits itself into it, between a floor
            that keeps it recognisable and a ceiling that stops it dominating a wordy card.
          */}
          {/*
            The column states its own width.

            It was `w-auto` between a min and a max, which worked while the picture was in
            flow and wanted width. The picture is absolutely positioned now, so nothing in
            here asks for any -- the column collapsed to its 14rem floor and the artwork
            came out smaller than before the dialog ever grew. Stated in rem with a viewport
            cap so the card scales with the window without ever crowding the words.
          */}
          <div className="flex min-h-0 w-[min(24rem,60vw)] flex-col gap-2.5
            sm:h-full sm:w-[32rem] sm:max-w-[30vw]">
            {/* The artwork is the obvious thing to want a closer look at, so it
                is the control: click for a full-size view, which also offers the
                copy. */}
            {/*
              The picture takes the room that is left, and asks for none of its own.

              This is the whole trick behind a dialog that follows its content. The button
              is absolutely positioned, so this box contributes nothing to the grid row --
              the details column alone decides how tall the dialog is, and the artwork then
              fills whatever that turned out to be. Sized directly below `sm:`, where the
              columns stack and there is no row to fill.

              An earlier attempt used `h-full` on the image instead, which resolves to
              `auto` against an indefinite height: every card came out at the 92vh ceiling
              because the picture's intrinsic 936px was setting the row.
            */}
            <div className="relative h-[26rem] min-h-0 sm:h-auto sm:flex-1">
              <button
                onClick={() => setZoomed(true)}
                title={t('zoom.open')}
                /* The framed element, so a check can measure the shape it draws. */
                data-card-frame=""
                /*
                  Card-shaped, not box-shaped.

                  This was `inset-0`, which filled the whole box -- the column's width by
                  whatever height the details column came out as -- so the ring and the
                  rounded corners wrapped a tall rectangle with the picture letterboxed
                  inside it. `object-contain` keeps the *picture's* proportions and says
                  nothing about the frame around it.

                  Still absolute, and that is load-bearing rather than incidental: out of
                  flow is what stops the artwork contributing height, which is the whole
                  mechanism behind a dialog that follows its content.

                  The height comes from the width, not the other way round. Deriving the
                  width from `h-full` does not work: an explicit height wins against
                  `aspect-ratio`, so as soon as `max-w-full` clamped the width the ratio
                  was simply violated -- measured at 224x716, a ratio of 0.313 against the
                  0.718 a card is. The column is the binding constraint in this layout
                  anyway (capped at 24rem against a row of 500-800px), so `w-full` plus the
                  ratio is the honest way round, with `max-h-full` as the guard for a row
                  short enough to bind instead.
                */
                className="group absolute left-0 top-0 block aspect-[488/680] w-full
                  max-h-full cursor-zoom-in overflow-hidden rounded-xl ring-1 ring-ink-700
                  transition-all hover:ring-gold-500"
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
              {preview ? (
                /*
                  A printing from the list, at the size the frame already is. No flip stage:
                  this is a still of another card, and the turn state belongs to this one.
                */
                <CardImage
                  scryfallId={preview}
                  size="large"
                  className="h-full w-full object-contain"
                  alt={t('printing.preview')}
                  data-card-preview=""
                />
              ) : sides ? (
                <div className="h-full [perspective:1400px]" data-flip="stage">
                  <motion.div
                    className="relative h-full [transform-style:preserve-3d]"
                    animate={{ rotateY: turned ? 180 : 0 }}
                    transition={{ type: 'spring', stiffness: 260, damping: 26 }}
                    onUpdate={(latest: { rotateY?: number | string }) => {
                      const angle = Number(latest.rotateY ?? 0)
                      // Past edge-on, the far side is the one being read.
                      const half = angle > 90 ? 1 : 0
                      setSettled((current) => (current % 2 === half ? current : current + 1))
                    }}
                    data-flip="card"
                    /*
                      The intent, on the element, so a probe can tell "it was asked to turn
                      and did not" from "it was never asked" -- which is the difference this
                      cost an hour to work out by inference.
                    */
                    data-turned={String(turned)}
                    data-face={face}
                    data-faces={faces.length}
                  >
                    <div className="h-full [backface-visibility:hidden]" data-flip-face="front">
                      <CardImage
                        scryfallId={sides.front.scryfallId}
                        size="large"
                        face={sides.front.face}
                        className="h-full w-full object-contain"
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
                        className="h-full w-full object-contain"
                        alt={sides.back.title}
                      />
                    </div>
                  </motion.div>
                </div>
              ) : (
                <CardImage
                  scryfallId={scryfallId}
                  size="large"
                  className="h-full w-full object-contain"
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
            </div>
            {isTwoFaced && (
              <button
                data-action="flipCard"
                onClick={() => setFace((f) => (f + 1) % faces.length)}
                className="flex w-full items-center justify-center gap-1.5 rounded-lg border
                  border-ink-700 py-1.5 text-xs text-ink-300 transition-colors
                  hover:border-ink-500 hover:bg-ink-800"
              >
                <RefreshCw size={12} />
                {faces[(face + 1) % faces.length]}
              </button>
            )}
            {printing && (
              <a
                href={`https://scryfall.com/card/${printing.set_code}/${printing.collector_number}/${printing.lang}`}
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
            The column that sets the height.

            It used to own a scroll inside a fixed-height dialog. The dialog grows with its
            content now, so this simply is as tall as it is and the body scrolls only once
            the whole thing reaches the window's ceiling.
          */}
          <div className="min-w-0 space-y-4">
            {/*
              The side on screen, so the rules text and the set follow the flip -- and
              they fade across rather than cutting, because the card beside them is
              turning over rather than cutting. `settled` is what advances as the
              rotation passes edge-on, so the swap lands with the far side arriving.

              Keyed on the face, which is what makes AnimatePresence treat the two sides
              as different children rather than one child with new text.
            */}
            {printing &&
              (isTwoFaced ? (
                /*
                  Both faces in one grid cell, one of them faded out.

                  Not a swap. The dialog is as tall as its content now, so mounting only
                  the side being read would make the height follow the text -- and turning
                  a card over would move the dialog under the pointer, which is the
                  complaint this whole flip started from. One cell takes the height of the
                  taller side and keeps it, whichever way the card is facing.
                */
                <div className="grid">
                  {[0, 1].map((side) => (
                    <motion.div
                      key={side}
                      className="[grid-area:1/1]"
                      animate={{ opacity: settled % 2 === side ? 1 : 0 }}
                      transition={{ duration: 0.16 }}
                      aria-hidden={settled % 2 !== side}
                      style={{ pointerEvents: settled % 2 === side ? 'auto' : 'none' }}
                    >
                      <Identity printing={printing} face={side} />
                    </motion.div>
                  ))}
                </div>
              ) : (
                <Identity printing={printing} face={0} />
              ))}
            {context && printing && (
              <PrintingPicker
                name={printing.name}
                currentScryfallId={scryfallId}
                currency={currency}
                context={context}
                forcedLang={context.forcedLang}
                onChanged={reload}
                onPreview={hoverPrinting}
              />
            )}
            {printing && <PriceTable printing={printing} />}
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
        scryfallId={scryfallId}
        title={title}
        open={zoomed}
        onClose={() => setZoomed(false)}
        /* The side on screen, so a closer look is a closer look at what you turned to. */
        face={(settled % 2) as 0 | 1}
        hasBack={sides !== null}
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
