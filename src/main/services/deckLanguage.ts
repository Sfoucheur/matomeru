import type { ProgressEvent } from '@shared/types'
import {
  clearCardOverride,
  deckCardIdentities,
  forceCardLanguage,
  setCardOverride,
  setDeckDefaultLang,
  type DeckCardIdentity
} from '../db/repos/decks.js'
import { resolvePrintingInLanguage } from './languageResolve.js'

export type ProgressSink = (event: ProgressEvent) => void

/**
 * Language overrides for deck cards.
 *
 * Archidekt has no language field, so every printing it reports is the English one.
 * Recording the printing you actually own is what lets the exact-printing match find a
 * French copy sitting in your collection.
 *
 * Everything here is scoped to the cards you picked. There is deliberately no "apply to
 * the whole deck" entry point: converting 148 cards because you wanted three is not a
 * thing worth making easy.
 *
 * Resolution lives in `languageResolve.ts`, shared with the collection path so the two
 * can never disagree about what "no version of this print in that language" means. A
 * print Scryfall has no such version of keeps its printing and is recorded as one you
 * hold in that language — never relabelled as some other print that happens to exist.
 */

/** What one card's turn came to. Only `failed` is a failure. */
export type CardOutcome = 'converted' | 'declared' | 'failed'

export interface LanguageResult {
  converted: number
  /** Kept their printing, and now say you hold it in that language. */
  declared: number
  failed: number
}

/**
 * Resolves one deck entry to a specific language.
 *
 * Two ways to succeed. The same print in that language exists, so the entry points at it
 * — which is what makes an exact-printing deck match find the copy in your collection.
 * Or it does not, and the entry keeps the print while recording the language, which is
 * the state the deck screen already draws as a declared language.
 *
 * Declaring writes an override row, and an override's `scryfall_id` is not nullable, so
 * it pins the entry to the print it is on now — Archidekt will no longer move it. That is
 * the honest reading of what was just asserted ("my copy of *this* print is French") and
 * it is what the deck screen's own declare button has always done.
 */
export async function setCardLanguage(
  deckId: number,
  card: DeckCardIdentity,
  lang: string
): Promise<CardOutcome> {
  const found = await resolvePrintingInLanguage(card, lang)
  if (found) {
    // Writing the override clears any earlier miss for this card.
    setCardOverride(deckId, card.oracle_id, found.scryfall_id, found.lang)
    return 'converted'
  }

  forceCardLanguage(deckId, card.oracle_id, lang)
  return 'declared'
}

/**
 * Applies one language to the cards you selected, and to nothing else.
 *
 * Sequential on purpose: each lookup is a separate request and the Scryfall queue paces
 * them anyway, so firing them in parallel would only queue up behind itself while making
 * progress reporting meaningless.
 */
export async function setCardsLanguage(
  deckId: number,
  oracleIds: string[],
  lang: string,
  onProgress: ProgressSink
): Promise<LanguageResult> {
  const result: LanguageResult = { converted: 0, declared: 0, failed: 0 }
  const cards = deckCardIdentities(deckId, oracleIds)
  const phase = `Applying ${lang.toUpperCase()}`

  onProgress({ job: 'deck-language', phase, done: 0, total: cards.length })

  for (let i = 0; i < cards.length; i += 1) {
    const card = cards[i]
    try {
      result[await setCardLanguage(deckId, card, lang)] += 1
    } catch {
      result.failed += 1
    }
    onProgress({ job: 'deck-language', phase, done: i + 1, total: cards.length, message: card.name })
  }

  // Remembered only as the language you last asked for, to preselect the menu.
  // It no longer decides which cards count as unconvertible — that is per card.
  setDeckDefaultLang(deckId, lang)
  onProgress({
    job: 'deck-language',
    phase: 'Done',
    done: cards.length,
    total: cards.length,
    finished: true
  })
  return result
}

/** Returns the selected cards to whatever printing Archidekt reports. */
export function clearCardsLanguage(deckId: number, oracleIds: string[]): number {
  for (const oracleId of oracleIds) clearCardOverride(deckId, oracleId)
  return oracleIds.length
}
