import { getDb, nowIso } from '../connection.js'
import type { Currency, Finish, Printing, Prices, Rarity } from '@shared/types'
// Lives in shared/ because the renderer needs the same answer: the Add-cards
// tiles price a printing client-side and used to re-implement this branch.
export { priceFor } from '@shared/types'

export interface PrintingRow {
  scryfall_id: string
  oracle_id: string | null
  name: string
  printed_name: string | null
  lang: string
  set_code: string
  set_name: string
  collector_number: string
  rarity: string
  mana_cost: string | null
  cmc: number | null
  type_line: string | null
  printed_type_line: string | null
  oracle_text: string | null
  printed_text: string | null
  colors: string
  color_identity: string
  layout: string
  finishes: string
  promo_types: string | null
  in_boosters: number | null
  image_uri_normal: string | null
  image_uri_small: string | null
  released_at: string | null
  prices_json: string | null
  price_updated_at: string | null
  /**
   * The English twin's prices, when this printing carries none of its own.
   *
   * Selected by `PRINTING_COLUMNS` so the renderer can show a figure at all: the price a
   * screen draws off `Printing.prices` has no way back to the database, and three of them
   * -- the details grid, the printing picker, the Add-cards tiles -- drew an em dash for
   * every French card while the SQL paths were quietly borrowing the same figure.
   */
  borrowed_prices_json?: string | null
}

/**
 * A JSON text column, or the fallback when it is null or unparseable.
 *
 * Exported because `cardLocations` reads `finishes` and `promo_types` straight off
 * `printings` without building a whole `Printing`, and a second copy of this would be
 * a second place for the two to disagree.
 */
export function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function rowToPrinting(row: PrintingRow): Printing {
  return {
    scryfall_id: row.scryfall_id,
    oracle_id: row.oracle_id,
    name: row.name,
    printed_name: row.printed_name,
    lang: row.lang,
    set_code: row.set_code,
    set_name: row.set_name,
    collector_number: row.collector_number,
    rarity: row.rarity as Rarity,
    mana_cost: row.mana_cost,
    cmc: row.cmc,
    type_line: row.type_line,
    printed_type_line: row.printed_type_line,
    oracle_text: row.oracle_text,
    printed_text: row.printed_text,
    colors: parseJson<string[]>(row.colors, []),
    color_identity: parseJson<string[]>(row.color_identity, []),
    layout: row.layout,
    finishes: parseJson<Finish[]>(row.finishes, ['nonfoil']),
    promo_types: parseJson<string[]>(row.promo_types, []),
    // null for a printing cached before migration 8 whose raw_json lacked the
    // field; the UI treats that as "unknown" rather than as "not in boosters".
    in_boosters: row.in_boosters === null ? null : row.in_boosters === 1,
    image_uri_normal: row.image_uri_normal,
    image_uri_small: row.image_uri_small,
    released_at: row.released_at,
    prices: parseJson<Prices | null>(row.prices_json, null),
    price_updated_at: row.price_updated_at,
    borrowed_prices: parseJson<Prices | null>(row.borrowed_prices_json ?? null, null)
  }
}

/**
 * True when a printing carries any price at all.
 *
 * Not `prices_json IS NULL`: the mapper keeps every key Scryfall sends, and Scryfall sends
 * the object even for a card it prices in no currency. So an unpriced French printing holds
 * `{"usd":null,...,"eur":null}` -- a non-null column of nothing.
 */
function hasAnyPrice(table: string): string {
  return `(
    json_extract(${table}.prices_json, '$.usd') IS NOT NULL OR
    json_extract(${table}.prices_json, '$.usd_foil') IS NOT NULL OR
    json_extract(${table}.prices_json, '$.usd_etched') IS NOT NULL OR
    json_extract(${table}.prices_json, '$.eur') IS NOT NULL OR
    json_extract(${table}.prices_json, '$.eur_foil') IS NOT NULL
  )`
}

