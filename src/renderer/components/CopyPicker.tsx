import { useEffect, useState } from 'react'
import type { CardLocations } from '@shared/types'
import { FINISH_LABEL } from '../lib/format'
import { foilTreatmentLabel } from '@shared/types'
import { useT } from '../hooks/useT'
import { LangChip } from './primitives'

/** One owned copy, as `cardLocations` reports it. */
export type OwnedCopy = CardLocations['loose'][number]

/**
 * Which of your copies of a card an action means.
 *
 * Two screens ask this question and they have to answer it the same way: staging a
 * card into a pick list, and changing the copy an already-staged row takes. Both are
 * "you own this card several times over — say which one", and both can only ever offer
 * copies you actually hold. Naming a printing you do not own would turn a pull list
 * into a shopping list, which is a different feature with different rules.
 *
 * It reads `collection.locations`, which is oracle-scoped, so the list spans every
 * printing of the card — the French one beside the English one, the foil beside the
 * plain. That is the whole point: those are exactly the copies that are otherwise
 * impossible to tell apart from one another.
 */
export default function CopyPicker({
  scryfallId,
  selected,
  onChoose,
  /**
   * Copies needed, so a row that cannot supply them reads as unavailable rather than
   * being offered and then refused by the main process.
   */
  needed = 1,
  /** A pick item being repointed, whose own reservation should not count against it. */
  exclude
}: {
  scryfallId: string
  selected: number | null
  onChoose: (copy: OwnedCopy) => void
  needed?: number
  exclude?: { collectionItemId: number | null; quantity: number }
}): React.ReactElement {
  const t = useT()
  const [copies, setCopies] = useState<OwnedCopy[] | null>(null)

  useEffect(() => {
    let live = true
    void window.api.collection
      .locations(scryfallId)
      .then((locations) => {
        if (live) setCopies(locations?.loose ?? [])
      })
      .catch(() => {
        if (live) setCopies([])
      })
    return () => {
      live = false
    }
  }, [scryfallId])

  if (copies === null) {
    return (
      <div className="space-y-1.5">
        {Array.from({ length: 2 }).map((_, index) => (
          <div key={index} className="skeleton h-9 rounded-lg" />
        ))}
      </div>
    )
  }

  if (copies.length === 0) {
    return <p className="text-[11px] leading-relaxed text-ink-500">{t('copies.none')}</p>
  }

  /*
    What a row can still supply. The reservation this very action is making does not
    count against it: repointing an item onto the row it already holds, or back onto one
    it is releasing, would otherwise report nothing free and offer no way out.
  */
  const freeOn = (copy: OwnedCopy): number => {
    const mine = exclude?.collectionItemId === copy.collection_item_id ? exclude.quantity : 0
    return copy.quantity - copy.reserved + mine
  }

  return (
    <div className="flex flex-col gap-1.5" role="radiogroup">
      {copies.map((copy) => {
        const free = freeOn(copy)
        const short = free < needed
        const treatment =
          copy.finish === 'nonfoil' ? null : copy.foil_treatment
        return (
          <label
            key={copy.collection_item_id}
            data-copy={copy.collection_item_id}
            className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 transition-colors ${
              short && copy.collection_item_id !== selected
                ? 'cursor-not-allowed border-ink-750 opacity-50'
                : 'cursor-pointer'
            } ${
              copy.collection_item_id === selected
                ? 'border-gold-500 bg-ink-750'
                : 'border-ink-700 hover:border-ink-600 hover:bg-ink-800'
            }`}
          >
            <input
              type="radio"
              name="owned-copy"
              checked={copy.collection_item_id === selected}
              disabled={short && copy.collection_item_id !== selected}
              onChange={() => onChoose(copy)}
              className="shrink-0 accent-gold-500"
            />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className="numeric shrink-0 text-[10px] uppercase text-ink-400">
                  {copy.set_code} · #{copy.collector_number}
                </span>
                <LangChip lang={copy.lang} />
                {/* Says plainly when a row is not the printing you were looking at,
                    which is the only thing distinguishing two otherwise identical
                    lines on this list. */}
                {!copy.same_printing && (
                  <span className="shrink-0 text-[10px] text-ink-500">
                    {t('copies.otherPrinting')}
                  </span>
                )}
              </span>
              <span className="mt-0.5 block truncate text-[11px] text-ink-300">
                {treatment ? foilTreatmentLabel(treatment) : FINISH_LABEL[copy.finish]} ·{' '}
                {copy.condition}
              </span>
            </span>
            <span className="numeric shrink-0 text-[10px] text-ink-500">
              {free > 0 ? t.p('copies.free', free) : t('copies.allReserved')}
            </span>
          </label>
        )
      })}
    </div>
  )
}
