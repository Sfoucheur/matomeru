import { getDb } from './connection.js'
import { wholeTable, type UndoScope } from './undo.js'

/**
 * Which rows each undoable action can touch.
 *
 * A before/after journal only fails in one way: a scope too narrow to cover the
 * action, which loses part of the change silently. These live in their own module
 * rather than beside the IPC handlers so that `scripts/verify.ts` can drive its
 * property test through the *same* builders the handlers use. It could not before,
 * so it restated the scopes by hand — and passed, while
 * `pickListScopes` named its tables in an order that made every undo of a
 * validated pick list fail with a foreign-key error.
 *
 * **Scope order is dependency order.** `undo.ts` restores parents before children,
 * so a table must come before anything that references it. The restore also defers
 * foreign keys to the end of its transaction, so ordering is no longer load-bearing
 * for correctness — but stating it correctly is how the declaration stays readable.
 */

/**
 * Adds the tables a cascade reaches from `collection_items`.
 *
 * `pick_list_items.collection_item_id` is `ON DELETE SET NULL`, so deleting a
 * collection row silently rewrites rows in a table the action never mentioned. An
 * undo that has not captured them cannot put the link back, and the link is gone
 * for good — which is exactly what happened: moving the last copy of a card into a
 * deck deleted its collection row, nulled a confirmed list's link to it, and
 * Ctrl+Z could not restore either.
 *
 * `removeItem` refuses when an *open* list holds copies, but a *confirmed* list's
 * link is nulled deliberately — the snapshot carries on without it — so the cascade
 * is reachable by design and every scope over `collection_items` has to allow for
 * it. Whole-table because the table is small and the alternative is remembering
 * this at five call sites.
 */
export function withPickItems(...scopes: UndoScope[]): UndoScope[] {
  return [...scopes, wholeTable('pick_list_items')]
}

/** The UNIQUE key a collection row merges on, for an add that has no row yet. */
export function collectionKeyScope(input: {
  scryfall_id: string
  finish: string
  condition: string
}): UndoScope {
  return {
    table: 'collection_items',
    where: 'scryfall_id = ? AND finish = ? AND condition = ?',
    params: [input.scryfall_id, input.finish, input.condition]
  }
}

/** A scope that deliberately selects nothing, for a subject that has gone. */
const nothing = (table: string): UndoScope => ({ table, where: '1 = 0', params: [] })

/**
 * Every row of the printing a collection row belongs to.
 *
 * Editing a copy's finish or condition moves it across its own UNIQUE key, so it
 * can merge into a sibling row and delete itself. Scoping only the id being edited
 * would miss the sibling, and undo would restore the edited row while leaving the
 * merged copies behind — the card count would come out wrong.
 */
export function scryfallScope(itemId: number): UndoScope {
  const row = getDb().get('SELECT scryfall_id FROM collection_items WHERE id = ?', [itemId]) as
    | { scryfall_id: string }
    | undefined
  return row
    ? { table: 'collection_items', where: 'scryfall_id = ?', params: [row.scryfall_id] }
    : nothing('collection_items')
}

/** The same, for a bulk edit across several rows. */
export function scryfallScopeMany(itemIds: number[]): UndoScope {
  if (itemIds.length === 0) return nothing('collection_items')
  const rows = getDb().all(
    `SELECT DISTINCT scryfall_id FROM collection_items WHERE id IN (${itemIds
      .map(() => '?')
      .join(', ')})`,
    itemIds
  ) as { scryfall_id: string }[]
  if (rows.length === 0) return nothing('collection_items')
  return {
    table: 'collection_items',
    where: `scryfall_id IN (${rows.map(() => '?').join(', ')})`,
    params: rows.map((r) => r.scryfall_id)
  }
}

/**
 * Everything validating, reverting or deleting a pick list can touch.
 *
 * Ordered parents first: `pick_list_items` references both `collection_items` and
 * `pick_lists`, and `deck_card_moves` references `pick_lists`, so those three come
 * before it.
 *
 * `collection_items` is scoped on the printings the list names rather than on ids,
 * because a row the confirm empties is deleted and comes back from a revert with a
 * new id — an id-based scope would not see it return. The list and its items are
 * whole tables: deleting a list cascades to its items, and the ids involved are
 * gone by the time the after-image is taken.
 */
export function pickListScopes(pickListId: number): UndoScope[] {
  const printings = getDb().all(
    'SELECT DISTINCT scryfall_id FROM pick_list_items WHERE pick_list_id = ?',
    [pickListId]
  ) as { scryfall_id: string }[]

  /*
    The decks the list pulls from.

    Validating a deck-sourced pull takes the copies off the deck row, so those rows
    change and have to be captured — without this, undoing a validated pull put the
    card back in the collection and left the deck still missing it, which is the bug
    that turned up in use. Scoped to the decks the list actually names rather than
    the whole table: a deck has hundreds of rows and most lists touch none of them.
  */
  const decks = getDb().all(
    'SELECT DISTINCT source_deck_id FROM pick_list_items WHERE pick_list_id = ? AND source_deck_id IS NOT NULL',
    [pickListId]
  ) as { source_deck_id: number }[]
  const deckScopes: UndoScope[] = decks.length
    ? [
        {
          table: 'deck_cards',
          where: `deck_id IN (${decks.map(() => '?').join(', ')})`,
          params: decks.map((d) => d.source_deck_id)
        }
      ]
    : []

  return [
    ...deckScopes,
    printings.length
      ? {
          table: 'collection_items',
          where: `scryfall_id IN (${printings.map(() => '?').join(', ')})`,
          params: printings.map((r) => r.scryfall_id)
        }
      : nothing('collection_items'),
    wholeTable('pick_lists'),
    wholeTable('deck_card_moves'),
    wholeTable('pick_list_items')
  ]
}

/**
 * Everything a move between a deck and the collection touches.
 *
 * `collection_items` as a whole table, because a move can create a row that did
 * not exist and delete one that hits zero, and the printing involved is not known
 * from the arguments in both directions. `deck_cards` scoped to the deck when there
 * is one — a revert is addressed by move id, which does not name a deck, so it takes
 * the wider scope.
 */
export function moveScopes(deckId: number | null): UndoScope[] {
  return withPickItems(
    wholeTable('collection_items'),
    deckId === null
      ? wholeTable('deck_cards')
      : { table: 'deck_cards', where: 'deck_id = ?', params: [deckId] },
    wholeTable('deck_card_moves'),
    /*
      What the copies in an entry are, which a move now writes: moving a proxy into a
      deck records it against that entry, and an undo has to take it back off. Whole
      table for the reason the others are -- the rows a move touches are not knowable
      from a deck id, and the table holds a handful of rows.
    */
    wholeTable('deck_entry_traits')
  )
}

/**
 * A deck's override rows, plus the miss table that travels with them.
 *
 * Scoped per deck rather than per card: `clearCardOverride` also clears a language
 * request, and setting a language can create either, so naming both tables is what
 * makes the pair undoable together.
 */
export function deckOverrideScopes(deckId: number): UndoScope[] {
  return [
    { table: 'deck_card_overrides', where: 'deck_id = ?', params: [deckId] },
    { table: 'deck_card_lang_requests', where: 'deck_id = ?', params: [deckId] }
  ]
}
