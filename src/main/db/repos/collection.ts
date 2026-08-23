import { getDb, nowIso, transaction } from '../connection.js'
import {
  PRINTING_COLUMNS,
  priceExpr,
  priceIsProxyExpr,
  rowToPrinting,
  type PrintingRow
} from './printings.js'
import { DECK_FINISH, DECK_OVERRIDE_JOIN, DECK_PRINTING } from './decks.js'
import { FOIL_TREATMENTS, foilTreatmentOf } from '@shared/types'
import type {
  AddCardInput,
  CardLocations,
  CollectionFilters,
  CollectionPage,
  CollectionRow,
  Condition,
  Currency,
  DeckRef,
  FacetCounts,
  Finish,
  SortField
} from '@shared/types'
import { t } from '@shared/i18n/index'
import type { TranslationKey } from '@shared/types'
import { getLocale } from './settings.js'

/** Localised message, resolved at throw time from the stored locale. */
function tr(key: TranslationKey, vars?: Record<string, string | number>): string {
  return t(getLocale(), key, vars)
}

/**
 * Every row the collection is made of, from two sources.
 *
 * `collection` rows are real `collection_items` you entered. `deck` rows are
 * derived: cards sitting in an Archidekt deck under a label colour you have
 * marked as one you own, which are your physical cards just sleeved in a deck.
 * They are grouped per printing and finish, so a card in two decks is one row of
 * quantity 2 rather than two rows.
 *
 * Nothing here writes to `collection_items` — a deck sync still cannot change
 * what you own. The derived rows exist only for the duration of a query.
 *
 * With no colour mapped to `owned` — the default — the second branch yields
 * nothing and every figure is identical to a plain `collection_items` query.
 */
const ROW_SOURCES = `
  SELECT
    'collection' AS source,
    ci.id        AS item_id,
    ci.scryfall_id, ci.finish, ci.condition, ci.quantity,
    ci.purchase_price, ci.notes, ci.added_at, ci.updated_at,
    ci.forced_lang, ci.forced_name, ci.foil_treatment, ci.proxied,
    NULL AS deck_names,
    (SELECT COALESCE(SUM(pli.quantity), 0)
     FROM pick_list_items pli
     JOIN pick_lists pl ON pl.id = pli.pick_list_id
     WHERE pli.collection_item_id = ci.id AND pl.status = 'open') AS reserved
  FROM collection_items ci
  WHERE ci.quantity > 0

  UNION ALL

  SELECT
    'deck', NULL,
    ${DECK_PRINTING}, ${DECK_FINISH},
    NULL,                                  -- Archidekt does not record condition
    SUM(dc.quantity),
    NULL, NULL, NULL, NULL,
    MAX(o.forced_lang), MAX(o.forced_name), MAX(o.foil_treatment),
    MAX(COALESCE(o.proxied, 0)),
    GROUP_CONCAT(DISTINCT d.name),
    0                                      -- a card inside a deck cannot be staged
  FROM deck_cards dc
  JOIN decks d ON d.id = dc.deck_id
  ${DECK_OVERRIDE_JOIN}
  WHERE dc.label_possession = 'owned' AND ${DECK_PRINTING} IS NOT NULL
  GROUP BY ${DECK_PRINTING}, ${DECK_FINISH}
`

/**
 * Decks containing this card, matched on the exact printing *or* on the oracle
 * id (same card in another printing/language). This two-tier match is what
 * answers both "is this exact card in a deck?" and "do I have this card at all?".
 *
 * Excluding `not_owned` leaves out cards you have labelled as ones you do not
 * own. Such a deck entry is a wishlist line, not a place a physical card lives,
 * so counting it would defeat the point of tracking where cards are.
 */
/**
 * The language a row actually claims to be.
 *
 * A forced language is an assertion about a card Scryfall has no printing of, so
 * it has to win everywhere the printing's own language would be read — otherwise
 * a row reads "FR" while the language filter cannot find it.
 */
const EFFECTIVE_LANG = 'COALESCE(r.forced_lang, p.lang)'

/**
 * The foil treatment a row actually claims, in SQL.
 *
 * Generated from the shared `FOIL_TREATMENTS` list so that the filter, the facet
 * counts and what the row displays cannot disagree — the same mistake the
 * language override made when four queries derived the printing themselves.
 *
 * Order matters, and is the constant's order: the three LTC Sol Rings carry both
 * `serialized` and `doublerainbow`, and the foil type is the one worth naming.
 * A nonfoil copy has no treatment however the printing is tagged.
 */
