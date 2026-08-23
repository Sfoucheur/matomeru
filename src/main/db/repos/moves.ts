import { nowIso, transaction, type Sql } from '../connection.js'
import {
  DECK_FINISH,
  DECK_OVERRIDE_JOIN,
  DECK_PRINTING,
  applyOneMove,
  recordMove
} from './decks.js'
import { addToCollection } from './collection.js'
import { t } from '@shared/i18n/index'
import { getLocale } from './settings.js'
import type { Condition, Finish, TranslationKey } from '@shared/types'

/** Localised message, resolved at throw time from the stored locale. */
function tr(key: TranslationKey, vars?: Record<string, string | number>): string {
  return t(getLocale(), key, vars)
}

/**
 * Moving cards between a deck and the collection.
 *
 * Its own module because a move spans both tables and belongs to neither:
 * `collection.ts` already imports the deck expressions, so putting these in
 * `decks.ts` — which would then need `addToCollection` — makes the two import each
 * other.
 *
 * A move is immediate and loses nothing: the card is yours before and after, it has
 * only changed where it lives. That is what makes it a different act from a pick
 * list, which is for cards leaving your possession, and why deck cards do not go
 * into one.
 */

/**
 * Takes copies out of a deck and puts them in the collection.
 *
 * Immediate, and nothing is lost: the card is yours either way, it has only moved.
 * That is why this is not a pick list — a pick list is for cards leaving your
 * possession, and this leaves nothing.
 */
export function moveToCollection(
  deckId: number,
  oracleId: string,
  quantity: number
): { moved: number } {
  if (quantity <= 0) throw new Error(tr('err.quantityAtLeastOne'))
  return transaction((db) => {
    const entry = db.get(
      `SELECT ${DECK_PRINTING} AS scryfall_id, ${DECK_FINISH} AS finish,
              COALESCE(o.proxied, 0) AS proxied,
              o.foil_treatment AS foil_treatment,
              dc.label_possession AS label_possession,
              (SELECT COALESCE(SUM(quantity), 0) FROM deck_cards d2
               WHERE d2.deck_id = dc.deck_id AND d2.oracle_id = dc.oracle_id) AS held
       FROM deck_cards dc
       ${DECK_OVERRIDE_JOIN}
       WHERE dc.deck_id = ? AND dc.oracle_id = ? AND ${DECK_PRINTING} IS NOT NULL
       LIMIT 1`,
      [deckId, oracleId]
    ) as
      | {
          scryfall_id: string
          finish: string
          proxied: number
          foil_treatment: string | null
          label_possession: string | null
          held: number
        }
      | undefined
    if (!entry) throw new Error(tr('err.itemNotFound'))
    if (entry.label_possession !== 'owned') throw new Error(tr('err.moveNotOwned'))
    /*
      A proxy cannot become a collection row: `collection_items` is UNIQUE on
      (scryfall_id, finish, condition) and does not include `proxied`, so it would
      merge into your real copies of the same printing and mark those as proxies
      too — quietly zeroing the value of cards you own.
    */
    if (entry.proxied === 1) throw new Error(tr('err.moveProxy'))
    // Re-checked here rather than trusted from the UI, which may be looking at a
    // stale row.
    if (entry.held < quantity) {
      throw new Error(tr('err.moveShortfall', { held: entry.held, asked: quantity }))
    }

    recordMove(db, {
      deckId,
      oracleId,
      scryfallId: entry.scryfall_id,
      finish: entry.finish,
      condition: 'NM',
      quantity: -quantity,
      foilTreatment: entry.foil_treatment
    })
    applyOneMove(db, deckId, {
      oracle_id: oracleId,
      scryfall_id: entry.scryfall_id,
      finish: entry.finish,
      quantity: -quantity
    })
    const itemId = addToCollection({
      scryfall_id: entry.scryfall_id,
      finish: entry.finish as Finish,
      condition: 'NM',
      quantity
    })
    /*
      `addToCollection` merges on (scryfall_id, finish, condition) and knows nothing
      about treatments, so a correction you had made on the deck side would arrive
      as null and fall back to whatever the printing's own tags imply. Only written
      when there is one to carry, so it never clears a treatment the destination row
      already had.
    */
    if (entry.foil_treatment !== null) {
      db.run('UPDATE collection_items SET foil_treatment = ? WHERE id = ?', [
        entry.foil_treatment,
        itemId
      ])
    }
    return { moved: quantity }
  })
}

