import { printingBySetNumberLang } from '../scryfall/client.js'
import { upsertPrinting } from '../db/repos/printings.js'
import { toPrinting } from '../scryfall/mappers.js'

/** Enough of a card to look up another language of it. */
export interface CardIdentity {
  name: string
  oracle_id: string | null
  set_code: string | null
  collector_number: string | null
}

export interface ResolvedPrinting {
  scryfall_id: string
  lang: string
}

/**
 * The *same* print of a card, in another language.
 *
 * One question — `GET /cards/{set}/{number}/{lang}`, the only route that honours
 * language at all. On Scryfall a language is a separate card object, so the answer
 * is a different `scryfall_id` with the same set code and collector number: the
 * same physical card, printed in another language.
 *
 * It deliberately does *not* look anywhere else. A translation published under a
 * different set code or collector number is a different card object and a different
 * physical card: your English C17 #248 does not become a French one from another set
 * because Scryfall has one. This used to fall back to searching every printing of
 * the card and picking the closest, which is how a language change silently moved
 * rows onto prints their owner does not hold.
 *
 * When this returns null the caller keeps the print exactly as it is and records the
 * wanted language as a declared one instead — `forced_lang`, which the read paths
 * already prefer over the printing's own language.
 *
 * Shared by the deck and collection paths so the two can never disagree.
 */
export async function resolvePrintingInLanguage(
  card: CardIdentity,
  lang: string
): Promise<ResolvedPrinting | null> {
  if (!card.set_code || !card.collector_number) return null

  const exact = await printingBySetNumberLang(card.set_code, card.collector_number, lang)
  if (!exact) return null
  /*
    And it has to be the language that was asked for.

    The route builds `/en` into its own path when the language is English, and Scryfall
    answers some requests with the English card regardless. Reporting success for a card
    that came back in another language would write an override claiming a translation
    that was never found.
  */
  if (exact.lang !== lang) return null

  // Cache it, so names and art work offline afterwards.
  upsertPrinting(toPrinting(exact), exact)
  return { scryfall_id: exact.id, lang: exact.lang }
}
