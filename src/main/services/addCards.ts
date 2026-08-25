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
import { holdable, sortPrintings, toPrinting } from '../scryfall/mappers.js'
import { getDb } from '../db/connection.js'
import { chooseSets, numberVariants } from '@shared/quickEntry'
import { pairPrintings, pairedNamesFor } from '../db/repos/pairs.js'
import { syncSets } from './sets.js'
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
  const ids = printings.map((p) => p.scryfall_id)
  const owned = ownedCounts(ids)
  // The same again for the other side of a double-sided token, so a tile can draw the
  // pair without asking per card.
  const paired = pairedNamesFor(ids)
  return printings.map((printing) => ({
    ...printing,
    owned: owned.get(printing.scryfall_id) ?? 0,
    paired: paired.get(printing.scryfall_id) ?? null
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
  const cards = (exact.cards.length ? exact.cards : await searchCards(name)).filter(holdable)
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
/**
 * The set a fast-entry line is really about.
 *
 * Only ever more than one candidate when a denominator was typed. `c17 8` has to
 * stay Teferi's Protection -- that is what the line says -- but `c17 008/011` is a
 * Cat Warrior, because C17 has 309 cards and only its token sheet has 11.
 *
 * The denominator may narrow the choice and must never veto it: for most sets the
 * printed number is not `card_count` at all (Bloomburrow prints /261 and counts
 * 398), so a total that matches nothing falls back to the set that was typed and
 * behaves exactly as it did before this existed.
 */
async function candidateSets(set: string, sheetTotal: number | null): Promise<string[]> {
  if (sheetTotal === null) return [set]

  /*
    The set cache is lazy by design -- nothing fetches it until something wants an
    icon -- so fast entry has to ask for it. One request for all ~1050 sets, and
    `syncSets` collapses concurrent callers into it. A failure is swallowed because
    `chooseSets` degrades to the typed set on an empty list, which is what the line
    asked for anyway.
  */
  await syncSets().catch(() => 0)

  const rows = getDb().all(
    `SELECT code, card_count, printed_size
       FROM sets
      WHERE code = ? OR parent_set_code = ?`,
    [set, set]
  ) as { code: string; card_count: number | null; printed_size: number | null }[]

  return chooseSets(
    rows.map((row) => ({ code: row.code, total: row.printed_size ?? row.card_count })),
    set,
    sheetTotal
  )
}

/** One printing on one known set, trying each case the number might be written in. */
async function resolveOnSet(
  set: string,
  collectorNumber: string,
  lang: string
): Promise<PrintingChoice | null> {
  for (const number of numberVariants(collectorNumber)) {
    const card = await printingBySetNumberLang(set, number, lang)
    if (!card) continue
    const [choice] = cache([card])
    if (choice) return choice
  }
  return null
}

export async function resolveQuick(
  set: string,
  collectorNumber: string,
  lang: string,
  sheetTotal: number | null = null
): Promise<PrintingChoice | null> {
  for (const candidate of await candidateSets(set, sheetTotal)) {
    const choice = await resolveOnSet(candidate, collectorNumber, lang)
    if (choice) return choice
  }
  return null
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
): Promise<{ itemId: number; printing: PrintingChoice; paired: PrintingChoice | null }> {
  const printing = await resolveQuick(
    input.set,
    input.collectorNumber,
    input.lang,
    input.sheetTotal ?? null
  )
  if (!printing) {
    throw new Error(
      `No printing found for ${input.set.toUpperCase()} #${input.collectorNumber} in "${input.lang}".`
    )
  }

  /*
    The other side, when the line named one.

    Resolved on the set the front landed in, not searched for again: the two sides of
    a card are on one sheet by definition, and re-running the candidate search could
    put the back on a different one -- which would record a pairing that does not
    physically exist.

    The pairing is written even when this copy merges into a row that already exists,
    because teaching the app is the point of having typed it.
  */
  let paired: PrintingChoice | null = null
  if (input.backNumber) {
    paired = await resolveOnSet(printing.set_code, input.backNumber, input.lang)
    if (!paired) {
      throw new Error(
        `No printing found for ${printing.set_code.toUpperCase()} #${input.backNumber} in "${input.lang}".`
      )
    }
    pairPrintings(printing.scryfall_id, paired.scryfall_id)
  }
  // A foil-only or etched-only printing cannot be held in the requested finish,
  // so record the one it actually comes in rather than inventing a nonfoil row.
  const itemId = addToCollection({
    scryfall_id: printing.scryfall_id,
    finish: effectiveFinishFor(printing, input.finish),
    condition: input.condition,
    quantity: input.quantity
  })
  return { itemId, printing: { ...printing, owned: ownedCount(printing.scryfall_id) }, paired }
}

// The fast-entry parser lives in shared/ so the renderer validates with the
// exact same rules the main process applies.
export { parseQuickEntry } from '@shared/quickEntry'
