import { memo } from 'react'
import { Check } from 'lucide-react'
import type { TileDensity } from '@shared/types'
import { StackedArt } from './primitives'
import { useT } from '../hooks/useT'

export interface CardTileProps {
  scryfallId: string | null
  /** Localized title when there is one, so the tile reads like the card looks. */
  title: string
  density: TileDensity
  /** Top-right corner markers: deck counts, reservations, "don't own". */
  badges?: React.ReactNode
  /** Bottom overlay line beneath the title — quantity, value, owned state. */
  footer?: React.ReactNode
  /*
    The other side, as three primitives rather than one object.

    Deliberately not `back: {...}`: this component is memoized and a freshly-built object
    each render would defeat that as surely as inline JSX does, which the note below
    already warns about. A grid of a few hundred tiles is where that costs something.
  */
  backScryfallId?: string | null
  backFace?: 0 | 1
  /** Ring colour override, e.g. owned/missing state on the Decks page. */
  ringClass?: string
  selected?: boolean
  selectable?: boolean
  /**
   * Set to explain why this card cannot be selected. The checkbox still shows,
   * dimmed and inert, so the reason is discoverable instead of the card silently
   * ignoring a click.
   */
  disabledReason?: string
  /** Plain click: open the card. Ctrl/Shift are handled before this fires. */
  onOpen?: () => void
  onSelect?: (mode: 'toggle' | 'range') => void
}

/**
 * One card in a grid.
 *
 * Plain click opens the card's detail view; selection is a hover checkbox plus
 * Ctrl-click to toggle and Shift-click for a range, which is how image grids
 * generally behave and keeps the primary gesture on the thing you look at most.
 *
 * Memoized, and deliberately animation-free: the mount stagger it used to have
 * was keyed on grid position, which under virtualization changes on every scroll
 * tick — so the "polish" replayed as a waterfall of fades while scrolling. Any
 * caller passing freshly-built `badges`/`footer` JSX defeats the memo, so those
 * are built inside memoized per-card components instead.
 */
function CardTileImpl({
  scryfallId,
  title,
  density,
  badges,
  footer,
  backScryfallId,
  backFace,
  ringClass,
  selected = false,
  selectable = true,
  disabledReason,
  onOpen,
  onSelect
}: CardTileProps): React.ReactElement {
  const t = useT()
  const showText = density !== 'minimal'
  const pickable = selectable && !disabledReason

  const handleClick = (e: React.MouseEvent): void => {
    if (pickable && (e.ctrlKey || e.metaKey)) {
      onSelect?.('toggle')
      return
    }
    if (pickable && e.shiftKey) {
      onSelect?.('range')
      return
    }
    onOpen?.()
  }

  return (
    <div className="group relative">
      <button
        onClick={handleClick}
        title={title}
        className={`relative block w-full overflow-hidden rounded-xl text-left ring-2 transition-all ${
          selected ? 'ring-gold-500' : (ringClass ?? 'ring-transparent hover:ring-ink-600')
        }`}
      >
        <StackedArt
          scryfallId={scryfallId}
          size={density === 'minimal' ? 'small' : 'normal'}
          className="aspect-[488/680] w-full"
          alt={title}
          backScryfallId={backScryfallId}
          backFace={backFace}
        />

        {showText && (
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/92 via-black/70 to-transparent px-2 pb-1.5 pt-6">
            <p className="truncate text-[11px] font-medium text-white">{title}</p>
            {footer && <div className="mt-1 flex items-center gap-1.5">{footer}</div>}
          </div>
        )}

        {badges && (
          <div className="absolute right-1.5 top-1.5 flex flex-wrap justify-end gap-1">{badges}</div>
        )}
      </button>

      {/* Outside the button so clicking the checkbox never opens the card. */}
      {selectable && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            if (!pickable) return
            onSelect?.(e.shiftKey ? 'range' : 'toggle')
          }}
          disabled={!pickable}
          title={disabledReason}
          aria-label={
            disabledReason ??
            (selected ? t('common.deselect', { name: title }) : t('common.select', { name: title }))
          }
          className={`absolute left-1.5 top-1.5 grid h-5 w-5 place-items-center rounded border
            transition-opacity ${
              disabledReason
                ? 'cursor-not-allowed border-white/25 bg-black/40 text-transparent opacity-0 group-hover:opacity-60'
                : selected
                  ? 'border-gold-500 bg-gold-500 text-ink-950 opacity-100'
                  : 'border-white/70 bg-black/50 text-transparent opacity-0 group-hover:opacity-100 group-hover:text-white/80'
            }`}
        >
          <Check size={12} strokeWidth={3} />
        </button>
      )}
    </div>
  )
}

const CardTile = memo(CardTileImpl)
export default CardTile
