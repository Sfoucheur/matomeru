import { getDb, nowIso } from '../connection.js'
import { t } from '@shared/i18n/index'
import type { TranslationKey } from '@shared/types'
import { getLocale } from './settings.js'

/** Localised message, resolved at throw time from the stored locale. */
function tr(key: TranslationKey, vars?: Record<string, string | number>): string {
  return t(getLocale(), key, vars)
}

/**
 * Which two printings are the two sides of one physical card.
 *
 * A Commander 2017 token card carries a Cat Warrior on one side and a Rat on the
 * other, and Scryfall files them as two independent tokens with nothing linking them
 * — see migration 17. So this table is taught, once, and then remembered.
 *
 * Everything here writes both directions at once. A card has one back, and which of
 * the two sides a caller happens to be holding is never interesting.
 */

/** The other side of this printing, or null. */
export function pairedWith(scryfallId: string): string | null {
  const row = getDb().get(
    'SELECT paired_scryfall_id FROM printing_pairs WHERE scryfall_id = ?',
    [scryfallId]
  ) as { paired_scryfall_id: string } | undefined
  return row?.paired_scryfall_id ?? null
}

/**
 * Records that these two printings share a card.
 *
 * Idempotent, and re-pairing is allowed: `ON CONFLICT` overwrites, so teaching the
 * app a corrected back replaces the wrong one rather than failing. Any pairing the
 * two sides previously had is cleared first, or the old partner would be left
 * pointing at a card that no longer points back.
 */
export function pairPrintings(a: string, b: string): void {
  if (a === b) throw new Error(tr('err.pairSameCard'))
  const db = getDb()
  const now = nowIso()
  unpairPrinting(a)
  unpairPrinting(b)
  for (const [from, to] of [
    [a, b],
    [b, a]
  ]) {
    db.run(
      `INSERT INTO printing_pairs (scryfall_id, paired_scryfall_id, created_at)
       VALUES (?,?,?)
       ON CONFLICT(scryfall_id) DO UPDATE SET
         paired_scryfall_id = excluded.paired_scryfall_id,
         created_at = excluded.created_at`,
      [from, to, now]
    )
  }
}

/**
 * The other side of many printings at once.
 *
 * The batch shape `ownedCounts` uses, and for the same reason: a page of search results
 * is hundreds of printings and one query beats one query each. Absent from the map means
 * no other side, which is almost every card.
 */
export function pairedNamesFor(
  scryfallIds: string[]
): Map<string, { scryfall_id: string; name: string; printed_name: string | null }> {
  const found = new Map<
    string,
    { scryfall_id: string; name: string; printed_name: string | null }
  >()
  if (scryfallIds.length === 0) return found
  const rows = getDb().all(
    `SELECT pr.scryfall_id AS asked, p.scryfall_id, p.name, p.printed_name
       FROM printing_pairs pr
       JOIN printings p ON p.scryfall_id = pr.paired_scryfall_id
      WHERE pr.scryfall_id IN (${scryfallIds.map(() => '?').join(',')})`,
    scryfallIds
  ) as { asked: string; scryfall_id: string; name: string; printed_name: string | null }[]
  for (const row of rows) {
    found.set(row.asked, {
      scryfall_id: row.scryfall_id,
      name: row.name,
      printed_name: row.printed_name
    })
  }
  return found
}

/** Forgets a pairing, from either side. */
export function unpairPrinting(scryfallId: string): void {
  const other = pairedWith(scryfallId)
  if (other === null) return
  const db = getDb()
  db.run('DELETE FROM printing_pairs WHERE scryfall_id IN (?, ?)', [scryfallId, other])
}