const EFFECTIVE_TREATMENT = [
  'CASE',
  // Nonfoil first: a nonfoil copy has no foil type however it is tagged or
  // whatever override it carries, which is the rule `foilTreatmentOf` states.
  // Testing the override first let a stale value survive a switch to nonfoil.
  "  WHEN r.finish = 'nonfoil' THEN NULL",
  '  WHEN r.foil_treatment IS NOT NULL THEN r.foil_treatment',
  ...FOIL_TREATMENTS.map(
    (t) =>
      "  WHEN EXISTS (SELECT 1 FROM json_each(COALESCE(p.promo_types, '[]'))" +
      ` WHERE value = '${t.tag}') THEN '${t.tag}'`
  ),
  '  ELSE NULL',
  'END'
].join('\n')

const DECK_COUNT_EXPR = `(
  SELECT COUNT(DISTINCT dc.deck_id)
  FROM deck_cards dc
  ${DECK_OVERRIDE_JOIN}
  WHERE dc.label_possession IS NOT 'not_owned'
    AND (${DECK_PRINTING} = r.scryfall_id
         OR (p.oracle_id IS NOT NULL AND dc.oracle_id = p.oracle_id))
)`

/**
 * Colour ordering in the sequence a player expects on a table: WUBRG in mono,
 * then multicolour grouped, then colourless and lands last.
 *
 * Keyed on `color_identity` rather than `colors`, so a land that taps for green
 * or a card with an off-colour activated ability sorts where you would look for
 * it, not under colourless.
 */
const COLOR_ORDER = `CASE
  WHEN json_array_length(p.color_identity) = 0 THEN 7
  WHEN json_array_length(p.color_identity) > 1 THEN 6
  WHEN EXISTS (SELECT 1 FROM json_each(p.color_identity) WHERE value = 'W') THEN 1
  WHEN EXISTS (SELECT 1 FROM json_each(p.color_identity) WHERE value = 'U') THEN 2
  WHEN EXISTS (SELECT 1 FROM json_each(p.color_identity) WHERE value = 'B') THEN 3
  WHEN EXISTS (SELECT 1 FROM json_each(p.color_identity) WHERE value = 'R') THEN 4
  ELSE 5
END`

const SORT_COLUMNS: Record<SortField, string> = {
  name: 'COALESCE(p.printed_name, p.name)',
  color: COLOR_ORDER,
  lang: EFFECTIVE_LANG,
  rarity: `CASE p.rarity WHEN 'common' THEN 0 WHEN 'uncommon' THEN 1 WHEN 'rare' THEN 2
           WHEN 'mythic' THEN 3 ELSE 4 END`,
  set_code: 'p.set_code',
  collector_number: 'CAST(p.collector_number AS INTEGER), p.collector_number',
  finish: 'r.finish',
  condition: 'r.condition',
  quantity: 'r.quantity',
  unit_value: 'unit_value',
  total_value: 'total_value',
  added_at: 'r.added_at',
  cmc: 'p.cmc'
}

interface WhereClause {
  sql: string
  params: (string | number)[]
}

/** Sorts whose column can legitimately be NULL, which must never lead. */
const NULLABLE_SORTS = new Set<SortField>(['unit_value', 'total_value', 'added_at', 'condition'])

function orderTerm(field: SortField, dir: 'asc' | 'desc'): string {
  const column = SORT_COLUMNS[field] ?? SORT_COLUMNS.added_at
  const direction = dir === 'asc' ? 'ASC' : 'DESC'
  // NULLs last in both directions: unpriced cards never lead, and derived deck
  // rows (no added_at, no condition) never displace real ones.
  return NULLABLE_SORTS.has(field)
    ? `${column} IS NULL, ${column} ${direction}`
    : `${column} ${direction}`
}

/**
 * Primary sort, then the optional tie-breaker, then a stable final key so paging
 * can never repeat or drop a row when two rows tie on everything asked for.
 */