/**
 * Whether `s` is another printing of the card `p` names.
 *
 * Two keys, not one. `oracle_id` is the general answer, and the set plus collector number is
 * the stricter one -- the pair that identifies a single physical card across languages, which
 * is what Cardmarket prices as one product. The pair is needed on its own because Scryfall
 * omits the top-level `oracle_id` on reversible and art-series cards and the mapper stores
 * that null faithfully, so those rows could previously neither borrow nor lend.
 */
function isSiblingOf(s = 's', p = 'p'): string {
  return `(
    ${s}.scryfall_id != ${p}.scryfall_id
    AND (
      (${s}.oracle_id IS NOT NULL AND ${s}.oracle_id = ${p}.oracle_id)
      OR (${s}.set_code = ${p}.set_code AND ${s}.collector_number = ${p}.collector_number)
    )
  )`
}

/**
 * Whether the English printing of this exact card is already cached.
 *
 * The question "have we already asked Scryfall about this one?", and the reason the fill is
 * bounded: once the English row is here, the card is never queued again -- whether or not the
 * answer carried a price. Without this a card Scryfall prices in no language at all would be
 * re-fetched on every launch, for ever, to be told the same thing.
 */
function englishTwinCached(p = 'p'): string {
  return `EXISTS (
    SELECT 1 FROM printings e
     WHERE e.lang = 'en'
       AND e.set_code = ${p}.set_code
       AND e.collector_number = ${p}.collector_number
  )`
}

/** Same order as `siblingPrice`: the same set first, then English, then the newest. */
const SIBLING_ORDER = `ORDER BY (s.set_code = p.set_code) DESC, (s.lang = 'en') DESC,
                                s.released_at DESC`

/** All columns a printing needs, aliased so a joined query can reuse them. */
export const PRINTING_COLUMNS = `
  p.scryfall_id, p.oracle_id, p.name, p.printed_name, p.lang, p.set_code, p.set_name,
  p.collector_number, p.rarity, p.mana_cost, p.cmc, p.type_line, p.printed_type_line,
  p.oracle_text, p.printed_text, p.colors, p.color_identity, p.layout, p.finishes,
  p.promo_types, p.in_boosters, p.image_uri_normal, p.image_uri_small, p.released_at, p.prices_json, p.price_updated_at,
  (SELECT s.prices_json FROM printings s
    WHERE ${isSiblingOf()} AND ${hasAnyPrice('s')}
    ${SIBLING_ORDER}
    LIMIT 1) AS borrowed_prices_json
`

/**
 * SQL expression for the unit price of a row, honouring both currency and finish.
 *
 * Scryfall has no `eur_etched`, so etched cards in EUR fall back to the foil
 * price. Prices are stored as JSON strings and are frequently null for
 * non-English printings, which is why every caller must handle NULL.
 */
function ownPrice(currency: Currency, finishColumn: string, table = 'p'): string {
  if (currency === 'eur') {
    return `CAST(CASE ${finishColumn}
      WHEN 'foil'   THEN json_extract(${table}.prices_json, '$.eur_foil')
      WHEN 'etched' THEN json_extract(${table}.prices_json, '$.eur_foil')
      ELSE json_extract(${table}.prices_json, '$.eur')
    END AS REAL)`
  }
  return `CAST(CASE ${finishColumn}
    WHEN 'foil'   THEN json_extract(${table}.prices_json, '$.usd_foil')
    WHEN 'etched' THEN json_extract(${table}.prices_json, '$.usd_etched')
    ELSE json_extract(${table}.prices_json, '$.usd')
  END AS REAL)`
}

/**
 * The price of another printing of the same card, for when this one has none.
 *
 * Non-English printings almost never carry a price: of 445 cached printings in
 * one real collection, 254 of 259 English ones were priced and 1 of 141 French
 * ones. Without this, switching a deck to French silently erased most of its
 * value. Cardmarket prices a *product* largely regardless of language, so a
 * sibling's figure is what Cardmarket would actually quote you.
 *
 * Same set first, because printings of one card differ enormously in price — a
 * 1993 Alpha copy and a 2024 reprint are not interchangeable, whereas the French
 * and English copies of the *same* set are what Cardmarket treats as one product.
 * Then English, then most recently released, so the answer is deterministic
 * rather than whichever row SQLite happened to reach first.
 */
