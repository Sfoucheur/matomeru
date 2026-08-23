import { getDb, nowIso, transaction } from '../connection.js'
import { priceExpr } from './printings.js'
import type {
  Condition,
  Currency,
  DeckRef,
  Finish,
  PickList,
  PickListItem,
  PickListStatus,
  Rarity
} from '@shared/types'
import { t } from '@shared/i18n/index'
import type { TranslationKey } from '@shared/types'
import { getLocale } from './settings.js'

/** Localised message, resolved at throw time from the stored locale. */
function tr(key: TranslationKey, vars?: Record<string, string | number>): string {
  return t(getLocale(), key, vars)
}

/**
 * The central rule of this module: an *open* pick list never mutates the
 * collection. It only reserves. Quantities move exactly once, when the list is
 * confirmed — which makes cancelling free and makes over-picking impossible.
 */

export function listPickLists(currency: Currency, status?: PickListStatus): PickList[] {
  const price = priceExpr(currency, 'pli.finish')
  const where = status ? 'WHERE pl.status = ?' : ''
  const params = status ? [status] : []
  return getDb().all(
    `SELECT pl.id, pl.name, pl.status, pl.created_at, pl.closed_at, pl.note,
            (SELECT COUNT(*) FROM pick_list_items x WHERE x.pick_list_id = pl.id) AS itemCount,
            (SELECT COALESCE(SUM(x.quantity), 0) FROM pick_list_items x WHERE x.pick_list_id = pl.id) AS cardCount,
            (SELECT COALESCE(SUM(COALESCE(${price}, 0) * pli.quantity), 0)
               FROM pick_list_items pli
               LEFT JOIN printings p ON p.scryfall_id = pli.scryfall_id
              WHERE pli.pick_list_id = pl.id) AS totalValue
     FROM pick_lists pl
     ${where}
     ORDER BY CASE pl.status WHEN 'open' THEN 0 ELSE 1 END, pl.created_at DESC`,
    params
  ) as PickList[]
}

export function createPickList(name: string, note?: string | null): number {
  const db = getDb()
  db.run('INSERT INTO pick_lists (name, status, created_at, note) VALUES (?, ?, ?, ?)', [
    name.trim() || 'Untitled pick list',
    'open',
    nowIso(),
    note ?? null
  ])
  return (db.get('SELECT last_insert_rowid() AS id') as { id: number }).id
}

/** The open list to drop cards into, creating a default one on first use. */
export function ensureDefaultPickList(): number {
  const db = getDb()
  const existing = db.get(
    "SELECT id FROM pick_lists WHERE status = 'open' ORDER BY created_at DESC LIMIT 1"
  ) as { id: number } | undefined
  return existing ? existing.id : createPickList('Pick list')
}

function availableFor(collectionItemId: number, excludePickItemId?: number): number {
  const db = getDb()
  const item = db.get('SELECT quantity FROM collection_items WHERE id = ?', [
    collectionItemId
  ]) as { quantity: number } | undefined
  if (!item) return 0
  const reserved = (
    db.get(
      `SELECT COALESCE(SUM(pli.quantity), 0) AS reserved
       FROM pick_list_items pli
       JOIN pick_lists pl ON pl.id = pli.pick_list_id
       WHERE pli.collection_item_id = ? AND pl.status = 'open'
         AND (? IS NULL OR pli.id != ?)`,
      [collectionItemId, excludePickItemId ?? null, excludePickItemId ?? null]
    ) as { reserved: number }
  ).reserved
  return item.quantity - reserved
}