function buildOrderBy(filters: CollectionFilters): string {
  const terms = [orderTerm(filters.sort, filters.dir)]
  if (filters.sort2 && filters.sort2 !== filters.sort) {
    terms.push(orderTerm(filters.sort2, filters.dir2))
  }
  terms.push('r.source', 'r.item_id DESC', 'r.scryfall_id')
  return terms.join(', ')
}

function buildWhere(filters: CollectionFilters, currency: Currency): WhereClause {
  // The union already filters out zero quantities on the collection branch.
  const clauses: string[] = []
  const params: (string | number)[] = []

  if (filters.source) {
    clauses.push('r.source = ?')
    params.push(filters.source)
  }

  if (filters.search.trim()) {
    // Match the English name and the localized name, so both "Lightning Bolt"
    // and the Japanese title find the same card.
    const term = `%${filters.search.trim()}%`
    clauses.push(`(
      p.name LIKE ? COLLATE NOCASE
      OR p.printed_name LIKE ? COLLATE NOCASE
      OR p.set_code LIKE ? COLLATE NOCASE
      OR p.collector_number LIKE ?
      OR p.type_line LIKE ? COLLATE NOCASE
      OR p.printed_type_line LIKE ? COLLATE NOCASE
    )`)
    params.push(term, term, term, term, term, term)
  }

  const inList = (column: string, values: readonly string[]): void => {
    if (!values.length) return
    clauses.push(`${column} IN (${values.map(() => '?').join(',')})`)
    params.push(...values)
  }

  inList(EFFECTIVE_LANG, filters.langs)
  inList('p.rarity', filters.rarities)
  inList('p.set_code', filters.sets)
  inList('r.finish', filters.finishes)
  inList(EFFECTIVE_TREATMENT, filters.treatments)
  // null = both; true = only proxies; false = only real cards.
  if (filters.proxied !== null) clauses.push(`r.proxied = ${filters.proxied ? 1 : 0}`)
  // A deck copy has no known condition, so filtering by one necessarily excludes
  // derived rows rather than guessing at a value for them.
  inList('r.condition', filters.conditions)

  if (filters.colors.length) {
    // A card matches if its color identity contains any of the selected colors.
    // 'C' is the explicit colorless case: an empty color identity.
    const parts: string[] = []
    for (const color of filters.colors) {
      if (color === 'C') {
        parts.push(`json_array_length(p.color_identity) = 0`)
      } else {
        parts.push(`EXISTS (SELECT 1 FROM json_each(p.color_identity) WHERE value = ?)`)
        params.push(color)
      }
    }
    clauses.push(`(${parts.join(' OR ')})`)
  }

  if (filters.typeLine.trim()) {
    clauses.push('(p.type_line LIKE ? COLLATE NOCASE OR p.printed_type_line LIKE ? COLLATE NOCASE)')
    const term = `%${filters.typeLine.trim()}%`
    params.push(term, term)
  }

  if (filters.cmcMin !== null) {
    clauses.push('p.cmc >= ?')
    params.push(filters.cmcMin)
  }
  if (filters.cmcMax !== null) {
    clauses.push('p.cmc <= ?')
    params.push(filters.cmcMax)
  }

  const price = priceExpr(currency)
  if (filters.valueMin !== null) {
    clauses.push(`COALESCE(${price}, 0) >= ?`)
    params.push(filters.valueMin)
  }
  if (filters.valueMax !== null) {
    clauses.push(`COALESCE(${price}, 0) <= ?`)
    params.push(filters.valueMax)
  }

  if (filters.deckScope === 'in') {
    clauses.push(`${DECK_COUNT_EXPR} > 0`)
  } else if (filters.deckScope === 'out') {
    clauses.push(`${DECK_COUNT_EXPR} = 0`)
  } else if (typeof filters.deckScope === 'number') {
    clauses.push(`EXISTS (
      SELECT 1 FROM deck_cards dc
      WHERE dc.deck_id = ? AND dc.label_possession IS NOT 'not_owned'
        AND (dc.scryfall_id = r.scryfall_id
             OR (p.oracle_id IS NOT NULL AND dc.oracle_id = p.oracle_id))
    )`)
    params.push(filters.deckScope)
  }

  if (filters.onlyReserved) {
    clauses.push('r.reserved > 0')
  }

  return { sql: clauses.length ? clauses.join(' AND ') : '1 = 1', params }
}

