import { parseRowKey } from '../db/repos/collection.js'
import { deckTargetsForPrinting } from '../db/repos/decks.js'
import { applyLanguageToItem } from './collectionLanguage.js'
import { setCardLanguage, type CardOutcome } from './deckLanguage.js'
import type { ProgressSink } from '../ipc/progressThrottle.js'

/**
 * One language, applied to a selection made on the Collection screen.
 *
 * That screen lists two kinds of row from one query: copies you entered, and copies
 * sleeved in a synced deck under a label you marked as owned. They are one list to look
 * at and one selection to make, so they have to be one action — which they were not. The
 * selection was mapped to numeric ids on the way out, derived deck rows have no id, and
 * every one of them was dropped on the floor without being counted. Selecting everything
 * and setting a language left the sleeved cards untouched and said it had succeeded.
 *
 * So this takes the keys the selection is actually made of and answers for all of them.
 */

export interface RowLanguageResult {
  /** Repointed to the same print in the language asked for. */
  converted: number
  /** Kept its print, and now says you hold it in that language. */
  declared: number
  /** Skipped: an open pick list is holding those copies. */
  reserved: number
  /**
   * The selection named something that is no longer there.
   *
   * Not a failure. A selection outlives the page it was made on — select-all reaches the
   * whole filtered set — so by the time a row's turn comes it may have been removed, or
   * merged away by an earlier row in this very run. Counted separately so a run that did
   * exactly what was asked does not look broken.
   */
  gone: number
  failed: number
  /** How many distinct decks an override was written to. */
  decks: number
}

/**
 * Applies one language to every selected row.
 *
 * Sequential on purpose, as both single-source paths were: each row is a Scryfall
 * request, the client's queue paces them anyway, and firing them together would only
 * queue behind itself while making progress meaningless.
 *
 * The invariant worth stating, because it is the whole point:
 *
 *     converted + declared + reserved + gone + failed === keys.length
 *
 * Every selected row gets exactly one outcome. A row that is quietly skipped cannot be
 * expressed, which is what went wrong before.
 */
export async function setRowLanguages(
  keys: string[],
  lang: string,
  onProgress: ProgressSink
): Promise<RowLanguageResult> {
  const result: RowLanguageResult = {
    converted: 0,
    declared: 0,
    reserved: 0,
    gone: 0,
    failed: 0,
    decks: 0
  }
  /*
    One progress stream, named for the screen the action was started on.

    The job name is both the throttle's key and the progress bar's identity, and the bar
    clears on the first `finished` event it sees. Reporting the deck half under
    `deck-language` would race two jobs for one bar and hide it halfway through.
  */
  const job = 'collection-language'
  const phase = `Applying ${lang.toUpperCase()}`
  onProgress({ job, phase, done: 0, total: keys.length })

  /*
    Deck entries already written this run.

    Two prints of one card in one deck are two rows in the collection and two keys here,
    but one row in `deck_card_overrides` — it is keyed on (deck, card), not on the print.
    Writing both would mean the second silently moved the first onto its print. The first
    wins and the second is left alone.
  */
  const written = new Set<string>()
  const decks = new Set<number>()

  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i]
    const ref = parseRowKey(key)
    let name: string | undefined

    if (ref === null) {
      // A key that does not parse names nothing, which is what `gone` means.
      result.gone += 1
    } else if (ref.source === 'collection') {
      try {
        result[await applyLanguageToItem(ref.itemId, lang)] += 1
      } catch {
        result.failed += 1
      }
    } else {
      const targets = deckTargetsForPrinting(ref.scryfallId, ref.finish)
      if (targets.length === 0) {
        // The group this row was derived from is not there any more: the deck was
        // deleted, the label mapping changed, or the copies were moved out.
        result.gone += 1
      } else {
        name = targets[0].name
        /*
          Resolved once for the row, not once per deck.

          Every target was grouped on the same print, so they all ask Scryfall the same
          question — and answering it once also guarantees they land on the *same* target
          print, which keeps this one row from splitting into two afterwards.
        */
        const outcomes: CardOutcome[] = []
        for (const target of targets) {
          const id = `${target.deck_id}:${target.oracle_id}`
          if (written.has(id)) continue
          try {
            const outcome = await setCardLanguage(target.deck_id, target, lang)
            written.add(id)
            decks.add(target.deck_id)
            outcomes.push(outcome)
          } catch {
            outcomes.push('failed')
          }
        }
        /*
          One outcome for the row, not one per deck.

          The user selected a row and counted rows, so that is what the totals have to
          add up to. A row counts as converted if any deck converted, declared if any
          declared, and failed only if nothing worked anywhere -- including the case where
          every target had already been written by an earlier key.
        */
        if (outcomes.includes('converted')) result.converted += 1
        else if (outcomes.includes('declared')) result.declared += 1
        else result.failed += 1
      }
    }

    onProgress({ job, phase, done: i + 1, total: keys.length, message: name })
  }

  result.decks = decks.size
  onProgress({ job, phase: 'Done', done: keys.length, total: keys.length, finished: true })
  return result
}
