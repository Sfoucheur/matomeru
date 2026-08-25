import { motion, AnimatePresence } from 'motion/react'
import { Check, ChevronDown, Minus, Plus, X } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import Popover from './Popover'
import { useT } from '../hooks/useT'
import { RARITY_COLOR, rarityLabel } from '../lib/format'

// ---------- Button ----------

type ButtonVariant = 'primary' | 'ghost' | 'outline' | 'danger' | 'subtle'

const BUTTON_STYLES: Record<ButtonVariant, string> = {
  primary: 'bg-gold-500 text-ink-950 hover:bg-gold-400 font-medium',
  ghost: 'text-ink-300 hover:text-ink-100 hover:bg-ink-800',
  outline: 'border border-ink-600 text-ink-200 hover:border-ink-500 hover:bg-ink-800',
  danger: 'bg-bad/15 text-bad border border-bad/40 hover:bg-bad/25',
  subtle: 'bg-ink-800 text-ink-200 hover:bg-ink-750 border border-ink-700'
}

export function Button({
  variant = 'subtle',
  size = 'md',
  icon,
  children,
  className = '',
  ref,
  ...props
}: {
  variant?: ButtonVariant
  size?: 'sm' | 'md'
  icon?: ReactNode
  children?: ReactNode
  /**
   * Declared explicitly because `ButtonHTMLAttributes` does not carry it. React
   * 19 passes `ref` to a function component like any other prop, so no
   * `forwardRef` is needed — and a `Popover` trigger has to be able to point at
   * this element.
   */
  ref?: React.Ref<HTMLButtonElement>
} & React.ButtonHTMLAttributes<HTMLButtonElement>): React.ReactElement {
  const sizing = size === 'sm' ? 'px-2.5 py-1 text-xs gap-1.5' : 'px-3.5 py-1.5 text-sm gap-2'
  return (
    <button
      {...props}
      ref={ref}
      className={`inline-flex items-center justify-center rounded-lg transition-colors duration-150
        disabled:opacity-40 disabled:pointer-events-none ${sizing} ${BUTTON_STYLES[variant]} ${className}`}
    >
      {icon}
      {children}
    </button>
  )
}

// ---------- Badges and pips ----------

export function RarityPip({ rarity }: { rarity: string | null }): React.ReactElement {
  return (
    <span
      title={rarity ?? 'unknown'}
      className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full
        border border-current text-[10px] font-bold ${RARITY_COLOR[rarity ?? ''] ?? 'text-ink-400'}`}
    >
      {rarityLabel(rarity)}
    </span>
  )
}

/**
 * The language chip. Non-English is deliberately given the accent colour —
 * when sorting bulk, language is the thing you are scanning for.
 */
export function LangChip({ lang }: { lang: string }): React.ReactElement {
  const isEnglish = lang === 'en'
  return (
    <span
      className={`inline-flex min-w-9 justify-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
        isEnglish ? 'bg-ink-750 text-ink-400' : 'bg-gold-500/15 text-gold-300 ring-1 ring-gold-500/30'
      }`}
    >
      {lang}
    </span>
  )
}

const MANA_COLORS: Record<string, string> = {
  W: 'bg-mana-w',
  U: 'bg-mana-u',
  B: 'bg-mana-b',
  R: 'bg-mana-r',
  G: 'bg-mana-g',
  C: 'bg-mana-c'
}

export function ColorPips({ colors }: { colors: string[] }): React.ReactElement {
  const shown = colors.length ? colors : ['C']
  return (
    <span className="inline-flex gap-0.5">
      {shown.map((color) => (
        <span
          key={color}
          title={color}
          className={`h-2.5 w-2.5 rounded-full ring-1 ring-black/30 ${MANA_COLORS[color] ?? 'bg-mana-c'}`}
        />
      ))}
    </span>
  )
}

export function Chip({
  children,
  onRemove,
  tone = 'default'
}: {
  children: ReactNode
  onRemove?: () => void
  tone?: 'default' | 'accent'
}): React.ReactElement {
  const t = useT()
  return (
    <motion.span
      layout
      initial={{ opacity: 0, scale: 0.85 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.85 }}
      transition={{ type: 'spring', stiffness: 520, damping: 34 }}
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs ${
        tone === 'accent'
          ? 'bg-gold-500/15 text-gold-300 ring-1 ring-gold-500/30'
          : 'bg-ink-750 text-ink-200 ring-1 ring-ink-600'
      }`}
    >
      {children}
      {onRemove && (
        <button
          onClick={onRemove}
          className="ml-0.5 rounded-full p-0.5 transition-colors hover:bg-white/10"
          aria-label={t('common.removeFilter')}
        >
          <X size={11} />
        </button>
      )}
    </motion.span>
  )
}