interface JoinedRow extends PrintingRow {
  source: string
  item_id: number | null
  row_scryfall_id: string
  finish: string
  condition: string | null
  quantity: number
  purchase_price: number | null
  notes: string | null
  added_at: string | null
  updated_at: string | null
  deck_names: string | null
  reserved: number
  deck_count: number
  unit_value: number | null
  price_is_proxy: number
  total_value: number | null
  forced_lang: string | null
  forced_name: string | null
  foil_treatment: string | null
  proxied: number
}

function toCollectionRow(row: JoinedRow): CollectionRow {
  const source = row.source === 'deck' ? 'deck' : 'collection'
  const row_printing = rowToPrinting(row)
  return {
    // Derived rows have no id, so identity is the source plus what makes the
    // grouping unique. The UI keys selection and React children off this.
    key:
      source === 'collection'
        ? `collection:${row.item_id}`
        : `deck:${row.row_scryfall_id}:${row.finish}`,
    source,
    id: row.item_id,
    scryfall_id: row.row_scryfall_id,
    price_is_proxy: !!row.price_is_proxy,
    language_forced: !!row.forced_lang,
    finish: row.finish as Finish,
    // Normally the printing says which foil this is; a stored value is a
    // correction you made, and the UI marks it as yours.
    foil_treatment:
      row.finish === 'nonfoil'
        ? null
        : (row.foil_treatment ?? foilTreatmentOf(row_printing, row.finish as Finish)),
    treatment_forced: !!row.foil_treatment,
    proxied: row.proxied === 1,
    condition: (row.condition as Condition | null) ?? null,
    quantity: row.quantity,
    purchase_price: row.purchase_price,
    notes: row.notes,
    added_at: row.added_at,
    updated_at: row.updated_at,
    // A forced language and name override what the printing says, because the
    // printing is a stand-in for one Scryfall does not carry.
    printing: {
      ...row_printing,
      ...(row.forced_lang ? { lang: row.forced_lang } : {}),
      ...(row.forced_name ? { printed_name: row.forced_name } : {})
    },
    reserved: row.reserved,
    // A card sleeved in a deck is not available to pull from bulk.
    available: source === 'deck' ? 0 : row.quantity - row.reserved,
    deck_count: row.deck_count,
    deck_names: row.deck_names ? row.deck_names.split(',').filter(Boolean) : [],
    unit_value: row.unit_value,
    total_value: row.total_value
  }
}

/** The union, wrapped so every query shares one definition of "a collection row". */
const FROM_ROWS = `FROM (${ROW_SOURCES}) r JOIN printings p ON p.scryfall_id = r.scryfall_id`

export function queryCollection(
  filters: CollectionFilters,
  currency: Currency,
  limit: number,
  offset: number
): CollectionPage {
  const db = getDb()
  const where = buildWhere(filters, currency)
  const price = priceExpr(currency, 'r.finish')
  const proxy = priceIsProxyExpr(currency, 'r.finish')
  /*
    A proxied copy contributes nothing. `unit_value` deliberately keeps the real
    market price — it is the reference figure for what the card would cost — while
    everything that totals money treats the row as worthless, which is the point
    of flagging it.
  */
  const worth = `(CASE WHEN r.proxied = 1 THEN 0 ELSE ${price} END)`
  const orderBy = buildOrderBy(filters)

  const rows = db.all(
    `SELECT
       r.source, r.item_id, r.scryfall_id AS row_scryfall_id, r.finish, r.condition,
       r.quantity, r.purchase_price, r.notes, r.added_at, r.updated_at,
       r.deck_names, r.reserved, r.forced_lang, r.forced_name, r.foil_treatment,
       r.proxied,
       ${PRINTING_COLUMNS},
       ${DECK_COUNT_EXPR} AS deck_count,
       ${price} AS unit_value,
       ${proxy} AS price_is_proxy,
       ${worth} * r.quantity AS total_value
     ${FROM_ROWS}
     WHERE ${where.sql}
     ORDER BY ${orderBy}
     LIMIT ? OFFSET ?`,
    [...where.params, limit, offset]
  ) as JoinedRow[]

  const totals = db.get(
    `SELECT
       COUNT(*) AS total,
       COALESCE(SUM(r.quantity), 0) AS total_quantity,
       COALESCE(SUM(${worth} * r.quantity), 0) AS total_value,
       COALESCE(SUM(CASE WHEN r.source = 'collection' THEN r.quantity ELSE 0 END), 0) AS bulk_quantity,
       COALESCE(SUM(CASE WHEN r.source = 'collection' THEN ${worth} * r.quantity ELSE 0 END), 0) AS bulk_value,
       COALESCE(SUM(CASE WHEN r.source = 'deck' THEN r.quantity ELSE 0 END), 0) AS deck_quantity,
       COALESCE(SUM(CASE WHEN r.source = 'deck' THEN ${worth} * r.quantity ELSE 0 END), 0) AS deck_value
     ${FROM_ROWS}
     WHERE ${where.sql}`,
    where.params
  ) as {
    total: number
    total_quantity: number
    total_value: number
    bulk_quantity: number
    bulk_value: number
    deck_quantity: number
    deck_value: number
  }

  return {
    rows: rows.map(toCollectionRow),
    total: totals.total,
    totalQuantity: totals.total_quantity,
    totalValue: totals.total_value,
    bulkQuantity: totals.bulk_quantity,
    bulkValue: totals.bulk_value,
    deckQuantity: totals.deck_quantity,
    deckValue: totals.deck_value
  }
}

