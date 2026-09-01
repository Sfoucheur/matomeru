import { forceItemLanguage, setItemPrinting } from '../db/repos/collection.js'
import { getDb } from '../db/connection.js'
import { resolvePrintingInLanguage } from './languageResolve.js'
import { t } from '@shared/i18n/index'
import type { TranslationKey } from '@shared/types'
import { getLocale } from '../db/repos/settings.js'

/** Localised message, resolved at throw time from the stored locale. */
function tr(key: TranslationKey, vars?: Record<string, string | number>): string {
  return t(getLocale(), key, vars)
}

/**
 * Language changes for a card you entered yourself.
 *
 * The collection is simpler than a deck: a row *is* a printing, so a language change
 * points the row at the same print in that language. Resolution is shared with the deck
 * path, so both agree on when a print genuinely has no version in a language — and when
 * it does not, the print stays and `forced_lang` records the language you hold it in.
 */

/**
 * What one row's turn came to.
 *
 * A union rather than a boolean and a reason string: every outcome is a state worth
 * counting, and only one of the five is a failure. The orchestrator adds them up and the
 * total has to equal the number of rows selected, which is what makes a row that was
 * silently skipped impossible to express.
 */
export type ItemOutcome = 'converted' | 'declared' | 'reserved' | 'gone' | 'failed'

/**
 * Applies one language to one row you entered.
 *
 * Three outcomes are ordinary. `converted` found the same print in that language and
 * repointed the row at it. `declared` did not, so the row keeps its print and says it is
 * yours in that language. `reserved` did nothing at all, on purpose: see below.
 */
export async function applyLanguageToItem(
  itemId: number,
  lang: string,
  /** Printings cached along the way, for the caller to fetch English prices for. */
  cachedInto?: string[]
): Promise<ItemOutcome> {
  /*
    A LEFT join, not an inner one.

    A row whose printing is not in the cache used to throw `err.itemNotFound` here and be
    counted as a failure. It is not missing — it is a row we cannot look up a translation
    for — so it falls through to being declared, which is the honest answer and the one
    the user asked for.
  */
  const row = getDb().get(
    `SELECT ci.id, p.name, p.oracle_id, p.set_code, p.collector_number,
            (SELECT COALESCE(SUM(pli.quantity), 0)
             FROM pick_list_items pli
             JOIN pick_lists pl ON pl.id = pli.pick_list_id
             WHERE pli.collection_item_id = ci.id AND pl.status = 'open') AS reserved
     FROM collection_items ci
     LEFT JOIN printings p ON p.scryfall_id = ci.scryfall_id
     WHERE ci.id = ?`,
    [itemId]
  ) as
    | {
        id: number
        name: string | null
        oracle_id: string | null
        set_code: string | null
        collector_number: string | null
        reserved: number
      }
    | undefined
  if (!row) return 'gone'

  /*
    Copies an open pick list is holding are left alone, and not declared either.

    Declaring would be safe mechanically — nothing moves — but the list has promised
    those copies to someone, and quietly relabelling them changes what the list says it
    is picking. Checked here rather than by catching `setItemPrinting`'s refusal so it
    costs no Scryfall request; the refusal is still caught below, because it is the
    invariant every other caller relies on and this must not be the one place that
    assumes it away.
  */
  if (row.reserved > 0) return 'reserved'

  const found = await resolvePrintingInLanguage(
    {
      name: row.name ?? '',
      oracle_id: row.oracle_id,
      set_code: row.set_code,
      collector_number: row.collector_number
    },
    lang,
    cachedInto
  )

  if (!found) {
    // The print stays exactly as it is; only what language you hold it in changes. No
    // localized name, because none was ever fetched — and inventing one would be a lie.
    forceItemLanguage(itemId, lang)
    return 'declared'
  }

  try {
    // A real printing supersedes any language you had asserted for this row.
    const survivor = setItemPrinting(itemId, found.scryfall_id)
    forceItemLanguage(survivor, null)
    return 'converted'
  } catch (err) {
    if ((err as Error).message === tr('err.repointReserved')) return 'reserved'
    throw err
  }
}