// ---------- Quantity stepper ----------

export function QuantityStepper({
  value,
  min = 0,
  max,
  onChange,
  size = 'md'
}: {
  value: number
  min?: number
  max?: number
  onChange: (value: number) => void
  size?: 'sm' | 'md'
}): React.ReactElement {
  const t = useT()
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])

  const clamp = (next: number): number => {
    const bounded = Math.max(min, max === undefined ? next : Math.min(max, next))
    return Number.isFinite(bounded) ? bounded : min
  }

  const commit = (): void => {
    const parsed = Number.parseInt(draft, 10)
    const next = clamp(Number.isNaN(parsed) ? value : parsed)
    setDraft(String(next))
    if (next !== value) onChange(next)
  }

  const btn = size === 'sm' ? 'h-6 w-6' : 'h-7 w-7'
  const input = size === 'sm' ? 'w-8 text-xs' : 'w-10 text-sm'

  return (
    <div className="inline-flex items-center overflow-hidden rounded-lg border border-ink-700 bg-ink-800">
      <button
        data-step="down"
        onClick={() => onChange(clamp(value - 1))}
        disabled={value <= min}
        className={`${btn} grid place-items-center text-ink-400 transition-colors hover:bg-ink-750
          hover:text-ink-100 disabled:opacity-30`}
        aria-label={t('common.decrease')}
      >
        <Minus size={12} />
      </button>
      <input
        data-step="value"
        value={draft}
        onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, ''))}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
        }}
        className={`${input} numeric border-x border-ink-700 bg-transparent py-1 text-center outline-none`}
        aria-label={t('common.quantity')}
      />
      <button
        data-step="up"
        onClick={() => onChange(clamp(value + 1))}
        disabled={max !== undefined && value >= max}
        className={`${btn} grid place-items-center text-ink-400 transition-colors hover:bg-ink-750
          hover:text-ink-100 disabled:opacity-30`}
        aria-label={t('common.increase')}
      >
        <Plus size={12} />
      </button>
    </div>
  )
}

// ---------- Select ----------

export function Select<T extends string>({
  value,
  onChange,
  options,
  placeholder,
  className = ''
}: {
  value: T
  onChange: (value: T) => void
  options: { value: T; label: string }[]
  placeholder?: string
  className?: string
}): React.ReactElement {
  return (
    <div className={`relative ${className}`}>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="field w-full appearance-none pr-7 text-sm outline-none"
      >
        {placeholder && <option value="">{placeholder}</option>}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown
        size={13}
        className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-400"
      />
    </div>
  )
}

// ---------- Multi-select dropdown ----------

/**
 * A filter dropdown with a checkbox list, searchable once the list is long.
 *
 * The search appears above ~8 options: a Set filter can run to hundreds of
 * entries, where clicking through the list is hopeless, while a five-item rarity
 * filter is faster to click than to type. The input sits outside the scrolling
 * area — hence `scroll={false}` on the Popover — so it stays put while the list
 * moves under it.
 *
 * Selected options are always listed, whatever the query. Filtering one out of
 * view would leave no way to untick it, and the count badge would then disagree
 * with everything visible.
 */
const SEARCH_THRESHOLD = 8