function siblingPrice(currency: Currency, finishColumn: string): string {
  return `(SELECT ${ownPrice(currency, finishColumn, 's')}
           FROM printings s
           WHERE ${isSiblingOf()}
             AND ${ownPrice(currency, finishColumn, 's')} IS NOT NULL
           ${SIBLING_ORDER}
           LIMIT 1)`
}

/**
 * SQL expression for the unit price of a row, honouring both currency and finish.
 *
 * Scryfall has no `eur_etched`, so etched cards in EUR fall back to the foil
 * price. Falls back to a sibling printing's price when this printing has none —
 * see `priceIsProxyExpr`, which tells the UI when that happened so a stand-in is
 * never shown as though it were the real figure. Still returns NULL when nothing
 * anywhere is priced, so callers must go on handling NULL.
 */
export function priceExpr(currency: Currency, finishColumn = 'ci.finish'): string {
  return `COALESCE(${ownPrice(currency, finishColumn)}, ${siblingPrice(currency, finishColumn)})`
}

/** 1 when the price shown belongs to a different printing of the same card. */
export function priceIsProxyExpr(currency: Currency, finishColumn = 'ci.finish'): string {
  return `(CASE
    WHEN ${ownPrice(currency, finishColumn)} IS NOT NULL THEN 0
    WHEN ${siblingPrice(currency, finishColumn)} IS NOT NULL THEN 1
    ELSE 0
  END)`
}

export function upsertPrinting(printing: Printing, raw?: unknown): void {
  getDb().run(
    `INSERT INTO printings (
      scryfall_id, oracle_id, name, printed_name, lang, set_code, set_name,
      collector_number, rarity, mana_cost, cmc, type_line, printed_type_line,
      oracle_text, printed_text, colors, color_identity, layout, finishes, promo_types,
      in_boosters, image_uri_normal,
      image_uri_small, released_at, prices_json, price_updated_at, raw_json, fetched_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(scryfall_id) DO UPDATE SET
      oracle_id = excluded.oracle_id,
      name = excluded.name,
      printed_name = excluded.printed_name,
      lang = excluded.lang,
      set_code = excluded.set_code,
      set_name = excluded.set_name,
      collector_number = excluded.collector_number,
      rarity = excluded.rarity,
      mana_cost = excluded.mana_cost,
      cmc = excluded.cmc,
      type_line = excluded.type_line,
      printed_type_line = excluded.printed_type_line,
      oracle_text = excluded.oracle_text,
      printed_text = excluded.printed_text,
      colors = excluded.colors,
      color_identity = excluded.color_identity,
      layout = excluded.layout,
      finishes = excluded.finishes,
      promo_types = excluded.promo_types,
      in_boosters = excluded.in_boosters,
      image_uri_normal = excluded.image_uri_normal,
      image_uri_small = excluded.image_uri_small,
      released_at = excluded.released_at,
      prices_json = excluded.prices_json,
      price_updated_at = excluded.price_updated_at,
      raw_json = excluded.raw_json,
      fetched_at = excluded.fetched_at`,
    [
      printing.scryfall_id,
      printing.oracle_id,
      printing.name,
      printing.printed_name,
      printing.lang,
      printing.set_code,
      printing.set_name,
      printing.collector_number,
      printing.rarity,
      printing.mana_cost,
      printing.cmc,
      printing.type_line,
      printing.printed_type_line,
      printing.oracle_text,
      printing.printed_text,
      JSON.stringify(printing.colors),
      JSON.stringify(printing.color_identity),
      printing.layout,
      JSON.stringify(printing.finishes),
      printing.promo_types.length ? JSON.stringify(printing.promo_types) : null,
      printing.in_boosters === null ? null : printing.in_boosters ? 1 : 0,
      printing.image_uri_normal,
      printing.image_uri_small,
      printing.released_at,
      printing.prices ? JSON.stringify(printing.prices) : null,
      printing.price_updated_at,
      raw ? JSON.stringify(raw) : null,
      nowIso()
    ]
  )
}