/**
 * Takes copies out of the collection and puts them in a deck.
 *
 * The deck need not list the card: you can put anything you own into a deck, and
 * the row is created if the decklist has never mentioned it. The printing that goes
 * in is *yours* — moving a Japanese copy into a deck that lists the English one
 * records your printing, which DECK_PRINTING then resolves everywhere.
 */
export function moveToDeck(
  deckId: number,
  itemId: number,
  quantity: number
): { moved: number } {
  if (quantity <= 0) throw new Error(tr('err.quantityAtLeastOne'))
  return transaction((db) => {
    const deck = db.get('SELECT id FROM decks WHERE id = ?', [deckId]) as { id: number } | undefined
    if (!deck) throw new Error(tr('err.deckNotFound'))

    const row = db.get(
      `SELECT ci.id, ci.quantity, ci.scryfall_id, ci.finish, ci.condition, ci.proxied,
              ci.foil_treatment, p.oracle_id, p.lang,
              (SELECT COALESCE(SUM(pli.quantity), 0)
               FROM pick_list_items pli JOIN pick_lists pl ON pl.id = pli.pick_list_id
               WHERE pli.collection_item_id = ci.id AND pl.status = 'open') AS reserved
       FROM collection_items ci
       JOIN printings p ON p.scryfall_id = ci.scryfall_id
       WHERE ci.id = ?`,
      [itemId]
    ) as
      | {
          id: number
          quantity: number
          scryfall_id: string
          finish: string
          condition: string
          proxied: number
          foil_treatment: string | null
          oracle_id: string | null
          lang: string
          reserved: number
        }
      | undefined
    if (!row) throw new Error(tr('err.itemNotFound'))
    if (!row.oracle_id) throw new Error(tr('err.itemNotFound'))
    /*
      Reserved copies are promised to an open pick list — that is, to leaving your
      possession. Moving them into a deck would quietly break that promise, so the
      list has to be settled first.
    */
    if (row.quantity - row.reserved < quantity) {
      throw new Error(
        tr('err.moveShortfall', { held: row.quantity - row.reserved, asked: quantity })
      )
    }

    /*
      A proxy has to stay worth nothing.

      `row.proxied` was read and then ignored, so moving a printed copy into a deck
      produced an ordinary entry and a card worth 0 started carrying its market
      price — in `held`, in the deck totals and in Stats.

      The deck stores this per (deck, oracle) in `deck_card_overrides`, which is the
      same ambiguity that makes the other direction refuse: if the deck already
      holds real copies of the card, marking the entry proxied would mislabel them.
      So it is carried when this creates the entry, and refused when it would lie
      about copies that are already there.
    */
    if (row.proxied === 1) {
      const alreadyThere = (
        db.get(
          'SELECT COALESCE(SUM(quantity), 0) AS quantity FROM deck_cards WHERE deck_id = ? AND oracle_id = ?',
          [deckId, row.oracle_id]
        ) as { quantity: number }
      ).quantity
      if (alreadyThere > 0) throw new Error(tr('err.moveProxyMixes'))
    }

    if (row.quantity === quantity) db.run('DELETE FROM collection_items WHERE id = ?', [row.id])
    else {
      db.run('UPDATE collection_items SET quantity = ?, updated_at = ? WHERE id = ?', [
        row.quantity - quantity,
        nowIso(),
        row.id
      ])
    }

    recordMove(db, {
      deckId,
      oracleId: row.oracle_id,
      scryfallId: row.scryfall_id,
      finish: row.finish,
      condition: row.condition,
      quantity,
      foilTreatment: row.foil_treatment
    })
    applyOneMove(db, deckId, {
      oracle_id: row.oracle_id,
      scryfall_id: row.scryfall_id,
      finish: row.finish,
      quantity
    })

    /*
      Carry the two facts `deck_cards` cannot hold itself. Both live in the override
      table on the deck side, which is where the deck screen already reads them from,
      so nothing else has to learn about moves to display them correctly.
    */
    if (row.proxied === 1 || row.foil_treatment !== null) {
      db.run(
        `INSERT INTO deck_card_overrides
           (deck_id, oracle_id, scryfall_id, lang, proxied, foil_treatment, created_at)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(deck_id, oracle_id) DO UPDATE SET
           proxied = COALESCE(excluded.proxied, proxied),
           foil_treatment = COALESCE(excluded.foil_treatment, foil_treatment)`,
        [
          deckId,
          row.oracle_id,
          row.scryfall_id,
          row.lang,
          row.proxied === 1 ? 1 : null,
          row.foil_treatment,
          nowIso()
        ]
      )
    }
    return { moved: quantity }
  })
}