/** Facet counts computed against the current filters minus the facet's own dimension. */
export function queryFacets(filters: CollectionFilters, currency: Currency): FacetCounts {
  const db = getDb()

  const countBy = (
    column: string,
    omit: keyof CollectionFilters
  ): { value: string; count: number }[] => {
    const scoped = { ...filters, [omit]: [] } as CollectionFilters
    const where = buildWhere(scoped, currency)
    return db.all(
      `SELECT ${column} AS value, COALESCE(SUM(r.quantity), 0) AS count
       ${FROM_ROWS}
       WHERE ${where.sql} AND ${column} IS NOT NULL
       GROUP BY ${column}
       ORDER BY count DESC`,
      where.params
    ) as { value: string; count: number }[]
  }

  const setsScoped = { ...filters, sets: [] } as CollectionFilters
  const setsWhere = buildWhere(setsScoped, currency)
  const sets = db.all(
    `SELECT p.set_code AS value, p.set_name AS label, COALESCE(SUM(r.quantity), 0) AS count
     ${FROM_ROWS}
     WHERE ${setsWhere.sql}
     GROUP BY p.set_code, p.set_name
     ORDER BY count DESC`,
    setsWhere.params
  ) as { value: string; label: string; count: number }[]

  return {
    langs: countBy(EFFECTIVE_LANG, 'langs'),
    rarities: countBy('p.rarity', 'rarities'),
    sets,
    finishes: countBy('r.finish', 'finishes'),
    treatments: countBy(EFFECTIVE_TREATMENT, 'treatments'),
    conditions: countBy('r.condition', 'conditions')
  }
}

/**
 * Adds copies to the collection, merging into the existing row for the same
 * printing/finish/condition rather than creating a duplicate.
 */
export function addToCollection(input: AddCardInput): number {
  const db = getDb()
  const now = nowIso()
  db.run(
    `INSERT INTO collection_items
       (scryfall_id, finish, condition, quantity, purchase_price, notes, added_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(scryfall_id, finish, condition) DO UPDATE SET
       quantity = quantity + excluded.quantity,
       purchase_price = COALESCE(excluded.purchase_price, purchase_price),
       notes = COALESCE(excluded.notes, notes),
       updated_at = excluded.updated_at`,
    [
      input.scryfall_id,
      input.finish,
      input.condition,
      input.quantity,
      input.purchase_price ?? null,
      input.notes ?? null,
      now,
      now
    ]
  )
  const row = db.get(
    'SELECT id FROM collection_items WHERE scryfall_id = ? AND finish = ? AND condition = ?',
    [input.scryfall_id, input.finish, input.condition]
  ) as { id: number }
  return row.id
}

export function setQuantity(itemId: number, quantity: number): void {
  if (quantity <= 0) {
    removeItem(itemId)
    return
  }
  // Never let a quantity drop below what open pick lists have already reserved.
  const db = getDb()
  const reserved = (
    db.get(
      `SELECT COALESCE(SUM(pli.quantity), 0) AS reserved
       FROM pick_list_items pli
       JOIN pick_lists pl ON pl.id = pli.pick_list_id
       WHERE pli.collection_item_id = ? AND pl.status = 'open'`,
      [itemId]
    ) as { reserved: number }
  ).reserved
  if (quantity < reserved) {
    throw new Error(
      `Cannot set quantity to ${quantity}: ${reserved} copies are reserved by an open pick list.`
    )
  }
  db.run('UPDATE collection_items SET quantity = ?, updated_at = ? WHERE id = ?', [
    quantity,
    nowIso(),
    itemId
  ])
}

