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
 * Language and printing changes for a card you entered yourself.
 *
 * The collection is simpler than a deck: a row *is* a printing, so switching
 * language means pointing the row at the printing in that language. Resolution is
 * shared with the deck path, so both agree on when a language genuinely does not
 * exist — and when it does not, `forceItemLanguage` lets you say you hold it
 * anyway.
 */
export async function setItemLanguage(
  itemId: number,
  lang: string
): Promise<{ ok: boolean; viaSearch?: boolean; itemId?: number; reason?: string }> {
  const row = getDb().get(
    `SELECT p.name, p.oracle_id, p.set_code, p.collector_number
     FROM collection_items ci JOIN printings p ON p.scryfall_id = ci.scryfall_id
     WHERE ci.id = ?`,
    [itemId]
  ) as
    | { name: string; oracle_id: string | null; set_code: string; collector_number: string }
    | undefined
  if (!row) throw new Error(tr('err.itemNotFound'))

  const found = await resolvePrintingInLanguage(row, lang)
  if (!found) {
    return { ok: false, reason: `No ${lang.toUpperCase()} printing of ${row.name}.` }
  }
  // A real printing supersedes any language you had asserted for this row.
  const survivor = setItemPrinting(itemId, found.scryfall_id)
  forceItemLanguage(survivor, null)
  return { ok: true, viaSearch: found.viaSearch, itemId: survivor }
}
