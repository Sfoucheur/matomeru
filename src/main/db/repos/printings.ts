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
}

function parseJson<T>(raw: string | null, fallback: T): T {
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
    price_updated_at: row.price_updated_at
  }
}

/** All columns a printing needs, aliased so a joined query can reuse them. */
export const PRINTING_COLUMNS = `
  p.scryfall_id, p.oracle_id, p.name, p.printed_name, p.lang, p.set_code, p.set_name,
  p.collector_number, p.rarity, p.mana_cost, p.cmc, p.type_line, p.printed_type_line,
  p.oracle_text, p.printed_text, p.colors, p.color_identity, p.layout, p.finishes,
  p.promo_types, p.in_boosters, p.image_uri_normal, p.image_uri_small, p.released_at, p.prices_json, p.price_updated_at
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
           WHERE s.oracle_id IS NOT NULL
             AND s.oracle_id = p.oracle_id
             AND s.scryfall_id != p.scryfall_id
             AND ${ownPrice(currency, finishColumn, 's')} IS NOT NULL
           ORDER BY (s.set_code = p.set_code) DESC,
                    (s.lang = 'en') DESC,
                    s.released_at DESC
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

/** Scryfall ids of every printing represented in the collection. */
export function ownedPrintingIds(): string[] {
  const rows = getDb().all(
    'SELECT DISTINCT scryfall_id FROM collection_items WHERE quantity > 0'
  ) as { scryfall_id: string }[]
  return rows.map((r) => r.scryfall_id)
}
