import type { ProgressEvent } from '@shared/types'
import { nowIso } from '../db/connection.js'
import { pricedPrintingIds, updatePrices } from '../db/repos/printings.js'
import { setSetting } from '../db/repos/settings.js'
import { cardsByIds } from '../scryfall/client.js'
import { toPrinting } from '../scryfall/mappers.js'
import { fillEnglishPricesQuietly } from './priceFill.js'

export type ProgressSink = (event: ProgressEvent) => void

export interface PriceSyncResult {
  requested: number
  updated: number
  /** Printings Scryfall has no price for at all — common for non-English cards. */
  unpriced: number
  syncedAt: string
}

/**
 * Refreshes prices for every printing anybody is looking at.
 *
 * Batching by Scryfall `id` is deliberate: an id names one specific language
 * printing, so the Japanese and French versions of a card keep their own prices.
 * Identifying by set + collector number would collapse them all to English.
 *
 * "Anybody is looking at" was "in the collection" until a report of French deck cards with
 * no price: a printing that exists only because a synced deck names it was invisible here,
 * so it kept whatever prices its first fetch carried — for a French card, none — forever.
 * See `pricedPrintingIds`.
 */
export async function refreshPrices(onProgress: ProgressSink): Promise<PriceSyncResult> {
  const ids = pricedPrintingIds()
  onProgress({ job: 'price-sync', phase: 'Refreshing prices', done: 0, total: ids.length })

  let updated = 0
  let unpriced = 0
  const unpricedIds: string[] = []
  const BATCH = 75

  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH)
    const cards = await cardsByIds(batch)
    for (const card of cards) {
      const printing = toPrinting(card)
      if (!printing.prices) {
        unpriced += 1
        continue
      }
      const hasAnyPrice = Object.values(printing.prices).some((v) => v !== null)
      if (!hasAnyPrice) {
        unpriced += 1
        // Worth a second question rather than a shrug: Scryfall prices this card in English
        // and nowhere else, so the English twin is what the row will borrow from.
        unpricedIds.push(printing.scryfall_id)
      }
      updatePrices(printing.scryfall_id, printing.prices)
      updated += 1
    }
    onProgress({
      job: 'price-sync',
      phase: 'Refreshing prices',
      done: Math.min(i + BATCH, ids.length),
      total: ids.length
    })
  }

  /*
    The twins, before the job reports itself done.

    A refresh that leaves a card unpriced has just proved the card needs a stand-in, and it
    is holding the list. Doing it here means the button on the Stats screen closes the gap
    too, not only the once-per-version fill.
  */
  if (unpricedIds.length) await fillEnglishPricesQuietly(unpricedIds, onProgress)

  const syncedAt = nowIso()
  setSetting('lastPriceSync', syncedAt)
  onProgress({
    job: 'price-sync',
    phase: 'Done',
    done: ids.length,
    total: ids.length,
    finished: true
  })

  return { requested: ids.length, updated, unpriced, syncedAt }
}