export function getPrinting(scryfallId: string): Printing | null {
  const row = getDb().get(
    `SELECT ${PRINTING_COLUMNS} FROM printings p WHERE p.scryfall_id = ?`,
    [scryfallId]
  ) as PrintingRow | undefined
  return row ? rowToPrinting(row) : null
}

export function findLocalPrintings(where: {
  name?: string
  set?: string
  collectorNumber?: string
  lang?: string
}): Printing[] {
  const clauses: string[] = []
  const params: (string | number)[] = []

  if (where.name) {
    clauses.push('(LOWER(p.name) = LOWER(?) OR LOWER(p.printed_name) = LOWER(?))')
    params.push(where.name, where.name)
  }
  if (where.set) {
    clauses.push('LOWER(p.set_code) = LOWER(?)')
    params.push(where.set)
  }
  if (where.collectorNumber) {
    clauses.push('p.collector_number = ?')
    params.push(where.collectorNumber)
  }
  if (where.lang) {
    clauses.push('p.lang = ?')
    params.push(where.lang)
  }
  if (!clauses.length) return []

  const rows = getDb().all(
    `SELECT ${PRINTING_COLUMNS} FROM printings p WHERE ${clauses.join(' AND ')} LIMIT 200`,
    params
  ) as PrintingRow[]
  return rows.map(rowToPrinting)
}

export function updatePrices(scryfallId: string, prices: Prices): void {
  getDb().run('UPDATE printings SET prices_json = ?, price_updated_at = ? WHERE scryfall_id = ?', [
    JSON.stringify(prices),
    nowIso(),
    scryfallId
  ])
}

/**
 * Scryfall ids of every printing whose price is worth keeping current.
 *
 * Was the collection alone, which is how a synced deck's cards went years without a price
 * refresh: a printing that exists only because a deck names it was invisible to the only job
 * that refreshes prices. The English twins are here for the same reason -- a borrowed figure
 * that is never refreshed is a figure frozen on the day it was borrowed.
 */
export function pricedPrintingIds(): string[] {
  const rows = getDb().all(
    `SELECT DISTINCT scryfall_id FROM (
       SELECT scryfall_id FROM collection_items WHERE quantity > 0
       UNION SELECT scryfall_id FROM deck_cards WHERE scryfall_id IS NOT NULL
       UNION SELECT scryfall_id FROM deck_card_overrides WHERE scryfall_id IS NOT NULL
       UNION SELECT e.scryfall_id
         FROM printings e
        WHERE e.lang = 'en'
          AND EXISTS (
            SELECT 1 FROM printings f
             WHERE f.lang != 'en'
               AND f.set_code = e.set_code
               AND f.collector_number = e.collector_number
               AND (
                 EXISTS (SELECT 1 FROM collection_items c WHERE c.scryfall_id = f.scryfall_id)
                 OR EXISTS (SELECT 1 FROM deck_cards d WHERE d.scryfall_id = f.scryfall_id)
                 OR EXISTS (
                   SELECT 1 FROM deck_card_overrides o WHERE o.scryfall_id = f.scryfall_id
                 )
               )
          )
     )`
  ) as { scryfall_id: string }[]
  return rows.map((r) => r.scryfall_id)
}

/**
 * Printings a screen would price at nothing, and whose English twin has not been fetched yet.
 *
 * Four conditions, each earning its place: not English itself (its own twin is itself, so
 * there would be nothing to fetch); no figure of its own; nothing cached to borrow from; and
 * no English row at this set and collector number, which is what makes the work finite.
 *
 * Held in the collection or named by a deck, because those are the ones anybody is looking
 * at -- the cache also holds every printing ever browsed, and their prices are nobody's
 * concern until a copy is owned.
 */