export function MultiSelect({
  label,
  options,
  selected,
  onChange,
  formatLabel
}: {
  label: string
  options: {
    value: string
    label?: string
    count?: number
    /** Drawn before the label — a set symbol, for instance. */
    icon?: React.ReactNode
  }[]
  selected: string[]
  onChange: (values: string[]) => void
  formatLabel?: (value: string) => string
}): React.ReactElement {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const triggerRef = useRef<HTMLButtonElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const toggle = (value: string): void => {
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value])
  }

  const searchable = options.length > SEARCH_THRESHOLD
  const textOf = (option: { value: string; label?: string }): string =>
    option.label ?? formatLabel?.(option.value) ?? option.value

  const needle = query.trim().toLowerCase()
  const shown = needle
    ? options.filter(
        (o) =>
          selected.includes(o.value) ||
          textOf(o).toLowerCase().includes(needle) ||
          // The value itself matters for sets: you know "LCI", not its full name.
          o.value.toLowerCase().includes(needle)
      )
    : options

  // A stale query would silently hide options the next time the list is opened.
  const close = (): void => {
    setOpen(false)
    setQuery('')
  }

  return (
    <>
      <button
        ref={triggerRef}
        onClick={() => (open ? close() : setOpen(true))}
        className={`field flex items-center gap-1.5 text-sm whitespace-nowrap ${
          selected.length ? 'border-gold-500/50 text-gold-300' : 'text-ink-300'
        }`}
      >
        {label}
        {selected.length > 0 && (
          <span className="numeric rounded bg-gold-500/20 px-1 text-[10px]">{selected.length}</span>
        )}
        <ChevronDown size={13} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {/* Portalled: an absolutely-positioned panel here would be trapped by the
          filter bar's backdrop-blur stacking context and clipped by the
          collapsible panel's overflow-hidden. */}
      <Popover
        open={open}
        onClose={close}
        trigger={triggerRef}
        width={224}
        scroll={!searchable}
        className={searchable ? 'flex max-h-72 flex-col' : ''}
      >
        {searchable && (
          <div className="shrink-0 px-1 pb-1">
            <input
              ref={searchRef}
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('common.search')}
              className="field w-full py-1 text-xs"
            />
          </div>
        )}

        <div className={searchable ? 'min-h-0 flex-1 overflow-y-auto' : ''}>
          {options.length === 0 && (
            <p className="px-2 py-3 text-center text-xs text-ink-400">{t('filters.nothingYet')}</p>
          )}
          {options.length > 0 && shown.length === 0 && (
            <p className="px-2 py-3 text-center text-xs text-ink-400">
              {t('filters.noMatch', { query: query.trim() })}
            </p>
          )}
          {shown.map((option) => {
            const isSelected = selected.includes(option.value)
            return (
              <button
                key={option.value}
                onClick={() => toggle(option.value)}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm
                  transition-colors hover:bg-ink-750"
              >
                <span
                  className={`grid h-4 w-4 shrink-0 place-items-center rounded border ${
                    isSelected ? 'border-gold-500 bg-gold-500 text-ink-950' : 'border-ink-600'
                  }`}
                >
                  {isSelected && <Check size={11} strokeWidth={3} />}
                </span>
                {option.icon}
                <span className="flex-1 truncate">{textOf(option)}</span>
                {option.count !== undefined && (
                  <span className="numeric text-xs text-ink-400">{option.count}</span>
                )}
              </button>
            )
          })}
        </div>

        {selected.length > 0 && (
          <button
            onClick={() => onChange([])}
            className="mt-1 w-full shrink-0 rounded px-2 py-1.5 text-left text-xs text-ink-400
              transition-colors hover:bg-ink-750 hover:text-ink-200"
          >
            {t('common.clearSelection')}
          </button>
        )}
      </Popover>
    </>
  )
}

// ---------- Modal ----------

