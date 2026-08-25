import { forceItemLanguage, setItemPrinting } from '../db/repos/collection.js'
import { getDb } from '../db/connection.js'
import { resolvePrintingInLanguage } from './languageResolve.js'
import type { ProgressSink } from '../ipc/progressThrottle.js'
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
/** What applying a language to many rows did, in the four ways it can go. */
export interface ItemsLanguageResult {
  converted: number
  /** Of those, how many were found only by searching every printing of the card. */
  viaSearch: number
  unavailable: { name: string; lang: string }[]
  /**
   * Rows that no longer existed by the time their turn came.
   *
   * Not a failure, and worth its own number rather than being lumped in with one. A
   * selection can now outlive the page it was made on -- select-all reaches the whole
   * filtered set and survives a refetch -- so an id can name a row that has since been
   * removed or merged away. Without this it would be reported as a failure, which would
   * make a run that did exactly what was asked look broken.
   */
  gone: number
  failed: number
}

/**
 * Applies one language to the rows you selected, and to nothing else.
 *
 * Sequential on purpose, like the deck path this mirrors: each row is a separate Scryfall
 * request, the client's queue paces them anyway, and firing them together would only
 * queue behind itself while making progress meaningless.
 */
export async function setItemsLanguage(
  itemIds: number[],
  lang: string,
  onProgress: ProgressSink
): Promise<ItemsLanguageResult> {
  const result: ItemsLanguageResult = {
    converted: 0,
    viaSearch: 0,
    unavailable: [],
    failed: 0,
    gone: 0
  }
  const phase = `Applying ${lang.toUpperCase()}`
  onProgress({ job: 'collection-language', phase, done: 0, total: itemIds.length })

  for (let i = 0; i < itemIds.length; i += 1) {
    const id = itemIds[i]
    // Read the row now rather than up front: an earlier merge may have taken it, and
    // that is the normal case rather than an error.
    const row = getDb().get('SELECT id FROM collection_items WHERE id = ?', [id]) as
      | { id: number }
      | undefined
    if (!row) {
      result.gone += 1
    } else {
      try {
        const outcome = await setItemLanguage(id, lang)
        if (outcome.ok) {
          result.converted += 1
          if (outcome.viaSearch) result.viaSearch += 1
        } else {
          result.unavailable.push({ name: outcome.reason ?? String(id), lang })
        }
      } catch {
        result.failed += 1
      }
    }
    onProgress({
      job: 'collection-language',
      phase,
      done: i + 1,
      total: itemIds.length
    })
  }

  onProgress({
    job: 'collection-language',
    phase: 'Done',
    done: itemIds.length,
    total: itemIds.length,
    finished: true
  })
  return result
}

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