export function updateItem(
  itemId: number,
  patch: {
    finish?: Finish
    condition?: Condition
    purchase_price?: number | null
    notes?: string | null
    /** Null clears it, so the printing's own tag applies again. */
    foil_treatment?: string | null
    /** 1 when this copy is a proxy you printed rather than bought. */
    proxied?: 0 | 1
  }
): void {
  const sets: string[] = []
  const params: (string | number | null)[] = []
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    sets.push(`${key} = ?`)
    params.push(value as string | number | null)
  }
  if (!sets.length) return
  // Switching to nonfoil retires any foil type: leaving one behind stores a
  // contradiction that every reader then has to remember to suppress.
  if (patch.finish === 'nonfoil' && patch.foil_treatment === undefined) {
    sets.push('foil_treatment = NULL')
  }
  sets.push('updated_at = ?')
  params.push(nowIso(), itemId)
  // Changing finish/condition can collide with an existing row for the same
  // printing; merge into it instead of violating the UNIQUE constraint.
  try {
    getDb().run(`UPDATE collection_items SET ${sets.join(', ')} WHERE id = ?`, params)
  } catch (err) {
    if (!String((err as Error).message).includes('UNIQUE')) throw err
    mergeIntoExisting(itemId, patch)
  }
}

function mergeIntoExisting(
  itemId: number,
  patch: { finish?: Finish; condition?: Condition; foil_treatment?: string | null }
): void {
  transaction((db) => {
    const item = db.get('SELECT * FROM collection_items WHERE id = ?', [itemId]) as
      | { scryfall_id: string; finish: string; condition: string; quantity: number }
      | undefined
    if (!item) return
    const finish = patch.finish ?? item.finish
    const condition = patch.condition ?? item.condition
    const target = db.get(
      'SELECT id FROM collection_items WHERE scryfall_id = ? AND finish = ? AND condition = ? AND id != ?',
      [item.scryfall_id, finish, condition, itemId]
    ) as { id: number } | undefined
    if (!target) return
    db.run('UPDATE collection_items SET quantity = quantity + ?, updated_at = ? WHERE id = ?', [
      item.quantity,
      nowIso(),
      target.id
    ])
    // The row being merged away is gone, so a treatment set in the same patch has
    // to land on the survivor or the edit would silently do nothing.
    if (patch.foil_treatment !== undefined) {
      db.run('UPDATE collection_items SET foil_treatment = ? WHERE id = ?', [
        patch.foil_treatment,
        target.id
      ])
    }
    db.run('DELETE FROM collection_items WHERE id = ?', [itemId])
  })
}

export function removeItem(itemId: number): void {
  const db = getDb()
  const reserved = (
    db.get(
      `SELECT COALESCE(SUM(pli.quantity), 0) AS reserved
       FROM pick_list_items pli
       JOIN pick_lists pl ON pl.id = pli.pick_list_id
       WHERE pli.collection_item_id = ? AND pl.status = 'open'`,
      [itemId]
    ) as { reserved: number }
  ).reserved
  if (reserved > 0) {
    throw new Error(tr('err.reserved'))
  }
  db.run('DELETE FROM collection_items WHERE id = ?', [itemId])
}

export function bulkUpdate(
  itemIds: number[],
  patch: {
    finish?: Finish
    condition?: Condition
    foil_treatment?: string | null
    proxied?: 0 | 1
  }
): void {
  for (const id of itemIds) updateItem(id, patch)
}

export function bulkRemove(itemIds: number[]): { removed: number; skipped: number } {
  let removed = 0
  let skipped = 0
  for (const id of itemIds) {
    try {
      removeItem(id)
      removed += 1
    } catch {
      skipped += 1
    }
  }
  return { removed, skipped }
}