/** Undoes one move, whichever way it went. */
export function revertMove(moveId: number): { deckId: number; quantity: number } {
  return transaction((db) => revertMoveIn(db, moveId))
}

/**
 * The body of a revert, without opening a transaction.
 *
 * It refuses rather than clamps when the copies are no longer where it would take
 * them from: putting a card back in a deck when you have since sold it would be
 * claiming a card that does not exist.
 */
export function revertMoveIn(db: Sql, moveId: number): { deckId: number; quantity: number } {
  const move = db.get(
    `SELECT id, deck_id, oracle_id, scryfall_id, finish, condition, quantity,
            foil_treatment
     FROM deck_card_moves WHERE id = ?`,
    [moveId]
  ) as
    | {
        id: number
        deck_id: number
        oracle_id: string
        scryfall_id: string
        finish: string
        condition: string
        quantity: number
        foil_treatment: string | null
      }
    | undefined
  if (!move) throw new Error(tr('err.moveNotFound'))

  if (move.quantity < 0) {
    // It went deck -> collection, so put it back: take the copies out of the
    // collection and return them to the deck.
    const size = -move.quantity
    const row = db.get(
      'SELECT id, quantity FROM collection_items WHERE scryfall_id = ? AND finish = ? AND condition = ?',
      [move.scryfall_id, move.finish, move.condition]
    ) as { id: number; quantity: number } | undefined
    if (!row || row.quantity < size) {
      throw new Error(tr('err.moveGone', { count: row?.quantity ?? 0, needed: size }))
    }
    if (row.quantity === size) db.run('DELETE FROM collection_items WHERE id = ?', [row.id])
    else {
      db.run('UPDATE collection_items SET quantity = ?, updated_at = ? WHERE id = ?', [
        row.quantity - size,
        nowIso(),
        row.id
      ])
    }
    applyOneMove(db, move.deck_id, { ...move, oracle_id: move.oracle_id, quantity: size })
  } else {
    // It went collection -> deck: take it back out of the deck and return it.
    const held = (
      db.get(
        'SELECT COALESCE(SUM(quantity), 0) AS quantity FROM deck_cards WHERE deck_id = ? AND oracle_id = ?',
        [move.deck_id, move.oracle_id]
      ) as { quantity: number }
    ).quantity
    if (held < move.quantity) {
      throw new Error(tr('err.moveGone', { count: held, needed: move.quantity }))
    }
    applyOneMove(db, move.deck_id, { ...move, quantity: -move.quantity })
    const back = addToCollection({
      scryfall_id: move.scryfall_id,
      finish: move.finish as Finish,
      condition: move.condition as Condition,
      quantity: move.quantity
    })
    // The treatment the copies carried when they left, so undoing a move really
    // does put the card back as it was.
    if (move.foil_treatment !== null) {
      db.run('UPDATE collection_items SET foil_treatment = ? WHERE id = ?', [
        move.foil_treatment,
        back
      ])
    }
  }

  db.run('DELETE FROM deck_card_moves WHERE id = ?', [moveId])

  /*
    An empty slot is only worth keeping while something wants the card there.

    `applyOneMove` deliberately leaves an emptied row at quantity 0, because a
    decklist entry the deck cannot fill is the fact the deck screen exists to show,
    and it is what you click to undo the move. Neither is true here: undoing a move
    *into* a deck can empty a row the move itself invented, for a card the decklist
    never mentioned and with no move left to undo. That row is a phantom entry, so
    it goes -- but only once no move for this card remains, since a standing
    move-out still needs its slot to hang the tag on.
  */
  const stillMoved = (
    db.get(
      'SELECT COUNT(*) AS n FROM deck_card_moves WHERE deck_id = ? AND oracle_id = ?',
      [move.deck_id, move.oracle_id]
    ) as { n: number }
  ).n
  if (stillMoved === 0) {
    db.run('DELETE FROM deck_cards WHERE deck_id = ? AND oracle_id = ? AND quantity = 0', [
      move.deck_id,
      move.oracle_id
    ])
  }

  return { deckId: move.deck_id, quantity: Math.abs(move.quantity) }
}
