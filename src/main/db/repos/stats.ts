import { getDb } from '../connection.js'
import { priceExpr } from './printings.js'
import { DECK_FINISH, DECK_OVERRIDE_JOIN, DECK_PRINTING } from './decks.js'
import { getSettings } from './settings.js'
import type { Stats } from '@shared/types'

/**
 * The same two row sources the Collection view is built from: what you entered,
 * plus cards sleeved in decks under a label colour you have marked as owned.
 * Kept in step with `ROW_SOURCES` in collection.ts so the two never disagree.
 *
 * With no colour mapped to `owned` the second branch is empty and every figure
 * matches a plain `collection_items` query.
 */
const ROWS = `
  SELECT 'collection' AS source, ci.scryfall_id, ci.finish, ci.quantity, ci.proxied
  FROM collection_items ci
  WHERE ci.quantity > 0
  UNION ALL
  SELECT 'deck', ${DECK_PRINTING}, ${DECK_FINISH}, SUM(dc.quantity),
         MAX(COALESCE(o.proxied, 0))
  FROM deck_cards dc
  ${DECK_OVERRIDE_JOIN}
  WHERE dc.label_possession = 'owned' AND ${DECK_PRINTING} IS NOT NULL
  GROUP BY ${DECK_PRINTING}, ${DECK_FINISH}
`

export function collectionStats(): Stats {
  const db = getDb()
  const settings = getSettings()
  const price = priceExpr(settings.currency, 'r.finish')
  /*
    A proxied copy is worth nothing, exactly as in `queryCollection`. These are
    two separate SQL paths over the same money, and `verify` asserts they agree —
    which is what caught this being added to the row source here without ever
    reaching the sums.
  */
  const worth = `(CASE WHEN r.proxied = 1 THEN 0 ELSE COALESCE(${price}, 0) END)`

  const base = `FROM (${ROWS}) r JOIN printings p ON p.scryfall_id = r.scryfall_id`

  const totals = db.get(
    `SELECT COALESCE(SUM(r.quantity), 0) AS totalCards,
            COUNT(*) AS distinctPrintings,
            COALESCE(SUM(${worth} * r.quantity), 0) AS totalValue,
            COALESCE(SUM(CASE WHEN r.source = 'collection' THEN r.quantity ELSE 0 END), 0) AS bulkCards,
            COALESCE(SUM(CASE WHEN r.source = 'collection' THEN ${worth} * r.quantity ELSE 0 END), 0) AS bulkValue,
            COALESCE(SUM(CASE WHEN r.source = 'deck' THEN r.quantity ELSE 0 END), 0) AS deckCards,
            COALESCE(SUM(CASE WHEN r.source = 'deck' THEN ${worth} * r.quantity ELSE 0 END), 0) AS deckValue
     ${base}`
  ) as {
    totalCards: number
    distinctPrintings: number
    totalValue: number
    bulkCards: number
    bulkValue: number
    deckCards: number
    deckValue: number
  }

  const groupBy = (column: string): { key: string; count: number; value: number }[] =>
    db.all(
      `SELECT ${column} AS key,
              COALESCE(SUM(r.quantity), 0) AS count,
              COALESCE(SUM(${worth} * r.quantity), 0) AS value
       ${base}
       GROUP BY ${column}
       ORDER BY value DESC`
    ) as { key: string; count: number; value: number }[]

  const bySet = db.all(
    `SELECT p.set_code AS key, p.set_name AS label,
            COALESCE(SUM(r.quantity), 0) AS count,
            COALESCE(SUM(${worth} * r.quantity), 0) AS value
     ${base}
     GROUP BY p.set_code, p.set_name
     ORDER BY value DESC
     LIMIT 40`
  ) as { key: string; label: string; count: number; value: number }[]

  const topCards = db.all(
    `SELECT p.scryfall_id, p.name, p.printed_name, p.lang, p.set_code, r.quantity,
            ${price} AS unit_value, ${price} * r.quantity AS total_value
     ${base}
     WHERE ${price} IS NOT NULL
     ORDER BY total_value DESC
     LIMIT 25`
  ) as Stats['topCards']

  const deckSplit = db.get(
    `SELECT
       COALESCE(SUM(CASE WHEN dcount > 0 THEN quantity ELSE 0 END), 0) AS inDecks,
       COALESCE(SUM(CASE WHEN dcount = 0 THEN quantity ELSE 0 END), 0) AS notInDecks
     FROM (
       SELECT r.quantity AS quantity,
              -- A card under a "don't own" label is not physically in that deck,
              -- so it counts as loose bulk.
              (SELECT COUNT(DISTINCT dc.deck_id) FROM deck_cards dc
               WHERE dc.label_possession IS NOT 'not_owned'
                 AND (dc.scryfall_id = r.scryfall_id
                      OR (p.oracle_id IS NOT NULL AND dc.oracle_id = p.oracle_id))) AS dcount
       ${base}
     )`
  ) as { inDecks: number; notInDecks: number }

  return {
    totalCards: totals.totalCards,
    distinctPrintings: totals.distinctPrintings,
    totalValue: totals.totalValue,
    bulkCards: totals.bulkCards,
    bulkValue: totals.bulkValue,
    deckCards: totals.deckCards,
    deckValue: totals.deckValue,
    currency: settings.currency,
    lastPriceSync: settings.lastPriceSync,
    byRarity: groupBy('p.rarity'),
    byLanguage: groupBy('p.lang'),
    bySet,
    topCards,
    inDecks: deckSplit.inDecks,
    notInDecks: deckSplit.notInDecks
  }
}