export function getItem(itemId: number): CollectionRow | null {
  const db = getDb()
  const price = priceExpr('usd', 'r.finish')
  const proxy = priceIsProxyExpr('usd', 'r.finish')
  const row = db.get(
    `SELECT
       r.source, r.item_id, r.scryfall_id AS row_scryfall_id, r.finish, r.condition,
       r.quantity, r.purchase_price, r.notes, r.added_at, r.updated_at,
       r.deck_names, r.reserved, r.forced_lang, r.forced_name, r.foil_treatment,
       r.proxied,
       ${PRINTING_COLUMNS},
       ${DECK_COUNT_EXPR} AS deck_count,
       ${price} AS unit_value,
       ${proxy} AS price_is_proxy,
       ${price} * r.quantity AS total_value
     ${FROM_ROWS}
     WHERE r.source = 'collection' AND r.item_id = ?`,
    [itemId]
  ) as JoinedRow | undefined
  return row ? toCollectionRow(row) : null
}

/** Copies of one exact printing currently held, across all finishes/conditions. */
export function ownedCount(scryfallId: string): number {
  const row = getDb().get(
    'SELECT COALESCE(SUM(quantity), 0) AS total FROM collection_items WHERE scryfall_id = ?',
    [scryfallId]
  ) as { total: number }
  return row.total
}

/**
 * Owned counts for many printings at once.
 *
 * The printing picker asks about every printing of a card — thousands of them for
 * a card like Forest — and one query each turned a lookup into a stall.
 */
export function ownedCounts(scryfallIds: string[]): Map<string, number> {
  const counts = new Map<string, number>()
  if (scryfallIds.length === 0) return counts
  const rows = getDb().all(
    `SELECT scryfall_id, COALESCE(SUM(quantity), 0) AS total
     FROM collection_items
     WHERE scryfall_id IN (${scryfallIds.map(() => '?').join(',')})
     GROUP BY scryfall_id`,
    scryfallIds
  ) as { scryfall_id: string; total: number }[]
  for (const row of rows) counts.set(row.scryfall_id, row.total)
  return counts
}

/** Everywhere a card is: loose copies, open reservations, and decks. */
export function cardLocations(scryfallId: string): CardLocations | null {
  const db = getDb()
  const printing = db.get(
    'SELECT scryfall_id, oracle_id, name, printed_name FROM printings WHERE scryfall_id = ?',
    [scryfallId]
  ) as { scryfall_id: string; oracle_id: string | null; name: string; printed_name: string | null } | undefined
  if (!printing) return null

  const loose = db.all(
    `SELECT ci.id AS collection_item_id, ci.finish, ci.condition, ci.quantity,
            ci.foil_treatment,
            (SELECT COALESCE(SUM(pli.quantity), 0)
             FROM pick_list_items pli
             JOIN pick_lists pl ON pl.id = pli.pick_list_id
             WHERE pli.collection_item_id = ci.id AND pl.status = 'open') AS reserved
     FROM collection_items ci
     WHERE ci.scryfall_id = ? AND ci.quantity > 0
     ORDER BY ci.finish, ci.condition`,
    [scryfallId]
  ) as CardLocations['loose']

  const reservations = db.all(
    `SELECT pl.id AS pick_list_id, pl.name AS pick_list_name, SUM(pli.quantity) AS quantity
     FROM pick_list_items pli
     JOIN pick_lists pl ON pl.id = pli.pick_list_id
     WHERE pli.scryfall_id = ? AND pl.status = 'open'
     GROUP BY pl.id, pl.name`,
    [scryfallId]
  ) as CardLocations['reservations']

  const decks = db.all(
    `SELECT d.id AS deck_id, d.name AS deck_name, SUM(dc.quantity) AS quantity,
            CASE WHEN MAX(CASE WHEN ${DECK_PRINTING} = ? THEN 1 ELSE 0 END) = 1
                 THEN 'exact' ELSE 'oracle' END AS match,
            -- A deck holds one entry per card, so the aggregate is that entry's
            -- own value; MAX only satisfies the GROUP BY.
            MAX(${DECK_FINISH}) AS finish,
            MAX(o.foil_treatment) AS foil_treatment,
            MAX(CASE WHEN o.finish IS NOT NULL THEN 1 ELSE 0 END) AS finish_forced
     FROM deck_cards dc
     JOIN decks d ON d.id = dc.deck_id
     ${DECK_OVERRIDE_JOIN}
     WHERE dc.label_possession IS NOT 'not_owned'
       AND (${DECK_PRINTING} = ? OR (? IS NOT NULL AND dc.oracle_id = ?))
     GROUP BY d.id, d.name
     ORDER BY d.name`,
    [scryfallId, scryfallId, printing.oracle_id, printing.oracle_id]
  ) as DeckRef[]

  return {
    scryfall_id: printing.scryfall_id,
    oracle_id: printing.oracle_id,
    name: printing.name,
    printed_name: printing.printed_name,
    loose,
    reservations,
    decks
  }
}