export function Modal({
  open,
  onClose,
  title,
  children,
  width = 'max-w-2xl',
  height,
  maxHeight,
  scrollBody = true
}: {
  open: boolean
  onClose: () => void
  title: ReactNode
  children: ReactNode
  width?: string
  /**
   * A height class, for a dialog that should not resize with its content.
   *
   * Left off, the dialog is as tall as what is in it, capped at 85vh -- which is right
   * for a form or a confirmation. The card detail wants the opposite: the same size for
   * every card, so that turning a card over or opening a wordier one does not move the
   * dialog under the pointer.
   */
  height?: string
  /**
   * A different ceiling, for a dialog that grows with its content but not past a point.
   *
   * `height` says "exactly this tall whatever is in you"; this says "as tall as you need,
   * up to here". A caller wants one or the other, never both.
   */
  maxHeight?: string
  /**
   * Whether the body scrolls. Set false when a fixed-height dialog has a column that
   * should own the scrolling instead, so the two do not fight over one gesture.
   */
  scrollBody?: boolean
}): React.ReactElement {
  const t = useT()
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          onClick={onClose}
          className="fixed inset-0 z-50 grid place-items-center bg-black/65 p-6 backdrop-blur-sm"
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.94, y: 14 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.94, y: 14 }}
            transition={{ type: 'spring', stiffness: 420, damping: 32 }}
            onClick={(e) => e.stopPropagation()}
            // Marks the subtree as a modal, which is how Popover knows it has to
            // sit above the overlay rather than below it.
            role="dialog"
            aria-modal="true"
            /*
              The cap yields to an explicit height.

              A caller that states a height has already answered the question the cap
              exists to answer, and two answers is how the stated one gets lost: the card
              dialog asked for 88vh and was drawn at 85 for weeks, because `max-h` wins
              against `h` and nothing said so out loud.
            */
            className={`panel-floating flex w-full flex-col overflow-hidden shadow-2xl
              shadow-black/60 ${height ? '' : (maxHeight ?? 'max-h-[85vh]')} ${width}
              ${height ?? ''}`}
          >
            <header className="flex shrink-0 items-center justify-between border-b border-ink-700 px-5 py-3.5">
              <h2 className="text-sm font-semibold text-ink-100">{title}</h2>
              <button
                onClick={onClose}
                className="rounded p-1 text-ink-400 transition-colors hover:bg-ink-800 hover:text-ink-100"
                aria-label={t('common.close')}
              >
                <X size={16} />
              </button>
            </header>
            <div
              className={`min-h-0 flex-1 ${
                scrollBody ? 'overflow-y-auto' : 'overflow-y-auto sm:overflow-hidden'
              }`}
            >
              {children}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

// ---------- Empty state ----------

export function EmptyState({
  icon,
  title,
  hint,
  action
}: {
  icon?: ReactNode
  title: string
  hint?: ReactNode
  action?: ReactNode
}): React.ReactElement {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      className="grid place-items-center px-6 py-16 text-center"
    >
      <div className="max-w-sm">
        {icon && <div className="mb-3 flex justify-center text-ink-600">{icon}</div>}
        <p className="text-sm font-medium text-ink-200">{title}</p>
        {hint && <p className="mt-1.5 text-xs leading-relaxed text-ink-400">{hint}</p>}
        {action && <div className="mt-4 flex justify-center">{action}</div>}
      </div>
    </motion.div>
  )
}

// ---------- Card image ----------

/**
 * Card art, served from the local cache over the matomeru:// protocol. A missing
 * or not-yet-downloaded image resolves to a 404, so the placeholder stays.
 */
/**
 * A card with two sides, drawn as the two cards it is.
 *
 * Two kinds of card end up here and the component does not distinguish them: one
 * printing with two faces (a transform card asks for `face=1` of the same id) and two
 * printings that share one physical card (a Commander token with a Cat Warrior on the
 * front and a Rat on the back). `twoSides` in the shared types answers which is which;
 * everything below just draws a front and a back.
 *
 * Nothing here turns the card over. It used to swap on hover, and that came out: the
 * detail dialog flips the card properly, so a grid that reacted to the pointer passing
 * across it was movement for its own sake. The tile says "this card has two sides" and
 * leaves the turning to the place that does it well.
 *
 * Both cards are drawn at 88% and pushed into opposite corners so the pair fits the
 * tile's own box. A grid cannot overflow into its neighbours, so the stack has to live
 * inside the footprint rather than spill out of it.
 *
 * With no back, this renders exactly the `CardImage` it used to, which is what keeps
 * every ordinary card unchanged.
 */
