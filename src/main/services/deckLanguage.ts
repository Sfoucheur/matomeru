import type { ProgressEvent } from '@shared/types'
import {
  clearCardOverride,
  deckCardIdentities,
  recordLanguageMiss,
  setCardOverride,
  setDeckDefaultLang,
  type DeckCardIdentity
} from '../db/repos/decks.js'
import { resolvePrintingInLanguage } from './languageResolve.js'

export type ProgressSink = (event: ProgressEvent) => void

/**
 * Language overrides for deck cards.
 *
 * Archidekt has no language field, so every printing it reports is the English
 * one. Recording the printing you actually own is what lets the exact-printing
 * match find a French copy sitting in your collection.
 *
 * Everything here is scoped to the cards you picked. There is deliberately no
 * "apply to the whole deck" entry point: converting 148 cards because you wanted
 * three is not a thing worth making easy.
 *
 * Resolution lives in `languageResolve.ts`, shared with the collection path so
 * the two can never disagree about what "no printing in that language" means.
 * Cards Scryfall genuinely has nothing for keep their printing and are flagged
 * rather than relabelled as something they are not.
 */

export interface LanguageResult {
  converted: number
  /** Of those, how many were found only by searching every printing of the card. */
  viaSearch: number
  unavailable: { name: string; lang: string }[]
  failed: number
}

/**
 * Resolves one deck entry to a specific language.
 *
 * Every failure path records the miss, so the flag is written at the single choke
 * point rather than by each caller — which is what keeps it per-card.
 */
export async function setCardLanguage(
  deckId: number,
  card: DeckCardIdentity,
  lang: string
): Promise<{ ok: boolean; viaSearch?: boolean; reason?: string }> {
  const found = await resolvePrintingInLanguage(card, lang)
  if (found) {
    // Writing the override clears any earlier miss for this card.
    setCardOverride(deckId, card.oracle_id, found.scryfall_id, found.lang)
    return { ok: true, viaSearch: found.viaSearch }
  }

  recordLanguageMiss(deckId, card.oracle_id, lang)
  return { ok: false, reason: `No ${lang.toUpperCase()} printing of ${card.name}.` }
}

/**
 * Applies one language to the cards you selected, and to nothing else.
 *
 * Sequential on purpose: each lookup is a separate request and the Scryfall queue
 * paces them anyway, so firing them in parallel would only queue up behind itself
 * while making progress reporting meaningless.
 */
export async function setCardsLanguage(
  deckId: number,
  oracleIds: string[],
  lang: string,
  onProgress: ProgressSink
): Promise<LanguageResult> {
  const result: LanguageResult = { converted: 0, viaSearch: 0, unavailable: [], failed: 0 }
  const cards = deckCardIdentities(deckId, oracleIds)
  const phase = `Applying ${lang.toUpperCase()}`

  onProgress({ job: 'deck-language', phase, done: 0, total: cards.length })

  for (let i = 0; i < cards.length; i += 1) {
    const card = cards[i]
    try {
      const outcome = await setCardLanguage(deckId, card, lang)
      if (outcome.ok) {
        result.converted += 1
        if (outcome.viaSearch) result.viaSearch += 1
      } else result.unavailable.push({ name: card.name, lang })
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