/**
 * Points a collection row at a different printing.
 *
 * A collection row *is* a printing — `scryfall_id` is the identity — so changing
 * which printing you hold is a repoint, not an override table. Two things make it
 * more than an UPDATE:
 *
 * - `UNIQUE (scryfall_id, finish, condition)` means the target may already exist,
 *   in which case the quantities merge rather than the write failing;
 * - copies promised to an open pick list must not move out from under it, so a
 *   reserved row refuses, exactly as `setQuantity` and `removeItem` already do.
 *
 * Returns the id of the row that survives, which is not always the one passed in.
 */
export function setItemPrinting(itemId: number, scryfallId: string): number {
  const db = getDb()
  const item = db.get(
    `SELECT ci.id, ci.scryfall_id, ci.finish, ci.condition, ci.quantity,
            (SELECT COALESCE(SUM(pli.quantity), 0)
             FROM pick_list_items pli
             JOIN pick_lists pl ON pl.id = pli.pick_list_id
             WHERE pli.collection_item_id = ci.id AND pl.status = 'open') AS reserved
     FROM collection_items ci WHERE ci.id = ?`,
    [itemId]
  ) as
    | {
        id: number
        scryfall_id: string
        finish: string
        condition: string
        quantity: number
        reserved: number
      }
    | undefined
  if (!item) throw new Error(tr('err.itemNotFound'))
  if (item.reserved > 0) {
    throw new Error(
      'Cannot change the printing: copies are reserved by an open pick list. Cancel or confirm it first.'
    )
  }
  if (!getDb().get('SELECT 1 FROM printings WHERE scryfall_id = ?', [scryfallId])) {
    throw new Error(tr('err.notCached'))
  }
  if (item.scryfall_id === scryfallId) return item.id

  let survivor = item.id
  transaction((tx) => {
    const existing = tx.get(
      'SELECT id, quantity FROM collection_items WHERE scryfall_id = ? AND finish = ? AND condition = ? AND id != ?',
      [scryfallId, item.finish, item.condition, item.id]
    ) as { id: number; quantity: number } | undefined

    if (existing) {
      // Merge into the row that already holds this printing, then drop this one.
      tx.run('UPDATE collection_items SET quantity = ?, updated_at = ? WHERE id = ?', [
        existing.quantity + item.quantity,
        nowIso(),
        existing.id
      ])
      tx.run('DELETE FROM collection_items WHERE id = ?', [item.id])
      survivor = existing.id
      return
    }

    // Naming a real printing retires any language you had asserted for this row.
    tx.run(
      `UPDATE collection_items
       SET scryfall_id = ?, forced_lang = NULL, forced_name = NULL, updated_at = ?
       WHERE id = ?`,
      [scryfallId, nowIso(), item.id]
    )
  })
  return survivor
}

/**
 * Records a language for a collection row that Scryfall has no printing of.
 *
 * The row keeps pointing at a real printing — that is where prices, rules text
 * and mana cost come from — while the language, and optionally the localized
 * name, become what you say they are. Passing null for the language clears the
 * assertion and the row goes back to describing its printing.
 */
export function forceItemLanguage(
  itemId: number,
  lang: string | null,
  name?: string | null
): void {
  const db = getDb()
  if (!db.get('SELECT 1 FROM collection_items WHERE id = ?', [itemId])) {
    throw new Error(tr('err.itemNotFound'))
  }
  db.run(
    'UPDATE collection_items SET forced_lang = ?, forced_name = ?, updated_at = ? WHERE id = ?',
    [lang, lang ? (name?.trim() ? name.trim() : null) : null, nowIso(), itemId]
  )
}

/** Every collection row, unpaginated — used by CSV export. */
export function exportRows(filters: CollectionFilters, currency: Currency): CollectionRow[] {
  return queryCollection(filters, currency, 1_000_000, 0).rows
}
