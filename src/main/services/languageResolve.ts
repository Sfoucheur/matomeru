import { printingsFor } from './addCards.js'
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
  /** True when only the all-printings search found it, not the direct route. */
  viaSearch: boolean
}

/**
 * Finds the printing of a card in a given language.
 *
 * Two questions, in cost order. `GET /cards/{set}/{number}/{lang}` is the only
 * route that honours language, but it asks about *one exact printing* — so it
 * cannot see a translation published under a different set code or collector
 * number, which is most of them. Of 13 cards one real deck reported as having no
 * French printing, 11 existed and were found by the second step.
 *
 * Shared by the deck and collection paths so they can never disagree about what
 * "no printing in that language" means.
 */
export async function resolvePrintingInLanguage(
  card: CardIdentity,
  lang: string
): Promise<ResolvedPrinting | null> {
  if (card.set_code && card.collector_number) {
    const exact = await printingBySetNumberLang(card.set_code, card.collector_number, lang)
    if (exact) {
      // Cache it so names and art work offline afterwards.
      upsertPrinting(toPrinting(exact), exact)
      return { scryfall_id: exact.id, lang: exact.lang, viaSearch: false }
    }
  }

  // printingsFor caches every printing it sees, so a repeat attempt is free.
  const printings = await printingsFor(card.name)
  const candidates = printings.filter(
    (p) =>
      p.lang === lang &&
      // Guard against two different cards sharing a name: when the caller knows
      // its oracle id, the printing has to agree.
      (!p.oracle_id || !card.oracle_id || p.oracle_id === card.oracle_id)
  )
  if (!candidates.length) return null

  candidates.sort((a, b) => {
    const sameSet = Number(b.set_code === card.set_code) - Number(a.set_code === card.set_code)
    if (sameSet !== 0) return sameSet
    return (b.released_at ?? '').localeCompare(a.released_at ?? '')
  })
  return { scryfall_id: candidates[0].scryfall_id, lang: candidates[0].lang, viaSearch: true }
}
