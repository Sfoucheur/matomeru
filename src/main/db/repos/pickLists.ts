import { getDb, nowIso, transaction, type Sql } from '../connection.js'
import { priceExpr } from './printings.js'
import {
  DECK_FINISH,
  DECK_OVERRIDE_JOIN,
  DECK_PAIR_COLUMNS,
  DECK_PAIR_JOIN,
  DECK_PRINTING,
  DECK_PROXIED,
  DECK_TRAITS_JOIN,
  DECK_TREATMENT,
  applyOneMove,
  recordMove
} from './decks.js'
import { addToCollection } from './collection.js'
import type {
  Condition,
  Currency,
  DeckRef,
  Finish,
  PickList,
  PickListItem,
  PickListStatus,
  PickSource,
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

/**
 * How many copies of a collection row can still be staged.
 *
 * One branch again. Deck cards used to have their own, because they could be
 * staged too — they cannot now: a pick list means cards leaving your possession,
 * and a card in a deck is moved to the collection first, which loses nothing.
 */
function availableFor(source: PickSource, excludePickItemId?: number): number {
  return source.kind === 'collection'
    ? availableInCollection(source.itemId, excludePickItemId)
    : availableInDeck(source.deckId, source.oracleId, excludePickItemId)
}

function availableInCollection(itemId: number, excludePickItemId?: number): number {
  const db = getDb()
  const item = db.get('SELECT quantity FROM collection_items WHERE id = ?', [
    itemId
  ]) as { quantity: number } | undefined
  if (!item) return 0
  const reserved = (
    db.get(
      `SELECT COALESCE(SUM(pli.quantity), 0) AS reserved
       FROM pick_list_items pli
       JOIN pick_lists pl ON pl.id = pli.pick_list_id
       WHERE pli.collection_item_id = ? AND pl.status = 'open'
         AND (? IS NULL OR pli.id != ?)`,
      [itemId, excludePickItemId ?? null, excludePickItemId ?? null]
    ) as { reserved: number }
  ).reserved
  return item.quantity - reserved
}

/**
 * How many copies of a deck entry can still be staged.
 *
 * Reads `dc.quantity` directly, which is what the deck physically holds: a card
 * already moved out has been taken off the row. Nothing has to be adjusted here,
 * which is the whole benefit of writing moves into the rows.
 */
function availableInDeck(
  deckId: number,
  oracleId: string,
  excludePickItemId?: number
): number {
  const db = getDb()
  const held = (
    db.get(
      'SELECT COALESCE(SUM(quantity), 0) AS quantity FROM deck_cards WHERE deck_id = ? AND oracle_id = ?',
      [deckId, oracleId]
    ) as { quantity: number }
  ).quantity
  if (!held) return 0
  const reserved = (
    db.get(
      `SELECT COALESCE(SUM(pli.quantity), 0) AS reserved
       FROM pick_list_items pli
       JOIN pick_lists pl ON pl.id = pli.pick_list_id
       WHERE pli.source_deck_id = ? AND pli.source_oracle_id = ? AND pl.status = 'open'
         AND (? IS NULL OR pli.id != ?)`,
      [deckId, oracleId, excludePickItemId ?? null, excludePickItemId ?? null]
    ) as { reserved: number }
  ).reserved
  return held - reserved
}

/**
 * The snapshot for a deck entry.
 *
 * Resolved through DECK_PRINTING and DECK_FINISH rather than read off `deck_cards`,
 * so a staged row shows the printing and finish the deck screen shows. Condition is
 * NM because Archidekt records none.
 *
 * The two refusals live here so every entry point gets them: an entry not under an
 * "owned" label is a wishlist line rather than a card you hold, and a proxied entry
 * cannot become a collection row without mislabelling real copies of the same
 * printing.
 */
function snapshotOfDeckEntry(db: Sql, deckId: number, oracleId: string): PickSnapshot {
  const row = db.get(
    `SELECT ${DECK_PRINTING} AS scryfall_id, ${DECK_FINISH} AS finish,
            p.layout AS layout,
            ${DECK_PAIR_COLUMNS},
            ${DECK_TREATMENT} AS foil_treatment,
            ${DECK_PROXIED} AS proxied,
            dc.label_possession AS label_possession,
            p.name, p.printed_name, p.lang, p.set_code, p.set_name,
            p.collector_number, p.rarity, p.image_uri_small
     FROM deck_cards dc
     ${DECK_OVERRIDE_JOIN}
     ${DECK_TRAITS_JOIN}
     ${DECK_PAIR_JOIN}
     JOIN printings p ON p.scryfall_id = ${DECK_PRINTING}
     WHERE dc.deck_id = ? AND dc.oracle_id = ? AND ${DECK_PRINTING} IS NOT NULL
     LIMIT 1`,
    [deckId, oracleId]
  ) as (PickSnapshot & { label_possession: string | null }) | undefined
  if (!row) throw new Error(tr('err.itemNotFound'))
  if (row.label_possession !== 'owned') throw new Error(tr('err.pickNotOwned'))
  if (row.proxied === 1) throw new Error(tr('err.pickProxy'))
  return { ...row, condition: 'NM' }
}

/**
 * The snapshot a staged row carries.
 *
 * Denormalized on purpose — the table's own comment says why: a confirmed list has
 * to keep reading correctly after the row it came from is gone.
 */
function snapshotOfCollectionItem(db: Sql, itemId: number): PickSnapshot | undefined {
  return db.get(
    `SELECT ci.finish, ci.foil_treatment, ci.proxied, ci.condition, ci.scryfall_id,
            p.name, p.printed_name, p.lang, p.set_code, p.set_name, p.collector_number,
            p.rarity, p.image_uri_small
     FROM collection_items ci
     JOIN printings p ON p.scryfall_id = ci.scryfall_id
     WHERE ci.id = ?`,
    [itemId]
  ) as PickSnapshot | undefined
}

interface PickSnapshot {
  scryfall_id: string
  finish: string
  foil_treatment: string | null
  proxied: number
  condition: string
  name: string
  printed_name: string | null
  lang: string
  set_code: string
  set_name: string
  collector_number: string
  rarity: string
  image_uri_small: string | null
}

export function addToPickList(
  pickListId: number,
  source: PickSource,
  quantity: number
): { added: number; capped: boolean } {
  return transaction((db) => {
    const list = db.get('SELECT status FROM pick_lists WHERE id = ?', [pickListId]) as
      | { status: string }
      | undefined
    if (!list) throw new Error(tr('err.pickListNotFound'))
    if (list.status !== 'open') throw new Error(tr('err.pickListClosed'))

    /*
      Two staged rows are "the same row" when they name the same source *and* the
      same destination. A deck card pulled to your box and the same card pulled to
      sell are two different jobs on the same list, so they stay two rows.
    */
    const existing = (
      source.kind === 'collection'
        ? db.get(
            'SELECT id, quantity FROM pick_list_items WHERE pick_list_id = ? AND collection_item_id = ?',
            [pickListId, source.itemId]
          )
        : db.get(
            `SELECT id, quantity FROM pick_list_items
             WHERE pick_list_id = ? AND source_deck_id = ? AND source_oracle_id = ?
               AND COALESCE(destination, 'collection') = ?`,
            [pickListId, source.deckId, source.oracleId, source.destination]
          )
    ) as { id: number; quantity: number } | undefined

    const available = availableFor(source, existing?.id)
    const room = existing ? available - existing.quantity : available
    // Cap rather than reject, so "add all selected" stays usable when one row
    // happens to be short.
    const added = Math.max(0, Math.min(quantity, room))
    if (added === 0) return { added: 0, capped: quantity > 0 }

    if (existing) {
      db.run('UPDATE pick_list_items SET quantity = quantity + ? WHERE id = ?', [added, existing.id])
      return { added, capped: added < quantity }
    }

    const snapshot =
      source.kind === 'collection'
        ? snapshotOfCollectionItem(db, source.itemId)
        : snapshotOfDeckEntry(db, source.deckId, source.oracleId)
    if (!snapshot) throw new Error(tr('err.itemNotFound'))

    db.run(
      `INSERT INTO pick_list_items (
         pick_list_id, collection_item_id, source_deck_id, source_oracle_id, destination,
         quantity, scryfall_id, name, printed_name, lang,
         set_code, set_name, collector_number, rarity, finish, foil_treatment, proxied,
         condition, image_uri_small, created_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        pickListId,
        source.kind === 'collection' ? source.itemId : null,
        source.kind === 'deck' ? source.deckId : null,
        source.kind === 'deck' ? source.oracleId : null,
        source.kind === 'deck' ? source.destination : null,
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

/**
 * Which source a staged row names, or null when it names none any more.
 *
 * One place tests the two columns, so a row can never be read as a collection
 * item and a deck entry at once, and adding a third kind of source later touches
 * this function rather than every caller.
 */
function sourceOf(row: {
  collection_item_id: number | null
  source_deck_id: number | null
  source_oracle_id: string | null
  destination?: string | null
}): PickSource | null {
  if (row.collection_item_id !== null) return { kind: 'collection', itemId: row.collection_item_id }
  if (row.source_deck_id !== null && row.source_oracle_id !== null) {
    return {
      kind: 'deck',
      deckId: row.source_deck_id,
      oracleId: row.source_oracle_id,
      // Rows staged before the destination existed meant "keep it", which is what
      // validating did then.
      destination: row.destination === 'gone' ? 'gone' : 'collection'
    }
  }
  return null
}

export function setPickItemQuantity(pickItemId: number, quantity: number): void {
  if (quantity <= 0) {
    removePickItem(pickItemId)
    return
  }
  const db = getDb()
  const item = db.get(
    `SELECT pli.collection_item_id, pli.source_deck_id, pli.source_oracle_id, pl.status
     FROM pick_list_items pli JOIN pick_lists pl ON pl.id = pli.pick_list_id
     WHERE pli.id = ?`,
    [pickItemId]
  ) as
    | {
        collection_item_id: number | null
        source_deck_id: number | null
        source_oracle_id: string | null
        status: string
      }
    | undefined
  if (!item) throw new Error(tr('err.pickItemNotFound'))
  if (item.status !== 'open') throw new Error(tr('err.pickListClosed'))

  // A row whose source is gone entirely — a collection item deleted from under
  // it — keeps the old behaviour of accepting the edit: the snapshot is all that
  // is left, and refusing would make the row uneditable.
  const source = sourceOf(item)
  if (source) {
    const available = availableFor(source, pickItemId)
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
            pli.image_uri_small, pli.destination,
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
  /** Copies taken out of the collection — these left your possession. */
  cardsRemoved: number
  rowsDeleted: number
  /**
   * Copies taken out of a deck and added to the bulk instead. These did *not*
   * leave your possession, so they are counted separately: reporting them as
   * removed would tell you that you had lost cards you still own.
   */
  cardsFreedFromDecks: number
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
      `SELECT id, collection_item_id, source_deck_id, source_oracle_id, quantity,
              scryfall_id, finish, condition, name, destination
       FROM pick_list_items WHERE pick_list_id = ?`,
      [pickListId]
    ) as {
      id: number
      collection_item_id: number | null
      source_deck_id: number | null
      source_oracle_id: string | null
      quantity: number
      scryfall_id: string
      finish: string
      condition: string
      name: string
      destination: string | null
    }[]

    let cardsRemoved = 0
    let rowsDeleted = 0
    let cardsFreedFromDecks = 0

    for (const item of items) {
      /*
        A deck-sourced copy always leaves the deck. Whether it stays yours is what
        the destination says, and the two are genuinely different jobs: pulling a
        card out to put in your box, or pulling it out to sell.

        Either way the deck row comes down and the ledger records it, so the deck
        screen can say the decklist is out of date until a sync catches up. Only
        `collection` also puts the copies in the collection.
      */
      if (item.collection_item_id === null && item.source_deck_id && item.source_oracle_id) {
        /*
          Re-check what the deck holds, exactly as the collection branch re-checks
          the row. Staging only reserved; a sync can have shrunk the deck since,
          and Archidekt is the authority on what a deck contains. Without this the
          pull would claim more copies than the deck has, and for a `collection`
          destination `addToCollection` would mint the difference out of nothing.
        */
        const held = (
          db.get(
            'SELECT COALESCE(SUM(quantity), 0) AS quantity FROM deck_cards WHERE deck_id = ? AND oracle_id = ?',
            [item.source_deck_id, item.source_oracle_id]
          ) as { quantity: number }
        ).quantity
        if (held < item.quantity) {
          throw new Error(
            tr('err.pickShortfall', { name: item.name, asked: item.quantity, held })
          )
        }

        recordMove(db, {
          deckId: item.source_deck_id,
          oracleId: item.source_oracle_id,
          scryfallId: item.scryfall_id,
          finish: item.finish,
          condition: item.condition,
          quantity: -item.quantity
        })
        applyOneMove(db, item.source_deck_id, {
          oracle_id: item.source_oracle_id,
          scryfall_id: item.scryfall_id,
          finish: item.finish,
          quantity: -item.quantity
        })

        if (item.destination === 'gone') {
          // Out of the deck and out of your possession: nothing to add anywhere.
          cardsRemoved += item.quantity
        } else {
          addToCollection({
            scryfall_id: item.scryfall_id,
            finish: item.finish as Finish,
            condition: item.condition as Condition,
            quantity: item.quantity
          })
          cardsFreedFromDecks += item.quantity
        }
        continue
      }

      if (item.collection_item_id === null) continue
      const owned = db.get('SELECT quantity FROM collection_items WHERE id = ?', [
        item.collection_item_id
      ]) as { quantity: number } | undefined
      if (!owned) continue

      const remaining = owned.quantity - item.quantity
      if (remaining < 0) {
        // Was an untranslated English sentence, which reached the user verbatim
        // through the renderer's one error funnel.
        throw new Error(
          tr('err.pickShortfall', {
            name: item.name,
            asked: item.quantity,
            held: owned.quantity
          })
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
    return { pickListId, cardsRemoved, rowsDeleted, cardsFreedFromDecks }
  })
}

/**
 * Undoes a validated pull: every card goes back where it came from.
 *
 * The exact inverse of `confirmPickList`, which is why it can lean entirely on
 * the snapshot each staged row carries. That snapshot exists for precisely this
 * kind of reading — it still names the printing, finish and condition after the
 * collection row it came from has been emptied and deleted.
 *
 * Deliberately different from Ctrl+Z, and both are wanted: undo is session-only
 * and generic, this is an explicit action on a list you validated last week.
 *
 * The list returns to `open` rather than `cancelled`. Reverting undoes the
 * validate step, so the reservations come back with the cards and you can fix
 * the list and validate again, or cancel it — and cancelling is free.
 *
 * It refuses as a whole if a copy it needs to take back is no longer there.
 * Clamping would invent cards you do not have; a partial revert would leave the
 * books half-right, which is worse than leaving them alone.
 */
export function revertPickList(pickListId: number): {
  pickListId: number
  cardsRestored: number
  cardsReturnedToDecks: number
} {
  return transaction((db) => {
    const list = db.get('SELECT status FROM pick_lists WHERE id = ?', [pickListId]) as
      | { status: string }
      | undefined
    if (!list) throw new Error(tr('err.pickListNotFound'))
    if (list.status !== 'confirmed') throw new Error(tr('err.notConfirmed'))

    const items = db.all(
      `SELECT id, source_deck_id, source_oracle_id, quantity, scryfall_id, finish, condition,
              foil_treatment, COALESCE(proxied, 0) AS proxied, name, destination
       FROM pick_list_items WHERE pick_list_id = ?`,
      [pickListId]
    ) as {
      id: number
      source_deck_id: number | null
      source_oracle_id: string | null
      quantity: number
      scryfall_id: string
      finish: string
      condition: string
      foil_treatment: string | null
      proxied: number
      name: string
      destination: string | null
    }[]

    let cardsRestored = 0
    let cardsReturnedToDecks = 0

    for (const item of items) {
      if (item.source_deck_id !== null && item.source_oracle_id !== null) {
        /*
          Put the copies back in the deck.

          Where they come *from* depends on what validating did with them: a
          `collection` pull left them in the collection, so they are taken back out
          of it; a `gone` pull sent them away, so there is nothing to take and the
          deck simply gets them back.

          Done directly rather than by finding the ledger entry: the entry is keyed
          by deck and oracle, not by list, so a card pulled twice would be
          ambiguous — and the entry may already have been reconciled away by a sync.
        */
        if (item.destination !== 'gone') {
          const row = db.get(
            'SELECT id, quantity FROM collection_items WHERE scryfall_id = ? AND finish = ? AND condition = ?',
            [item.scryfall_id, item.finish, item.condition]
          ) as { id: number; quantity: number } | undefined
          if (!row || row.quantity < item.quantity) {
            throw new Error(
              tr('err.moveGone', { count: row?.quantity ?? 0, needed: item.quantity })
            )
          }
          if (row.quantity === item.quantity) {
            db.run('DELETE FROM collection_items WHERE id = ?', [row.id])
          } else {
            db.run('UPDATE collection_items SET quantity = ?, updated_at = ? WHERE id = ?', [
              row.quantity - item.quantity,
              nowIso(),
              row.id
            ])
          }
        }

        applyOneMove(db, item.source_deck_id, {
          oracle_id: item.source_oracle_id,
          scryfall_id: item.scryfall_id,
          finish: item.finish,
          quantity: item.quantity
        })
        // Cancel out the ledger entry this list produced, so the deck stops
        // reporting a divergence that no longer exists.
        db.run(
          `DELETE FROM deck_card_moves WHERE id IN (
             SELECT id FROM deck_card_moves
             WHERE deck_id = ? AND oracle_id = ? AND quantity = ?
             ORDER BY id DESC LIMIT 1
           )`,
          [item.source_deck_id, item.source_oracle_id, -item.quantity]
        )
        cardsReturnedToDecks += item.quantity
        continue
      }

      // A collection-sourced copy left your possession. The snapshot says exactly
      // what to put back, and addToCollection merges it onto the row that
      // survived or recreates the one that was emptied and deleted.
      addToCollection({
        scryfall_id: item.scryfall_id,
        finish: item.finish as Finish,
        condition: item.condition as Condition,
        quantity: item.quantity
      })
      cardsRestored += item.quantity

      // Re-link, so the reopened list reserves against a real row again rather
      // than reading as "row no longer in collection".
      const restored = db.get(
        'SELECT id FROM collection_items WHERE scryfall_id = ? AND finish = ? AND condition = ?',
        [item.scryfall_id, item.finish, item.condition]
      ) as { id: number } | undefined
      if (restored) {
        db.run('UPDATE pick_list_items SET collection_item_id = ? WHERE id = ?', [
          restored.id,
          item.id
        ])
        /*
          Restore the two facts that live on the row but not in the UNIQUE key
          addToCollection merges on. Without this, reverting a list that had
          emptied a row brings the copies back stripped of the foil type you had
          recorded and of their proxy flag — the row exists again but is no longer
          the row you had. Only written when the row was recreated by this revert
          (quantity now equals what was put back), so an existing row that already
          carries its own values is left alone.
        */
        const row = db.get('SELECT quantity FROM collection_items WHERE id = ?', [
          restored.id
        ]) as { quantity: number }
        if (row.quantity === item.quantity) {
          db.run('UPDATE collection_items SET foil_treatment = ?, proxied = ? WHERE id = ?', [
            item.foil_treatment,
            item.proxied,
            restored.id
          ])
        }
      }
    }

    db.run("UPDATE pick_lists SET status = 'open', closed_at = NULL WHERE id = ?", [pickListId])
    return { pickListId, cardsRestored, cardsReturnedToDecks }
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