export function StackedArt({
  scryfallId,
  size = 'small',
  className = '',
  alt,
  backScryfallId,
  backFace = 0
}: {
  scryfallId: string | null
  size?: 'small' | 'normal' | 'large'
  className?: string
  alt: string
  /** The other side. Null or absent for a card with one. */
  backScryfallId?: string | null
  /** Which face of that printing: 1 for a transform card, 0 for a paired one. */
  backFace?: 0 | 1
}): React.ReactElement {
  if (!backScryfallId) {
    return <CardImage scryfallId={scryfallId} size={size} className={className} alt={alt} />
  }

  return (
    /*
      `isolate` is load-bearing. The tile paints its name, footer and badges as later
      siblings of this block with no z-index of their own, so the z-10 and z-20 below used
      to compete with them -- and win, hiding the card's own information behind its
      artwork. A stacking context of our own confines those numbers to ordering the two
      cards against each other.
    */
    <div data-stack="pair" className={`relative isolate ${className}`}>
      {/*
        Each side inside a wrapper this component owns, and the positioning on that wrapper
        rather than on the card.

        Handing `absolute` to `CardImage` does not work, and fails silently: its own wrapper
        hardcodes `relative`, both classes land on one element with equal specificity, and
        Tailwind emits `.relative` *after* `.absolute` -- so the later rule wins however the
        classes are ordered in the attribute. The cards then laid out in normal flow, one
        below the other, and `aspect-ratio` yields to content, so the tile grew to twice the
        height of its neighbours and shoved the row beneath it aside.

        Back first in the DOM, and the front carries the z-index, so the order is explicit
        rather than a consequence of source order.
      */}
      <div
        data-side="back"
        /*
          The flip is hung on this card, not on the tile, so it happens only where the
          back actually shows.

          That follows from what `:hover` means: it matches the topmost element under the
          pointer and its *ancestors*, and these two cards are siblings. Over the overlap
          the front is on top, so the back is not hovered and nothing moves; over the
          sliver the back is the topmost element, so it lifts.

          It settles rather than flickers. Once the back is forward it covers the overlap,
          so the pointer stays over it; the front keeps its own bottom-right sliver, so
          moving onto that hovers the front and the back drops back. Hover a sliver, that
          card comes forward.
        */
        className="absolute left-0 top-0 w-[88%]"
      >
        <CardImage
          scryfallId={backScryfallId}
          size={size}
          face={backFace}
          alt={alt}
          className="aspect-[488/680] w-full rounded-lg ring-1 ring-black/50 shadow-md"
        />
      </div>
      <div
        data-side="front"
        className="absolute bottom-0 right-0 z-10 w-[88%]"
      >
        <CardImage
          scryfallId={scryfallId}
          size={size}
          alt={alt}
          className="aspect-[488/680] w-full rounded-lg ring-1 ring-black/50 shadow-md"
        />
      </div>
    </div>
  )
}

export function CardImage({
  scryfallId,
  size = 'small',
  face = 0,
  className = '',
  alt
}: {
  scryfallId: string | null
  /** `large` is worth the bytes in the detail view, wasteful in a grid tile. */
  size?: 'small' | 'normal' | 'large'
  /** The back of a double-faced card. Falls back to the front if there is none. */
  face?: 0 | 1
  className?: string
  alt: string
}): React.ReactElement {
  const [failed, setFailed] = useState(false)
  const [loaded, setLoaded] = useState(false)

  if (!scryfallId || failed) {
    return (
      <div
        className={`grid place-items-center rounded bg-ink-800 text-[9px] text-ink-500 ${className}`}
      >
        MTG
      </div>
    )
  }

  return (
    <div className={`relative overflow-hidden rounded bg-ink-800 ${className}`}>
      {!loaded && <div className="skeleton absolute inset-0" />}
      {/*
        A plain img with a CSS fade, not a motion.img: this renders once per row
        and per tile, so it was the second most numerous JS-animated element on
        screen. CSS also means the reduce-motion rule in index.css reaches it.
      */}
      <img
        /*
          Keyed by face so React swaps the element instead of mutating its src:
          without it the skeleton never replays on a flip, and a front that failed
          to load would leave `failed` set and hide a perfectly good back.
        */
        key={face}
        src={window.api.imageUrl(scryfallId, size, face)}
        alt={alt}
        loading="lazy"
        decoding="async"
        onLoad={() => setLoaded(true)}
        onError={() => setFailed(true)}
        className={`h-full w-full object-cover transition-opacity duration-200 ${
          loaded ? 'opacity-100' : 'opacity-0'
        }`}
      />
    </div>
  )
}
