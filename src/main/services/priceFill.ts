import type { ProgressEvent } from '@shared/types'
import { getRawSetting, setRawSetting } from '../db/repos/settings.js'
import {
  printingsMissingPrices,
  unpricedAmong,
  upsertPrinting
} from '../db/repos/printings.js'
import { cardsBySetNumber } from '../scryfall/client.js'
import { toPrinting } from '../scryfall/mappers.js'
import { logInfo } from './log.js'

/**
 * Filling in the English price for cards Scryfall prices in no other language.
 *
 * Scryfall attaches Cardmarket and TCGplayer figures to the *English* object of a set and
 * collector number and leaves every translation null — measured on real data, 1 of 141 French
 * printings carried a price against 254 of 259 English ones. The read path has always been
 * willing to borrow a cached sibling's figure and mark it as a stand-in; what was missing is
 * the sibling. Nothing in the app ever fetched the English twin of a card you hold in
 * French, so a French deck or a French shelf priced at nothing at all.
 *
 * So: for every printing a screen would price at nothing — no figure of its own, nothing
 * cached to borrow — fetch the English printing at the same set and collector number and
 * cache it like any other. `siblingPrice` then finds it first, because same-set-and-English
 * is the top of its ordering, and `price_is_proxy` says out loud that the figure is borrowed.
 *
 * Deliberately *not* a migration. A migration cannot make a request, and this needs one per
 * 75 cards; migration 21 records that the fill is owed and this pays it, which is the same
 * division of labour migration 2 used when it nulled `external_updated_at` to force a
 * re-sync it could not perform itself.
 */

export type ProgressSink = (event: ProgressEvent) => void

/**
 * The settings key migration 21 writes, and the only thing that makes the fill run.
 *
 * A raw row rather than a field on `AppSettings`: that object is handed to the renderer
 * wholesale, and this is bookkeeping between a migration and a startup task.
 */
export const FILL_FLAG = 'prices.fillEnglish'

export interface PriceFillResult {
  /** Printings that had no price and nothing to borrow. */
  requested: number
  /** Of those, the ones that now have an English twin cached with a real price. */
  filled: number
  /**
   * Cards Scryfall prices in no language at all.
   *
   * The legitimate em dash: there is nothing to show, and no amount of fetching will change
   * that. Counted rather than hidden so the number on screen can be trusted.
   */
  unpriced: number
}

const EMPTY: PriceFillResult = { requested: 0, filled: 0, unpriced: 0 }

/**
 * @param ids  Fill only these printings — what the add and language paths pass, so a card is
 *             priced the moment it lands. Omitted, the whole backlog is worked through.
 */
export async function fillEnglishPrices(
  ids?: string[],
  onProgress: ProgressSink = () => {}
): Promise<PriceFillResult> {
  const wanted = ids ? unpricedAmong(ids) : printingsMissingPrices()
  if (!wanted.length) return EMPTY

  const phase = 'Filling in missing prices'
  onProgress({ job: 'price-fill', phase, done: 0, total: wanted.length })

  let filled = 0
  let unpriced = 0
  const BATCH = 75

  for (let i = 0; i < wanted.length; i += BATCH) {
    const batch = wanted.slice(i, i + BATCH)
    const cards = await cardsBySetNumber(batch)
    for (const card of cards) {
      const printing = toPrinting(card)
      /*
        Cached whether or not it turned out to be priced.

        An English row with no price is still an answer, and storing it is what makes the
        selection stop offering this card: `printingsMissingPrices` skips a printing whose
        English twin is cached, so a card Scryfall prices in no language is asked about once
        rather than on every launch for ever. The French row goes on reporting no price, which
        is the truth about it.
      */
      upsertPrinting(printing, card)
      const priced =
        printing.prices !== null &&
        Object.values(printing.prices).some((value) => value !== null)
      if (priced) filled += 1
      else unpriced += 1
    }
    // Cards Scryfall did not return at all are absent from the reply, not zero-priced.
    unpriced += batch.length - cards.length
    onProgress({
      job: 'price-fill',
      phase,
      done: Math.min(i + BATCH, wanted.length),
      total: wanted.length
    })
  }

  onProgress({
    job: 'price-fill',
    phase: 'Done',
    done: wanted.length,
    total: wanted.length,
    finished: true
  })
  return { requested: wanted.length, filled, unpriced }
}

/**
 * The fill as a courtesy: it runs, and if it cannot, the caller never hears about it.
 *
 * Every caller but the button is doing something else — adding a card, converting a
 * selection, syncing a deck — and a borrowed price is not worth failing that for. Two ways it
 * bit before this existed:
 *
 *   Fast entry awaited the fetch *before* writing the row, so a 503 from Scryfall meant the
 *   card the user typed was never added at all.
 *
 *   The bulk language flows awaited it after every row was already committed, inside
 *   `undoableAsync` — which records its undo step only once `fn()` resolves. A throw there
 *   left three hundred converted rows in the database with no way to undo them, and an error
 *   toast for work that had in fact succeeded.
 *
 * So: caught, logged, and forgotten. The one caller that should see a failure is the button
 * on the Stats screen, because somebody asked it a question and is waiting for the answer.
 */
export async function fillEnglishPricesQuietly(
  ids: string[],
  onProgress?: ProgressSink
): Promise<PriceFillResult> {
  try {
    return await fillEnglishPrices(ids, onProgress)
  } catch (err) {
    logInfo('price-fill', `skipped for ${ids.length} printings: ${(err as Error).message}`)
    return EMPTY
  }
}

/**
 * The one-time run migration 21 asks for, on the first launch of the new version.
 *
 * The flag is cleared only on success, so an offline first launch retries on the next one
 * rather than losing the request. A failure is swallowed on purpose: nobody asked for this,
 * there is nothing for them to do about it, and a dead window would be a poor trade for a
 * price. Same reasoning as the update check it runs beside.
 */
export async function fillEnglishPricesIfOwed(onProgress: ProgressSink): Promise<void> {
  if (getRawSetting(FILL_FLAG) !== 'pending') return
  try {
    const result = await fillEnglishPrices(undefined, onProgress)
    setRawSetting(FILL_FLAG, 'done')
    logInfo(
      'price-fill',
      `filled ${result.filled} of ${result.requested} unpriced printings` +
        ` (${result.unpriced} have no price in any language)`
    )
  } catch (err) {
    logInfo('price-fill', `deferred: ${(err as Error).message}`)
  }
}