export function addToPickList(
  pickListId: number,
  collectionItemId: number,
  quantity: number
): { added: number; capped: boolean } {
  return transaction((db) => {
    const list = db.get('SELECT status FROM pick_lists WHERE id = ?', [pickListId]) as
      | { status: string }
      | undefined
    if (!list) throw new Error(tr('err.pickListNotFound'))
    if (list.status !== 'open') throw new Error(tr('err.pickListClosed'))

    const existing = db.get(
      'SELECT id, quantity FROM pick_list_items WHERE pick_list_id = ? AND collection_item_id = ?',
      [pickListId, collectionItemId]
    ) as { id: number; quantity: number } | undefined

    const available = availableFor(collectionItemId, existing?.id)
    const room = existing ? available - existing.quantity : available
    // Cap rather than reject, so "add all selected" stays usable when one row
    // happens to be short.
    const added = Math.max(0, Math.min(quantity, room))
    if (added === 0) return { added: 0, capped: quantity > 0 }

    if (existing) {
      db.run('UPDATE pick_list_items SET quantity = quantity + ? WHERE id = ?', [added, existing.id])
      return { added, capped: added < quantity }
    }

    const snapshot = db.get(
      `SELECT ci.finish, ci.foil_treatment, ci.proxied, ci.condition, ci.scryfall_id, p.name, p.printed_name, p.lang,
              p.set_code, p.set_name, p.collector_number, p.rarity, p.image_uri_small
       FROM collection_items ci
       JOIN printings p ON p.scryfall_id = ci.scryfall_id
       WHERE ci.id = ?`,
      [collectionItemId]
    ) as
      | {
          finish: string
          foil_treatment: string | null
          proxied: number
          condition: string
          scryfall_id: string
          name: string
          printed_name: string | null
          lang: string
          set_code: string
          set_name: string
          collector_number: string
          rarity: string
          image_uri_small: string | null
        }
      | undefined
    if (!snapshot) throw new Error(tr('err.itemNotFound'))

    db.run(
      `INSERT INTO pick_list_items (
         pick_list_id, collection_item_id, quantity, scryfall_id, name, printed_name, lang,
         set_code, set_name, collector_number, rarity, finish, foil_treatment, proxied,
         condition, image_uri_small, created_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        pickListId,
        collectionItemId,
        added,
        snapshot.scryfall_id,
        snapshot.name,
        snapshot.printed_name,
        snapshot.lang,
        snapshot.set_code,
        snapshot.set_name,
        snapshot.collector_number,
        snapshot.rarity,
        snapshot.finish,
        snapshot.foil_treatment,
        snapshot.proxied,
        snapshot.condition,
        snapshot.image_uri_small,
        nowIso()
      ]
    )
    return { added, capped: added < quantity }
  })
}

export function setPickItemQuantity(pickItemId: number, quantity: number): void {
  if (quantity <= 0) {
    removePickItem(pickItemId)
    return
  }
  const db = getDb()
  const item = db.get(
    `SELECT pli.collection_item_id, pl.status
     FROM pick_list_items pli JOIN pick_lists pl ON pl.id = pli.pick_list_id
     WHERE pli.id = ?`,
    [pickItemId]
  ) as { collection_item_id: number | null; status: string } | undefined
  if (!item) throw new Error(tr('err.pickItemNotFound'))
  if (item.status !== 'open') throw new Error(tr('err.pickListClosed'))

  if (item.collection_item_id !== null) {
    const available = availableFor(item.collection_item_id, pickItemId)
    if (quantity > available) {
      throw new Error(tr('err.onlyAvailable', { count: available }))
    }
  }
  db.run('UPDATE pick_list_items SET quantity = ? WHERE id = ?', [quantity, pickItemId])
}

export function removePickItem(pickItemId: number): void {
  getDb().run('DELETE FROM pick_list_items WHERE id = ?', [pickItemId])
}

export function getPickListItems(pickListId: number, currency: Currency): PickListItem[] {
  const db = getDb()
  const price = priceExpr(currency, 'pli.finish')
  const rows = db.all(
    `SELECT pli.id, pli.pick_list_id, pli.collection_item_id, pli.quantity, pli.scryfall_id,
            pli.name, pli.printed_name, pli.lang, pli.set_code, pli.set_name,
            pli.collector_number, pli.rarity, pli.finish, pli.foil_treatment,
            COALESCE(pli.proxied, 0) AS proxied, pli.condition,
            pli.image_uri_small,
            ${price} AS unit_value,
            ci.quantity AS owned_quantity,
            p.oracle_id AS oracle_id
     FROM pick_list_items pli
     LEFT JOIN printings p ON p.scryfall_id = pli.scryfall_id
     LEFT JOIN collection_items ci ON ci.id = pli.collection_item_id
     WHERE pli.pick_list_id = ?
     ORDER BY pli.set_code, CAST(pli.collector_number AS INTEGER), pli.name`,
    [pickListId]
  ) as (Omit<PickListItem, 'decks' | 'rarity' | 'finish' | 'condition'> & {
    rarity: string
    finish: string
    condition: string
    oracle_id: string | null
  })[]

  // Deck memberships, so the confirm step can warn about pulling a card that a
  // built deck is using.
  const deckStmt = `
    SELECT d.id AS deck_id, d.name AS deck_name, SUM(dc.quantity) AS quantity,
           CASE WHEN MAX(CASE WHEN dc.scryfall_id = ? THEN 1 ELSE 0 END) = 1
                THEN 'exact' ELSE 'oracle' END AS match
    FROM deck_cards dc
    JOIN decks d ON d.id = dc.deck_id
    WHERE dc.label_possession IS NOT 'not_owned'
      AND (dc.scryfall_id = ? OR (? IS NOT NULL AND dc.oracle_id = ?))
    GROUP BY d.id, d.name
    ORDER BY d.name`

  return rows.map((row) => ({
    ...row,
    rarity: row.rarity as Rarity,
    finish: row.finish as Finish,
    condition: row.condition as Condition,
    decks: db.all(deckStmt, [
      row.scryfall_id,
      row.scryfall_id,
      row.oracle_id,
      row.oracle_id
    ]) as DeckRef[]
  }))
}

export interface ConfirmResult {
  pickListId: number
  cardsRemoved: number
  rowsDeleted: number
}

/**
 * Applies a pick list to the collection in one transaction: decrement the
 * quantities, delete rows that hit zero, and mark the list confirmed. The list
 * itself is kept as permanent history — its denormalized snapshot means it
 * still reads correctly even for rows that no longer exist.
 */
export function confirmPickList(pickListId: number): ConfirmResult {
  return transaction((db) => {
    const list = db.get('SELECT status FROM pick_lists WHERE id = ?', [pickListId]) as
      | { status: string }
      | undefined
    if (!list) throw new Error(tr('err.pickListNotFound'))
    if (list.status !== 'open') throw new Error(tr('err.pickListClosed'))

    const items = db.all(
      'SELECT id, collection_item_id, quantity FROM pick_list_items WHERE pick_list_id = ?',
      [pickListId]
    ) as { id: number; collection_item_id: number | null; quantity: number }[]

    let cardsRemoved = 0
    let rowsDeleted = 0

    for (const item of items) {
      if (item.collection_item_id === null) continue
      const owned = db.get('SELECT quantity FROM collection_items WHERE id = ?', [
        item.collection_item_id
      ]) as { quantity: number } | undefined
      if (!owned) continue

      const remaining = owned.quantity - item.quantity
      if (remaining < 0) {
        throw new Error(
          `Pick list asks for ${item.quantity} copies but only ${owned.quantity} are held. Refresh and try again.`
        )
      }
      cardsRemoved += item.quantity

      if (remaining === 0) {
        // Detach the pick item first so ON DELETE SET NULL does not fire while
        // we still need the link, then delete the emptied collection row.
        db.run('UPDATE pick_list_items SET collection_item_id = NULL WHERE id = ?', [item.id])
        db.run('DELETE FROM collection_items WHERE id = ?', [item.collection_item_id])
        rowsDeleted += 1
      } else {
        db.run('UPDATE collection_items SET quantity = ?, updated_at = ? WHERE id = ?', [
          remaining,
          nowIso(),
          item.collection_item_id
        ])
      }
    }

    db.run("UPDATE pick_lists SET status = 'confirmed', closed_at = ? WHERE id = ?", [
      nowIso(),
      pickListId
    ])
    return { pickListId, cardsRemoved, rowsDeleted }
  })
}

/** Releases every reservation without touching the collection. */
export function cancelPickList(pickListId: number): void {
  getDb().run("UPDATE pick_lists SET status = 'cancelled', closed_at = ? WHERE id = ?", [
    nowIso(),
    pickListId
  ])
}

export function reopenPickList(pickListId: number): void {
  const db = getDb()
  const list = db.get('SELECT status FROM pick_lists WHERE id = ?', [pickListId]) as
    | { status: string }
    | undefined
  if (!list) throw new Error(tr('err.pickListNotFound'))
  if (list.status === 'confirmed') {
    throw new Error(tr('err.confirmedIsHistory'))
  }
  db.run("UPDATE pick_lists SET status = 'open', closed_at = NULL WHERE id = ?", [pickListId])
}

export function deletePickList(pickListId: number): void {
  getDb().run('DELETE FROM pick_lists WHERE id = ?', [pickListId])
}

export function renamePickList(pickListId: number, name: string, note?: string | null): void {
  getDb().run('UPDATE pick_lists SET name = ?, note = ? WHERE id = ?', [
    name.trim() || 'Untitled pick list',
    note ?? null,
    pickListId
  ])
}