export function printingsMissingPrices(limit = 5000): {
  scryfall_id: string
  set_code: string
  collector_number: string
}[] {
  return getDb().all(
    `SELECT p.scryfall_id, p.set_code, p.collector_number
       FROM printings p
      WHERE p.lang != 'en'
        AND NOT ${hasAnyPrice('p')}
        AND NOT EXISTS (
          SELECT 1 FROM printings s WHERE ${isSiblingOf()} AND ${hasAnyPrice('s')}
        )
        AND NOT ${englishTwinCached()}
        AND (
          EXISTS (
            SELECT 1 FROM collection_items c
             WHERE c.scryfall_id = p.scryfall_id AND c.quantity > 0
          )
          OR EXISTS (SELECT 1 FROM deck_cards d WHERE d.scryfall_id = p.scryfall_id)
          OR EXISTS (SELECT 1 FROM deck_card_overrides o WHERE o.scryfall_id = p.scryfall_id)
        )
      ORDER BY p.scryfall_id
      LIMIT ?`,
    [limit]
  ) as { scryfall_id: string; set_code: string; collector_number: string }[]
}

/**
 * The borrowed prices for a batch of printings, keyed by id.
 *
 * For the picker and the Add-cards tiles, which hold printings straight off a Scryfall
 * search: those objects carry only what Scryfall said, so a French one carries no price and
 * nothing on that screen could reach the twin's. The same SQL as `PRINTING_COLUMNS` rather
 * than a second implementation of the rule in JavaScript — the two would drift, and the order
 * the lender is chosen in is the whole substance of it.
 */
export function borrowedPricesFor(scryfallIds: string[]): Map<string, string> {
  const distinct = [...new Set(scryfallIds)]
  const CHUNK = 500
  const found = new Map<string, string>()
  for (let i = 0; i < distinct.length; i += CHUNK) {
    const batch = distinct.slice(i, i + CHUNK)
    const holes = batch.map(() => '?').join(',')
    const rows = getDb().all(
      `SELECT p.scryfall_id,
              (SELECT s.prices_json FROM printings s
                WHERE ${isSiblingOf()} AND ${hasAnyPrice('s')}
                ${SIBLING_ORDER}
                LIMIT 1) AS borrowed
         FROM printings p
        WHERE p.scryfall_id IN (${holes})
          AND NOT ${hasAnyPrice('p')}`,
      batch
    ) as { scryfall_id: string; borrowed: string | null }[]
    for (const row of rows) {
      if (row.borrowed) found.set(row.scryfall_id, row.borrowed)
    }
  }
  return found
}

/**
 * The same question about specific printings, for filling straight after caching them.
 *
 * Deduplicated and asked in chunks, because the callers hand over whatever they just cached:
 * a CSV preview passes one id per matched row, so a 33,000-line bulk export would otherwise
 * bind 33,000 parameters and SQLite would refuse the statement outright — measured, this
 * build stops at 32,766 — taking the whole preview down with an error about SQL variables.
 * Every other batched thing here works in pages; so does this.
 */
export function unpricedAmong(scryfallIds: string[]): {
  scryfall_id: string
  set_code: string
  collector_number: string
}[] {
  const distinct = [...new Set(scryfallIds)]
  const CHUNK = 500
  const found: { scryfall_id: string; set_code: string; collector_number: string }[] = []
  for (let i = 0; i < distinct.length; i += CHUNK) {
    const batch = distinct.slice(i, i + CHUNK)
    const holes = batch.map(() => '?').join(',')
    found.push(
      ...(getDb().all(
        `SELECT p.scryfall_id, p.set_code, p.collector_number
           FROM printings p
          WHERE p.scryfall_id IN (${holes})
            AND p.lang != 'en'
            AND NOT ${hasAnyPrice('p')}
            AND NOT EXISTS (
              SELECT 1 FROM printings s WHERE ${isSiblingOf()} AND ${hasAnyPrice('s')}
            )
            AND NOT ${englishTwinCached()}`,
        batch
      ) as { scryfall_id: string; set_code: string; collector_number: string }[])
    )
  }
  return found
}
