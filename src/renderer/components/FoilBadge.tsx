import { Sparkles } from 'lucide-react'
import { foilTreatmentLabel, type Finish, type TileDensity } from '@shared/types'
import { FINISH_LABEL, foilLabelForDensity } from '../lib/format'
import { useT } from '../hooks/useT'

/**
 * The foil marker drawn over a card image in a grid.
 *
 * Lives in one place because three grids need the identical answer — the
 * collection gallery, the deck grid and the pick-list grid — and a foil card
 * that reads "Surge Foil" on one screen and nothing on another is the same class
 * of bug the language override had.
 *
 * It scales with the tile rather than disappearing. At `minimal` the tile drops
 * its title and footer entirely (see `CardTile`), so a badge over the image is
 * the *only* place this information can live — which is exactly when it matters,
 * because a 90px thumbnail is otherwise indistinguishable from its nonfoil twin.
 * The name is dropped before the icon is: the sparkle still says "this one is
 * foil", and the tooltip carries the full name at every size.
 *
 * Nonfoil renders nothing at all. A marker meaning "ordinary" on most of a
 * collection would be noise, and the absence already carries it.
 */
export default function FoilBadge({
  finish,
  treatment,
  forced,
  density
}: {
  finish: Finish
  /** The kind of foil, e.g. `surgefoil`. Null for an ordinary foil. */
  treatment: string | null
  /** True when the value is one you set rather than one read off the printing. */
  forced?: boolean
  density: TileDensity
}): React.ReactElement | null {
  const t = useT()
  if (finish === 'nonfoil') return null

  const full = treatment ? foilTreatmentLabel(treatment) : FINISH_LABEL[finish]
  const title = forced ? `${full} — ${t('coll.youSetThis')}` : full

  // A gold chip over artwork, so it reads against both dark and light cards.
  const chip =
    'flex items-center gap-0.5 rounded bg-gold-500 px-1 py-0.5 text-[9px] font-bold uppercase text-ink-950'

  if (density === 'minimal') {
    return (
      <span title={title} className={chip} aria-label={title} data-foil-badge="">
        <Sparkles size={9} />
        {forced && <span aria-hidden>★</span>}
      </span>
    )
  }

  const shown = foilLabelForDensity(full, density)

  return (
    <span title={title} className={`${chip} max-w-full`} data-foil-badge="">
      <Sparkles size={9} className="shrink-0" />
      <span className="truncate">{shown}</span>
      {forced && <span aria-hidden>★</span>}
    </span>
  )
}
