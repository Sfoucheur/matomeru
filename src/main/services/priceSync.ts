import type { ProgressEvent } from '@shared/types'
import { nowIso } from '../db/connection.js'
import { ownedPrintingIds, updatePrices } from '../db/repos/printings.js'
import { setSetting } from '../db/repos/settings.js'
import { cardsByIds } from '../scryfall/client.js'
import { toPrinting } from '../scryfall/mappers.js'

export type ProgressSink = (event: ProgressEvent) => void

export interface PriceSyncResult {
  requested: number
  updated: number
  /** Printings Scryfall has no price for at all — common for non-English cards. */
  unpriced: number
  syncedAt: string
}

/**
 * Refreshes prices for every printing in the collection.
 *
 * Batching by Scryfall `id` is deliberate: an id names one specific language
 * printing, so the Japanese and French versions of a card keep their own prices.
 * Identifying by set + collector number would collapse them all to English.
 */
export async function refreshPrices(onProgress: ProgressSink): Promise<PriceSyncResult> {
  const ids = ownedPrintingIds()
  onProgress({ job: 'price-sync', phase: 'Refreshing prices', done: 0, total: ids.length })

  let updated = 0
  let unpriced = 0
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
      if (!hasAnyPrice) unpriced += 1
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
