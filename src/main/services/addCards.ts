import { effectiveFinishFor } from '@shared/types'
import type { AddCardInput, PrintingChoice, QuickAddInput } from '@shared/types'
import { addToCollection, ownedCount, ownedCounts } from '../db/repos/collection.js'
import { getPrinting, upsertPrinting } from '../db/repos/printings.js'
import { transaction } from '../db/connection.js'
import {
  autocomplete,
  printingBySetNumberLang,
  printingsForName,
  searchCards,
  type ScryfallCard
} from '../scryfall/client.js'
import { sortPrintings, toPrinting } from '../scryfall/mappers.js'
import { t } from '@shared/i18n/index'
import type { TranslationKey } from '@shared/types'
import { getLocale } from '../db/repos/settings.js'

/** Localised message, resolved at throw time from the stored locale. */
function tr(key: TranslationKey, vars?: Record<string, string | number>): string {
  return t(getLocale(), key, vars)
}

export async function suggestNames(query: string): Promise<string[]> {
  return autocomplete(query)
}

function cache(cards: ScryfallCard[]): PrintingChoice[] {
  const printings = cards.map(toPrinting)
  // One transaction, not one per printing: a common card returns hundreds of
  // printings, and an implicit transaction per INSERT made the lookup stall for
  // as long as the fetch itself.
  transaction(() => {
    for (let i = 0; i < printings.length; i += 1) {
      // Cache every printing we show, so the picker works offline next time and
      // the card stays browsable after it is added.
      upsertPrinting(printings[i], cards[i])
    }
  })
  // And one grouped query for the owned counts rather than one per printing.
  const owned = ownedCounts(printings.map((p) => p.scryfall_id))
  return printings.map((printing) => ({
    ...printing,
    owned: owned.get(printing.scryfall_id) ?? 0
  }))
}

/**
 * Every printing of a card in every language, for the printing picker.
 *
 * Tries the exact-name search first, then falls back to a fuzzy search so a
 * partially typed or localized name still finds something.
 */
export async function printingsFor(name: string): Promise<PrintingChoice[]> {
  const exact = await printingsForName(name)
  const cards = exact.cards.length ? exact.cards : await searchCards(name)
  const choices = cache(cards)
  return sortPrintings(choices) as PrintingChoice[]
}

/**
 * The same lookup, plus how many printings exist in total.
 *
 * Search results are capped (see `MAX_SEARCH_PAGES`), so the picker has to be
 * able to say "these are the newest 525 of 3,890" instead of implying it is
 * showing everything.
 */
export async function printingsPage(
  name: string
): Promise<{ printings: PrintingChoice[]; total: number; truncated: boolean }> {
  const exact = await printingsForName(name)
  const cards = exact.cards.length ? exact.cards : await searchCards(name)
  const choices = sortPrintings(cache(cards)) as PrintingChoice[]
  return {
    printings: choices,
    total: exact.cards.length ? exact.total : choices.length,
    truncated: exact.truncated
  }
}

/**
 * Resolves one printing by set, collector number and language.
 *
 * This route is the only one that honours language — `/cards/named?lang=` and
 * the `lang` key on `/cards/collection` both silently return English.
 */
export async function resolveQuick(
  set: string,
  collectorNumber: string,
  lang: string
): Promise<PrintingChoice | null> {
  const card = await printingBySetNumberLang(set, collectorNumber, lang)
  if (!card) return null
  const [choice] = cache([card])
  return choice ?? null
}

export function addCard(input: AddCardInput): { itemId: number; owned: number } {
  if (!getPrinting(input.scryfall_id)) {
    throw new Error(tr('err.notCached'))
  }
  if (input.quantity <= 0) throw new Error(tr('err.quantityAtLeastOne'))
  const itemId = addToCollection(input)
  return { itemId, owned: ownedCount(input.scryfall_id) }
}

export async function quickAdd(
  input: QuickAddInput
): Promise<{ itemId: number; printing: PrintingChoice }> {
  const printing = await resolveQuick(input.set, input.collectorNumber, input.lang)
  if (!printing) {
    throw new Error(
      `No printing found for ${input.set.toUpperCase()} #${input.collectorNumber} in "${input.lang}".`
    )
  }
  // A foil-only or etched-only printing cannot be held in the requested finish,
  // so record the one it actually comes in rather than inventing a nonfoil row.
  const itemId = addToCollection({
    scryfall_id: printing.scryfall_id,
    finish: effectiveFinishFor(printing, input.finish),
    condition: input.condition,
    quantity: input.quantity
  })
  return { itemId, printing: { ...printing, owned: ownedCount(printing.scryfall_id) } }
}

// The fast-entry parser lives in shared/ so the renderer validates with the
// exact same rules the main process applies.
export { parseQuickEntry } from '@shared/quickEntry'
