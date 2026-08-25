import { getDb, nowIso, transaction, type Sql } from '../connection.js'
import { priceExpr, priceIsProxyExpr } from './printings.js'
import { parseLabel } from '../../archidekt/mappers.js'
import { allocateCopies, foilTreatmentOf } from '@shared/types'
import type {
  Currency,
  Deck,
  DeckBreakdown,
  DeckCardRow,
  DeckGroup,
  DeckLabelColor,
  DeckMove,
  DeckSource,
  DeckTotals,
  Finish,
  Possession,
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
 * Deck data is a read-only reference overlay. Nothing in this module writes to
 * collection_items — Archidekt decks list cards you may not own, so a sync must
 * never change what the app thinks is in your collection.
 */

/**
 * The printing a deck entry actually holds, and the join that resolves it.
 *
 * A language override replaces the printing Archidekt reported, so *every* query
 * that answers "which card is in this deck" has to resolve through it — the deck
 * screen, the derived collection rows, the stats totals and the location answers.
 * Exported as one pair of fragments because four places used to read
 * `dc.scryfall_id` directly, and the Collection screen went on showing the
 * English printing after a deck had been switched to French.
 *
 * Requires the deck_cards alias to be `dc` and leaves the override alias as `o`.
 */
export const DECK_OVERRIDE_JOIN = `
  LEFT JOIN deck_card_overrides o
         ON o.deck_id = dc.deck_id AND o.oracle_id = dc.oracle_id`

export const DECK_PRINTING = 'COALESCE(o.scryfall_id, dc.scryfall_id)'

/*
  What the copies in *this* entry are.

  Joined on the entry's own printing, which is the whole point: a deck can hold two
  printings of one card, and a proxy in one of them says nothing about the other. See
  migration 18.

  Every reader goes through these three, in five files, so none of them can drift back
  to reading the flag for the whole card.
*/
export const DECK_TRAITS_JOIN = `
  LEFT JOIN deck_entry_traits tr
         ON tr.deck_id = dc.deck_id
        AND tr.oracle_id = dc.oracle_id
        AND tr.scryfall_id = dc.scryfall_id`

export const DECK_PROXIED = 'COALESCE(tr.proxied, 0)'

export const DECK_TREATMENT = 'tr.foil_treatment'

/**
 * The finish a deck entry is actually held in.
 *
 * `deck_cards.finish` is whatever Archidekt's `modifier` said, and
 * `replaceDeckCards` deletes and reinserts every row on each sync — so a value
 * you set by hand can only survive in the override table, exactly like
 * `forced_lang`. Every query that reports a deck card's finish resolves through
 * this, for the same reason DECK_PRINTING exists: the deck screen, the derived
 * collection rows and the stats totals must not disagree.
 *
 * Same alias requirements as DECK_PRINTING: `dc` and `o`.
 */
export const DECK_FINISH = 'COALESCE(o.finish, dc.finish)'


export interface DeckUpsert {
  external_id: string
  name: string
  format: string | null
  owner_username: string | null
  url: string | null
  external_updated_at: string | null
  is_private: boolean
  is_unlisted: boolean
  raw?: unknown
}

export interface DeckCardUpsert {
  scryfall_id: string | null
  oracle_id: string | null
  quantity: number
  finish: Finish
  categories: string[]
  in_maindeck: boolean
  name: string
  lang: string
  set_code: string | null
  collector_number: string | null
  rarity: string | null
  image_uri_small: string | null
  /** Archidekt's raw `"name,#color"` label string. */
  label: string | null
}

/*
  `cardCount` below deliberately sums the raw `dc.quantity`, not the pull-adjusted
  quantity.

  It answers "how big is this decklist", which is a fact about the deck as
  Archidekt describes it — a 100-card Commander deck is still a 100-card deck
  while one of its cards is sitting in your trade box. What you physically hold
  for it is `held`, reported per card, and the hole is reported by the pull badge.
  Subtracting here would make the deck list say 99 and invite the question of
  which card was missing, which the deck screen already answers better.
*/
export function listDecks(): Deck[] {
  return (
    getDb().all(
      `SELECT d.id, d.source, d.external_id, d.name, d.format, d.owner_username, d.url,
              d.external_updated_at, d.last_synced_at, d.is_private, d.is_unlisted, d.sync_error,
              d.default_lang,
              (SELECT COALESCE(SUM(dc.quantity), 0) FROM deck_cards dc WHERE dc.deck_id = d.id) AS cardCount
       FROM decks d
       ORDER BY d.name COLLATE NOCASE`
    ) as (Omit<Deck, 'is_private' | 'is_unlisted'> & { is_private: number; is_unlisted: number })[]
  ).map((row) => ({ ...row, is_private: !!row.is_private, is_unlisted: !!row.is_unlisted }))
}

export function getDeck(deckId: number): Deck | null {
  const row = getDb().get(
    `SELECT d.id, d.source, d.external_id, d.name, d.format, d.owner_username, d.url,
            d.external_updated_at, d.last_synced_at, d.is_private, d.is_unlisted, d.sync_error,
            d.default_lang,
            (SELECT COALESCE(SUM(dc.quantity), 0) FROM deck_cards dc WHERE dc.deck_id = d.id) AS cardCount
     FROM decks d WHERE d.id = ?`,
    [deckId]
  ) as (Omit<Deck, 'is_private' | 'is_unlisted'> & { is_private: number; is_unlisted: number }) | undefined
  return row ? { ...row, is_private: !!row.is_private, is_unlisted: !!row.is_unlisted } : null
}

export function findDeckByExternalId(externalId: string): Deck | null {
  const row = getDb().get(
    "SELECT id FROM decks WHERE source = 'archidekt' AND external_id = ?",
    [externalId]
  ) as { id: number } | undefined
  return row ? getDeck(row.id) : null
}

/** Local ISO timestamp of the last successful sync, used to skip unchanged decks. */
export function deckSyncState(externalId: string): { external_updated_at: string | null } | null {
  return (
    (getDb().get(
      "SELECT external_updated_at FROM decks WHERE source = 'archidekt' AND external_id = ? AND sync_error IS NULL",
      [externalId]
    ) as { external_updated_at: string | null } | undefined) ?? null
  )
}

export function upsertDeck(deck: DeckUpsert): number {
  const db = getDb()
  db.run(
    `INSERT INTO decks (
       source, external_id, name, format, owner_username, url, external_updated_at,
       last_synced_at, is_private, is_unlisted, sync_error, raw_json
     ) VALUES ('archidekt',?,?,?,?,?,?,?,?,?,NULL,?)
     ON CONFLICT(source, external_id) DO UPDATE SET
       name = excluded.name,
       format = excluded.format,
       owner_username = excluded.owner_username,
       url = excluded.url,
       external_updated_at = excluded.external_updated_at,
       last_synced_at = excluded.last_synced_at,
       is_private = excluded.is_private,
       is_unlisted = excluded.is_unlisted,
       sync_error = NULL,
       raw_json = excluded.raw_json`,
    [
      deck.external_id,
      deck.name,
      deck.format,
      deck.owner_username,
      deck.url,
      deck.external_updated_at,
      nowIso(),
      deck.is_private ? 1 : 0,
      deck.is_unlisted ? 1 : 0,
      deck.raw ? JSON.stringify(deck.raw) : null
    ]
  )
  const row = db.get(
    "SELECT id FROM decks WHERE source = 'archidekt' AND external_id = ?",
    [deck.external_id]
  ) as { id: number }
  return row.id
}

/** Replaces a deck's card rows wholesale — decks are snapshots, not deltas. */
export function replaceDeckCards(deckId: number, cards: DeckCardUpsert[]): void {
  transaction((db) => {
    db.run('DELETE FROM deck_cards WHERE deck_id = ?', [deckId])
    for (const card of cards) {
      db.run(
        `INSERT INTO deck_cards (
           deck_id, scryfall_id, oracle_id, quantity, finish, categories, in_maindeck,
           name, lang, set_code, collector_number, rarity, image_uri_small, label
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          deckId,
          card.scryfall_id,
          card.oracle_id,
          card.quantity,
          card.finish,
          JSON.stringify(card.categories),
          card.in_maindeck ? 1 : 0,
          card.name,
          card.lang,
          card.set_code,
          card.collector_number,
          card.rarity,
          card.image_uri_small,
          card.label
        ]
      )
    }
    /*
      The decklist is back to what Archidekt says; put the local moves on top, so
      the rows describe what the deck physically holds again.

      Here rather than after the sync's label recompute, because this is the only
      place that knows the rows are pristine — applying a move twice would double
      it, and a sync leaves unchanged decks alone.
    */
    applyDeckMoves(db, deckId)
  })
}

/**
 * Re-applies this deck's local moves on top of what Archidekt just said.
 *
 * `replaceDeckCards` has wiped and rebuilt the rows from the decklist, so at this
 * point `deck_cards` is Archidekt's view. This brings it back to what the deck
 * physically holds, and drops any marker Archidekt has caught up with.
 *
 * Deliberately **not idempotent**: it applies every move to a pristine list, so it
 * is only ever correct immediately after `replaceDeckCards`. Running it twice would
 * apply the moves twice. That is the price of materialising instead of adjusting at
 * read time, and it is worth paying — the alternative threaded an adjustment
 * through 27 queries, two of which I missed.
 *
 * Reconciliation is one rule for both directions, which is the point of a signed
 * quantity: measure how far Archidekt has moved toward the marker since the move
 * was made, and take that much off the marker.
 */
export function applyDeckMoves(db: Sql, deckId: number): void {
  const moves = db.all(
    `SELECT id, oracle_id, scryfall_id, finish, condition, quantity, deck_quantity_at_move
     FROM deck_card_moves WHERE deck_id = ? ORDER BY id`,
    [deckId]
  ) as {
    id: number
    oracle_id: string
    scryfall_id: string
    finish: string
    condition: string
    quantity: number
    deck_quantity_at_move: number
  }[]

  for (const move of moves) {
    const listed = (
      db.get(
        'SELECT COALESCE(SUM(quantity), 0) AS quantity FROM deck_cards WHERE deck_id = ? AND oracle_id = ?',
        [deckId, move.oracle_id]
      ) as { quantity: number }
    ).quantity

    /*
      How far the decklist has travelled toward this move. For a move out
      (negative) the deck shrinking is progress; for a move in, growing is. Signed
      arithmetic makes both the same subtraction.
    */
    const travelled = move.quantity < 0
      ? move.deck_quantity_at_move - listed
      : listed - move.deck_quantity_at_move
    const size = Math.abs(move.quantity)

    if (travelled >= size) {
      // Archidekt has caught up: the decklist already says what the deck holds.
      db.run('DELETE FROM deck_card_moves WHERE id = ?', [move.id])
      continue
    }

    const remaining = size - Math.max(0, travelled)
    if (travelled > 0) {
      db.run(
        'UPDATE deck_card_moves SET quantity = ?, deck_quantity_at_move = ? WHERE id = ?',
        [move.quantity < 0 ? -remaining : remaining, listed, move.id]
      )
    }
    applyOneMove(db, deckId, { ...move, quantity: move.quantity < 0 ? -remaining : remaining })
  }

  /*
    And once the ledger is back on top of the decklist, anything it invented and then
    cancelled goes. Without this a phantom entry returns on every sync: the two moves
    that cancel are still in the ledger and replaying them recreates the row.
  */
  for (const oracleId of new Set(moves.map((m) => m.oracle_id))) {
    pruneEmptyEntries(db, deckId, oracleId)
  }
}

/**
 * Moves copies into or out of `deck_cards` for one marker.
 *
 * Taking copies out walks the oracle's rows in order, so a card the deck lists
 * under two printings loses the right number in total rather than that many from
 * each — the mistake the read-time version made, where one pulled copy emptied two
 * slots.
 */
export function applyOneMove(
  db: Sql,
  deckId: number,
  move: {
    oracle_id: string
    scryfall_id: string
    finish: string
    quantity: number
    /** The entry the copies belong to, when it is not the copies' own printing. */
    entry_scryfall_id?: string | null
  }
): void {
  const entry = move.entry_scryfall_id ?? move.scryfall_id
  if (move.quantity < 0) {
    let owed = -move.quantity
    /*
      The entry the copies came out of first, then the rest.

      Ordering by id alone took them from whichever row happened to be older, so
      removing one printing of a card could empty the other -- and then the tag saying
      the deck no longer matches the decklist hung on a row that had lost nothing. The
      fallback stays: Archidekt may have re-pointed the entry since, and the copies have
      to come from somewhere.
    */
    const rows = db.all(
      `SELECT id, quantity FROM deck_cards
        WHERE deck_id = ? AND oracle_id = ?
        ORDER BY (scryfall_id = ?) DESC, id`,
      [deckId, move.oracle_id, entry]
    ) as { id: number; quantity: number }[]
    for (const row of rows) {
      if (owed <= 0) break
      const take = Math.min(owed, row.quantity)
      owed -= take
      /*
        The row stays even when it empties, at quantity 0.

        Deleting it looked tidier and was wrong: moving the last copy out of a deck
        left the deck screen with no row to hang the "out of this deck" tag on, so
        the one fact worth reporting — that the decklist wants a card the deck does
        not have — became invisible, and there was nothing left to click to undo the
        move. An empty slot is information.

        Rows at 0 are excluded from the derived collection rows, so this cannot
        become a phantom holding.
      */
      db.run('UPDATE deck_cards SET quantity = ? WHERE id = ?', [row.quantity - take, row.id])
    }
    return
  }

  /*
    Putting copies in. An existing row for the same printing is topped up;
    otherwise a row is created, because you can move a card into a deck whose
    decklist has never mentioned it.

    `label_possession` is set explicitly and this is load-bearing: it is a card you
    physically put there, so it has to count as held, and a row created here has no
    Archidekt label for `recomputeLabelPossession` to derive one from. That is also
    why this runs *after* the recompute — the recompute clears every row's flag.
  */
  const existing = db.get(
    'SELECT id, quantity FROM deck_cards WHERE deck_id = ? AND scryfall_id = ? ORDER BY id LIMIT 1',
    [deckId, move.scryfall_id]
  ) as { id: number; quantity: number } | undefined

  if (existing) {
    db.run(
      "UPDATE deck_cards SET quantity = ?, label_possession = 'owned' WHERE id = ?",
      [existing.quantity + move.quantity, existing.id]
    )
    return
  }

  const printing = db.get(
    `SELECT name, lang, set_code, collector_number, rarity, image_uri_small
     FROM printings WHERE scryfall_id = ?`,
    [move.scryfall_id]
  ) as
    | {
        name: string
        lang: string
        set_code: string | null
        collector_number: string | null
        rarity: string | null
        image_uri_small: string | null
      }
    | undefined
  if (!printing) throw new Error(tr('err.itemNotFound'))

  db.run(
    `INSERT INTO deck_cards (
       deck_id, scryfall_id, oracle_id, quantity, finish, categories, in_maindeck,
       name, lang, set_code, collector_number, rarity, image_uri_small, label,
       label_possession
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'owned')`,
    [
      deckId,
      move.scryfall_id,
      move.oracle_id,
      move.quantity,
      move.finish,
      // No Archidekt category, so it lands in the deck's default group rather
      // than inventing one.
      JSON.stringify([]),
      1,
      printing.name,
      printing.lang,
      printing.set_code,
      printing.collector_number,
      printing.rarity,
      printing.image_uri_small,
      null
    ]
  )
}

export function recordDeckError(externalId: string, meta: Partial<DeckUpsert>, error: string): void {
  const db = getDb()
  db.run(
    `INSERT INTO decks (source, external_id, name, format, owner_username, url,
       external_updated_at, last_synced_at, is_private, is_unlisted, sync_error)
     VALUES ('archidekt',?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(source, external_id) DO UPDATE SET
       sync_error = excluded.sync_error,
       last_synced_at = excluded.last_synced_at,
       is_private = excluded.is_private`,
    [
      externalId,
      meta.name ?? `Deck ${externalId}`,
      meta.format ?? null,
      meta.owner_username ?? null,
      meta.url ?? `https://archidekt.com/decks/${externalId}`,
      meta.external_updated_at ?? null,
      nowIso(),
      meta.is_private ? 1 : 0,
      meta.is_unlisted ? 1 : 0,
      error
    ]
  )
}

export function deleteDeck(deckId: number): void {
  getDb().run('DELETE FROM decks WHERE id = ?', [deckId])
}

/**
 * The two things a deck's category list tells us: which categories are premier
 * (its commander, Oathbreaker, and so on) and which count towards the deck.
 *
 * Read from the stored deck JSON rather than a column, because `isPremier` and
 * `includedInDeck` are already in there: that means commanders resolve on decks
 * synced before this feature existed, with no migration and no re-sync. Parsed
 * once — it used to be parsed twice per breakdown, for one answer each.
 */
interface DeckCategoryMeta {
  premier: Set<string>
  categoryInDeck: Map<string, boolean>
}

function deckCategoryMeta(deckId: number): DeckCategoryMeta {
  const meta: DeckCategoryMeta = { premier: new Set(), categoryInDeck: new Map() }
  const row = getDb().get('SELECT raw_json FROM decks WHERE id = ?', [deckId]) as
    | { raw_json: string | null }
    | undefined
  if (!row?.raw_json) return meta
  try {
    const parsed = JSON.parse(row.raw_json) as {
      categories?: { name?: string; isPremier?: boolean; includedInDeck?: boolean }[] | null
    }
    for (const category of parsed.categories ?? []) {
      if (typeof category?.name !== 'string') continue
      if (category.isPremier) meta.premier.add(category.name)
      meta.categoryInDeck.set(category.name, category.includedInDeck !== false)
    }
  } catch {
    /* fall back to the per-card in_maindeck flag */
  }
  return meta
}

/**
 * A deck grouped the way Archidekt presents it, with card-accurate totals.
 *
 * `exactOnly` decides whether owning the Japanese printing counts as owning a
 * card the deck lists in English: with it on, only the identical printing
 * counts; with it off, any language of the same card does.
 */
export function deckBreakdown(
  deckId: number,
  currency: Currency,
  exactOnly: boolean
): DeckBreakdown | null {
  const deck = getDeck(deckId)
  if (!deck) return null

  const db = getDb()
  // Price what the entry is actually held in. This used to be hardcoded nonfoil
  // because a deck card's finish was unsettable and Archidekt's value untrusted;
  // now that it can be corrected, a foil copy should be valued as one.
  const price = priceExpr(currency, DECK_FINISH)
  const proxy = priceIsProxyExpr(currency, DECK_FINISH)
  const { premier, categoryInDeck } = deckCategoryMeta(deckId)

  const rows = db.all(
    `SELECT dc.id, dc.deck_id, dc.quantity,
            ${DECK_FINISH} AS finish,
            o.finish AS override_finish,
            ${DECK_TREATMENT} AS override_treatment,
            ${DECK_PROXIED} AS proxied,
            p.promo_types AS promo_types,
            dc.categories, dc.in_maindeck, dc.set_code,
            dc.collector_number, dc.image_uri_small, dc.label, dc.label_possession,
            dc.oracle_id,
            -- An override replaces the printing entirely: Archidekt can only ever
            -- report the English one, so this is how a French copy is recorded.
            COALESCE(o.scryfall_id, dc.scryfall_id) AS scryfall_id,
            o.lang AS override_lang,
            o.forced_lang AS forced_lang,
            -- A language you asked for that has no printing. Recorded per card,
            -- so a card nobody asked about is never flagged.
            lr.requested_lang AS language_unavailable,
            COALESCE(o.forced_name, p.printed_name, p.name, dc.name) AS name,
            COALESCE(o.forced_lang, p.lang, dc.lang) AS lang,
            COALESCE(p.rarity, dc.rarity) AS rarity,
            p.cmc AS cmc,
            p.color_identity AS color_identity,
            COALESCE(p.printed_type_line, p.type_line) AS type_line,
            -- What the tile needs to draw a two-sided card as two cards.
            p.layout AS layout,
            ${price} AS unit_value,
            ${proxy} AS price_is_proxy,
            COALESCE((SELECT SUM(ci.quantity) FROM collection_items ci
                      WHERE ci.scryfall_id = COALESCE(o.scryfall_id, dc.scryfall_id)), 0) AS owned_exact,
            COALESCE((SELECT SUM(ci.quantity) FROM collection_items ci
                      JOIN printings p2 ON p2.scryfall_id = ci.scryfall_id
                      WHERE dc.oracle_id IS NOT NULL AND p2.oracle_id = dc.oracle_id), 0) AS owned_any,
            /*
              The net local divergence from the decklist for *this entry*: negative means
              copies were taken out, positive means copies were put in. Reported, not
              applied -- dc.quantity already includes it.

              Per printing, because a deck can hold two printings of one card. Summed per
              card, taking print A out and putting print B in cancelled to zero and both
              entries lost the tag that says the deck no longer matches the decklist.
              Existing ledger rows already name their printing, so history lines up.
            */
            COALESCE((SELECT SUM(m.quantity) FROM deck_card_moves m
                      WHERE m.deck_id = dc.deck_id AND m.oracle_id = dc.oracle_id
                        AND COALESCE(m.entry_scryfall_id, m.scryfall_id) = dc.scryfall_id),
                     0) AS moved
     FROM deck_cards dc
     LEFT JOIN deck_card_overrides o
            ON o.deck_id = dc.deck_id AND o.oracle_id = dc.oracle_id
     ${DECK_TRAITS_JOIN}
     LEFT JOIN deck_card_lang_requests lr
            ON lr.deck_id = dc.deck_id AND lr.oracle_id = dc.oracle_id
     LEFT JOIN printings p ON p.scryfall_id = COALESCE(o.scryfall_id, dc.scryfall_id)
     WHERE dc.deck_id = ?
     ORDER BY dc.name COLLATE NOCASE`,
    [deckId]
  ) as (Omit<
    DeckCardRow,
    | 'categories'
    | 'in_maindeck'
    | 'finish'
    | 'rarity'
    | 'label_name'
    | 'label_color'
    | 'held'
    | 'is_commander'
    | 'group'
    | 'price_is_proxy'
    | 'language_forced'
    | 'foil_treatment'
    | 'treatment_forced'
    | 'finish_forced'
    | 'proxied'
    | 'moves'
  > & {
    forced_lang: string | null
    override_finish: string | null
    override_treatment: string | null
    layout: string | null
    proxied: number
    promo_types: string | null
    categories: string
    in_maindeck: number
    finish: string
    rarity: string | null
    cmc: number | null
    color_identity: string | null
    type_line: string | null
    unit_value: number | null
    price_is_proxy: number
  })[]

  // One read for the whole deck; a per-row query would be a hundred round trips
  // for a table that is almost always empty.
  const moves = deckMoves(deckId)

  const cards: DeckCardRow[] = rows.map((row) => {
    const label = parseLabel(row.label)
    const categories = JSON.parse(row.categories) as string[]
    const commanderCategory = categories.find((c) => premier.has(c))

    // Exactly one owning group per card. A card can carry several categories, so
    // without this the group totals would double-count it and stop summing to the
    // deck total. Premier wins, then the first in-deck category, then the first.
    const group =
      commanderCategory ??
      categories.find((c) => categoryInDeck.get(c) !== false) ??
      categories[0] ??
      'Uncategorized'

    return {
      ...row,
      categories,
      in_maindeck: !!row.in_maindeck,
      finish: row.finish as Finish,
      rarity: row.rarity as Rarity | null,
      label_name: label.name,
      label_color: label.color,
      is_commander: !!commanderCategory,
      group,
      price_is_proxy: !!row.price_is_proxy,
      language_forced: !!row.forced_lang,
      finish_forced: row.override_finish !== null,
      // The printing's tags say which foil this is; a stored value is your
      // correction, and gets marked as such.
      foil_treatment:
        row.override_treatment ??
        foilTreatmentOf(
          { promo_types: row.promo_types ? (JSON.parse(row.promo_types) as string[]) : [] },
          row.finish as Finish
        ),
      treatment_forced: row.override_treatment !== null,
      proxied: row.proxied === 1,
      layout: row.layout ?? null,
      moves: moves.get(row.oracle_id ?? '') ?? [],
      /*
        Where the copies for this entry are, kept as two facts rather than one number.

        `in_deck` is the deck vouching for itself: an "owned" label, or a proxy, which is
        held outright because the slot is filled by something you can play — still marked,
        so a deck is never quietly complete on stand-ins.

        `in_collection` is your bulk. These used to be added together and the sum called
        "owned", so a deck holding none of a card you had four of read "have 4" and turned
        green. A card in your bulk is yours; it is not in your deck.

        Nothing is subtracted here for a local move: `quantity` already is what the deck
        physically holds, because a move is written into the row. What a move changes is
        only whether Archidekt agrees, which `moves` reports.
      */
      in_deck:
        row.proxied === 1 ? row.quantity : row.label_possession === 'owned' ? row.quantity : 0,
      in_collection: exactOnly ? row.owned_exact : Math.max(row.owned_exact, row.owned_any),
      // Kept for the paths that ask "is a copy reachable at all" -- moves, pick lists.
      held:
        (row.proxied === 1 ? row.quantity : row.label_possession === 'owned' ? row.quantity : 0) +
        (exactOnly ? row.owned_exact : Math.max(row.owned_exact, row.owned_any))
    }
  })

  const priceOf = new Map(rows.map((r) => [r.id, r.unit_value]))

  return { deck, ...groupCards(cards, categoryInDeck, premier, priceOf) }
}

/**
 * Buckets cards into their owning group and totals everything by *card*, not by
 * row. An entry of Forest x8 counts as eight cards, which is the whole point:
 * counting rows made a deck of 116 cards report 103.
 */
function groupCards(
  cards: DeckCardRow[],
  categoryInDeck: Map<string, boolean>,
  premier: Set<string>,
  priceOf: Map<number, number | null>
): Omit<DeckBreakdown, 'deck'> {
  const byGroup = new Map<string, DeckCardRow[]>()
  for (const card of cards) {
    const bucket = byGroup.get(card.group)
    if (bucket) bucket.push(card)
    else byGroup.set(card.group, [card])
  }

  const groups: DeckGroup[] = [...byGroup.entries()].map(([name, groupCardList]) => {
    let cardCount = 0
    let ownedCards = 0
    let inCollectionCards = 0
    let missingCards = 0
    let missingValue = 0
    let missingValueIsProxy = false
    for (const card of groupCardList) {
      const { inDeck: owned, fromCollection, missing } = allocateCopies(card)
      cardCount += card.quantity
      ownedCards += owned
      inCollectionCards += fromCollection
      missingCards += missing
      const unit = priceOf.get(card.id)
      if (unit) {
        missingValue += unit * missing
        if (missing > 0 && card.price_is_proxy) missingValueIsProxy = true
      }
    }
    return {
      name,
      inDeck: categoryInDeck.get(name) !== false,
      isPremier: premier.has(name),
      cards: groupCardList,
      cardCount,
      ownedCards,
      inCollectionCards,
      missingCards,
      missingValue,
      missingValueIsProxy
    }
  })

  // Premier first, then in-deck categories, then the excluded ones like Maybeboard.
  groups.sort((a, b) => {
    if (a.isPremier !== b.isPremier) return a.isPremier ? -1 : 1
    if (a.inDeck !== b.inDeck) return a.inDeck ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  const totals: DeckTotals = {
    cards: groups.reduce((sum, g) => sum + g.cardCount, 0),
    entries: cards.length,
    inDeckCards: groups.filter((g) => g.inDeck).reduce((sum, g) => sum + g.cardCount, 0),
    excludedCards: groups.filter((g) => !g.inDeck).reduce((sum, g) => sum + g.cardCount, 0),
    ownedCards: groups.reduce((sum, g) => sum + g.ownedCards, 0),
    inCollectionCards: groups.reduce((sum, g) => sum + g.inCollectionCards, 0),
    missingCards: groups.reduce((sum, g) => sum + g.missingCards, 0),
    missingValue: groups.reduce((sum, g) => sum + g.missingValue, 0),
    missingValueIsProxy: groups.some((g) => g.missingValueIsProxy)
  }

  const categories = groups.map((g) => ({
    name: g.name,
    inDeck: g.inDeck,
    cardCount: g.cardCount
  }))

  // Distinct labels actually present, so the filter offers only real options.
  const labelMap = new Map<string, { name: string | null; color: string | null; cardCount: number }>()
  for (const card of cards) {
    if (!card.label_color && !card.label_name) continue
    const key = card.label_color ?? card.label_name ?? ''
    const existing = labelMap.get(key)
    if (existing) existing.cardCount += card.quantity
    else
      labelMap.set(key, {
        name: card.label_name,
        color: card.label_color,
        cardCount: card.quantity
      })
  }

  // Languages actually present, so the filter offers only real options — the
  // effective language, so an override or a forced language is what you filter on.
  const languageMap = new Map<string, number>()
  for (const card of cards) {
    languageMap.set(card.lang, (languageMap.get(card.lang) ?? 0) + card.quantity)
  }

  return {
    groups,
    categories,
    labels: [...labelMap.values()].sort((a, b) => b.cardCount - a.cardCount),
    languages: [...languageMap.entries()]
      .map(([lang, cardCount]) => ({ lang, cardCount }))
      .sort((a, b) => b.cardCount - a.cardCount),
    totals
  }
}

export interface PossessionCounts {
  owned: number
  notOwned: number
}

/**
 * Re-derives `deck_cards.label_possession` for every row from the raw label
 * stored on it, against the colour-to-possession map from Settings.
 *
 * Because the raw label lives on the row, this is a purely local UPDATE — so
 * changing a colour's state takes effect immediately with no network access and
 * no deck re-sync.
 */
export function recomputeLabelPossession(
  possession: Record<string, Possession>
): PossessionCounts {
  const db = getDb()

  const byState: Record<Possession, string[]> = { owned: [], not_owned: [] }
  for (const [color, state] of Object.entries(possession)) {
    const normalized = color.trim().toLowerCase()
    if (normalized) byState[state].push(normalized)
  }

  /*
    Clear first, then set each state, so a colour that was just unmapped falls back
    to NULL (ignored) rather than keeping a stale flag.

    Rows holding copies you moved in yourself are exempt. They have no Archidekt
    label to derive a state from, so clearing them would stop a card you physically
    put there from counting as held — and it is held by the strongest evidence
    there is, which is that you put it there.

    Read from the ledger rather than a flag on the row. A flag would have to be
    written when copies are put in and unwritten when they leave, and the version
    that did so marked a row as locally-added while *undoing* a move out — copies
    that were Archidekt's all along. The ledger cannot drift from itself.
  */
  db.run(
    `UPDATE deck_cards SET label_possession = NULL
     WHERE label_possession IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM deck_card_moves m
         WHERE m.deck_id = deck_cards.deck_id
           AND m.oracle_id = deck_cards.oracle_id
           AND m.quantity > 0
       )`
  )

  for (const state of ['owned', 'not_owned'] as Possession[]) {
    const colors = [...new Set(byState[state])]
    if (!colors.length) continue
    // Rather than parsing labels in SQL, compare against the whole raw string:
    // a label is "name,#color", so a colour match means the string ends with it.
    // LIKE is case-insensitive for ASCII in SQLite, which is what we want for hex.
    const clauses = colors.map(() => 'label LIKE ?').join(' OR ')
    db.run(
      `UPDATE deck_cards SET label_possession = ?
       WHERE label IS NOT NULL AND label != '' AND (${clauses})`,
      [state, ...colors.map((color) => `%${color}`)]
    )
  }

  /*
    A card with no label at all counts as owned.

    Archidekt sends `label: ""` for a deck nobody has marked up — measured, not assumed:
    four Commander 2017 precons in one real collection carried an empty string on every
    one of their 347 cards, while a deck the owner had touched carried `",#656565"`, the
    unnamed grey default. So mapping every colour to "I own it" could not reach them: they
    have no colour to map, and the deck reported cards its owner held as missing.

    Additive by construction. The colour passes above filter on
    `label IS NOT NULL AND label != ''`, so they never see these rows and this never fights
    them: wherever there is a colour, the colour decides, including one that means "I do not
    own this". And the clear step's exemption for locally-moved copies needs no counterpart
    here — a card you carried in yourself has no Archidekt label either, so this lands it on
    `owned`, which is exactly what that exemption was protecting.

    The cost, which is real: a decklist imported to price up what you would need to buy
    reads as fully owned until you label it.
  */
  db.run(
    `UPDATE deck_cards SET label_possession = 'owned'
     WHERE label IS NULL OR label = ''`
  )

  const counts = db.get(
    `SELECT
       COALESCE(SUM(CASE WHEN label_possession = 'owned' THEN 1 ELSE 0 END), 0) AS owned,
       COALESCE(SUM(CASE WHEN label_possession = 'not_owned' THEN 1 ELSE 0 END), 0) AS notOwned
     FROM deck_cards`
  ) as PossessionCounts
  return counts
}

/**
 * Every label colour seen across synced decks, so the picker can offer a list
 * instead of asking for hex codes. Archidekt exposes no registry of labels, so
 * scanning the cards is the only way to know which exist.
 */
export function discoverLabelColors(
  possession: Record<string, Possession>
): DeckLabelColor[] {
  const rows = getDb().all(
    `SELECT label, COUNT(*) AS cardCount, COUNT(DISTINCT deck_id) AS deckCount
     FROM deck_cards
     WHERE label IS NOT NULL AND label != ''
     GROUP BY label
     ORDER BY cardCount DESC`
  ) as { label: string; cardCount: number; deckCount: number }[]

  const mapped = new Map(
    Object.entries(possession).map(([color, state]) => [color.toLowerCase(), state])
  )
  // Several label names can share a colour; merge on colour and keep the first
  // non-empty name as the human-readable hint.
  const byColor = new Map<string, DeckLabelColor>()

  for (const row of rows) {
    const { name, color } = parseLabel(row.label)
    if (!color) continue
    const existing = byColor.get(color)
    if (existing) {
      existing.cardCount += row.cardCount
      existing.deckCount = Math.max(existing.deckCount, row.deckCount)
      existing.name ??= name
    } else {
      byColor.set(color, {
        color,
        name,
        cardCount: row.cardCount,
        deckCount: row.deckCount,
        possession: mapped.get(color) ?? null
      })
    }
  }

  // Colours the user has mapped but which no synced deck uses (added by hand, or
  // from a deck since deleted) still belong in the list so they can be changed.
  for (const [color, state] of mapped) {
    if (!byColor.has(color)) {
      byColor.set(color, { color, name: null, cardCount: 0, deckCount: 0, possession: state })
    }
  }

  return [...byColor.values()].sort((a, b) => b.cardCount - a.cardCount)
}

/**
 * Records which printing you actually own for a deck entry.
 *
 * Lives in its own table because `replaceDeckCards` wipes a deck's rows on every
 * sync. Keyed on oracle_id so it also survives Archidekt switching the entry to a
 * different printing.
 */
export function setCardOverride(
  deckId: number,
  oracleId: string,
  scryfallId: string,
  lang: string
): void {
  // Success retires any "no printing in that language" flag for this card, so the
  // flag can never outlive the problem it describes.
  clearLanguageMiss(deckId, oracleId)
  getDb().run(
    `INSERT INTO deck_card_overrides (deck_id, oracle_id, scryfall_id, lang, created_at)
     VALUES (?,?,?,?,?)
     ON CONFLICT(deck_id, oracle_id) DO UPDATE SET
       scryfall_id = excluded.scryfall_id,
       lang = excluded.lang`,
    [deckId, oracleId, scryfallId, lang, nowIso()]
  )
}

/**
 * Points a deck entry at a specific printing you chose yourself.
 *
 * No Scryfall lookup: the printing is already known, so this is the direct route
 * used by the printing picker. Clears any earlier "no printing in that language"
 * flag, since naming a printing answers that question.
 */
export function setCardPrinting(deckId: number, oracleId: string, scryfallId: string): void {
  const printing = getDb().get('SELECT lang FROM printings WHERE scryfall_id = ?', [scryfallId]) as
    | { lang: string }
    | undefined
  if (!printing) throw new Error(tr('err.notCached'))
  setCardOverride(deckId, oracleId, scryfallId, printing.lang)
}

/**
 * Records a language for a deck entry that Scryfall has no printing of.
 *
 * The override keeps pointing at a real printing, so prices and rules text still
 * work; only the language and optionally the name become your assertion. Needs an
 * override row, so one is created against the entry's current printing if absent.
 * Passing null clears the assertion.
 */
export function forceCardLanguage(
  deckId: number,
  oracleId: string,
  lang: string | null,
  name?: string | null
): void {
  const db = getDb()
  const current = db.get(
    `SELECT COALESCE(o.scryfall_id, dc.scryfall_id) AS scryfall_id,
            COALESCE(o.lang, dc.lang) AS lang
     FROM deck_cards dc
     LEFT JOIN deck_card_overrides o ON o.deck_id = dc.deck_id AND o.oracle_id = dc.oracle_id
     WHERE dc.deck_id = ? AND dc.oracle_id = ? AND dc.scryfall_id IS NOT NULL
     LIMIT 1`,
    [deckId, oracleId]
  ) as { scryfall_id: string; lang: string } | undefined
  if (!current) throw new Error(tr('err.noLangAnchor'))

  const forcedName = lang ? (name?.trim() ? name.trim() : null) : null
  db.run(
    `INSERT INTO deck_card_overrides
       (deck_id, oracle_id, scryfall_id, lang, forced_lang, forced_name, created_at)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(deck_id, oracle_id) DO UPDATE SET
       forced_lang = excluded.forced_lang,
       forced_name = excluded.forced_name`,
    [deckId, oracleId, current.scryfall_id, current.lang, lang, forcedName, nowIso()]
  )
  // Asserting a language answers the question the flag was asking.
  if (lang) clearLanguageMiss(deckId, oracleId)
}

/**
 * Records the finish and/or foil treatment you physically hold a deck entry in.
 *
 * Archidekt only says foil or not, and `replaceDeckCards` rebuilds `deck_cards`
 * on every sync, so this has to live in the override table to survive — the same
 * reason `forced_lang` does. Passing null for either clears it: the finish falls
 * back to Archidekt's, the treatment to whatever the printing's promo tags say.
 *
 * Needs an override row, so one is created against the entry's current printing
 * if absent, exactly as forcing a language does.
 */
export function setCardFinish(
  deckId: number,
  oracleId: string,
  finish: Finish | null,
  treatment?: string | null
): void {
  const db = getDb()
  const current = db.get(
    `SELECT COALESCE(o.scryfall_id, dc.scryfall_id) AS scryfall_id,
            COALESCE(o.lang, dc.lang) AS lang,
            -- The entry's own printing too: a treatment attaches to that, not to the
            -- printing the override names.
            dc.scryfall_id AS entry_scryfall_id
     FROM deck_cards dc
     LEFT JOIN deck_card_overrides o ON o.deck_id = dc.deck_id AND o.oracle_id = dc.oracle_id
     WHERE dc.deck_id = ? AND dc.oracle_id = ? AND dc.scryfall_id IS NOT NULL
     ORDER BY dc.quantity > 0 DESC, dc.id
     LIMIT 1`,
    [deckId, oracleId]
  ) as { scryfall_id: string; lang: string; entry_scryfall_id: string } | undefined
  if (!current) throw new Error(tr('err.noFinishAnchor'))

  // A nonfoil card has no foil treatment, so setting one would be a value no
  // screen could ever show. Clearing the finish clears it too.
  const nextTreatment =
    treatment === undefined ? null : finish === 'nonfoil' || finish === null ? null : treatment

  /*
    The finish is a correction to the decklist entry and stays on the override; the
    treatment describes the copies and moved to the traits table with migration 18. They
    were written together because they used to live together, and a treatment recorded
    for the whole card was applied to every printing of it in the deck.
  */
  db.run(
    `INSERT INTO deck_card_overrides
       (deck_id, oracle_id, scryfall_id, lang, finish, created_at)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(deck_id, oracle_id) DO UPDATE SET
       finish = excluded.finish`,
    [deckId, oracleId, current.scryfall_id, current.lang, finish, nowIso()]
  )
  setEntryTraits(db, deckId, oracleId, current.entry_scryfall_id, {
    foilTreatment: nextTreatment
  })
}

/**
 * Marks a deck entry as filled by a proxy, or not.
 *
 * In the override table for the same reason the finish is: `replaceDeckCards`
 * rebuilds every `deck_cards` row on each sync, so a flag stored there would be
 * lost. Creates an override row against the entry's current printing if absent,
 * exactly as forcing a language or a finish does.
 */
export function setCardProxied(deckId: number, oracleId: string, proxied: boolean): void {
  const db = getDb()
  /*
    The entry's own printing, because that is what a trait attaches to -- and the entry
    holding copies first, since marking an emptied slot as a proxy says nothing.
  */
  const current = db.get(
    `SELECT dc.scryfall_id AS entry_scryfall_id
     FROM deck_cards dc
     WHERE dc.deck_id = ? AND dc.oracle_id = ? AND dc.scryfall_id IS NOT NULL
     ORDER BY dc.quantity > 0 DESC, dc.id
     LIMIT 1`,
    [deckId, oracleId]
  ) as { entry_scryfall_id: string } | undefined
  if (!current) throw new Error(tr('err.noProxyAnchor'))

  setEntryTraits(db, deckId, oracleId, current.entry_scryfall_id, { proxied })
}

/**
 * The decks a copy of this printing could be taken out of.
 *
 * Stricter than `cardLocations`, which answers "where does this card appear" and so
 * admits unmapped labels: this answers "where can I take one from", so it wants an
 * `owned` label, no proxy, and copies actually left after anything already staged.
 *
 * Reads `dc.quantity` directly — that is what the deck physically holds, since a
 * move is written into the row rather than adjusted while reading.
 */
export function deckSourcesFor(scryfallId: string, finish: string): DeckSource[] {
  return getDb().all(
    `SELECT d.id AS deck_id, d.name AS deck_name, dc.oracle_id AS oracle_id,
            SUM(dc.quantity)
              - COALESCE((
                  SELECT SUM(pli.quantity) FROM pick_list_items pli
                  JOIN pick_lists pl ON pl.id = pli.pick_list_id
                  WHERE pl.status = 'open'
                    AND pli.source_deck_id = d.id
                    AND pli.source_oracle_id = dc.oracle_id
                ), 0) AS quantity
     FROM deck_cards dc
     JOIN decks d ON d.id = dc.deck_id
     ${DECK_OVERRIDE_JOIN}
     ${DECK_TRAITS_JOIN}
     WHERE dc.label_possession = 'owned'
       AND ${DECK_PROXIED} = 0
       AND ${DECK_PRINTING} = ?
       AND ${DECK_FINISH} = ?
     GROUP BY d.id, d.name, dc.oracle_id
     HAVING quantity > 0
     ORDER BY d.name`,
    [scryfallId, finish]
  ) as DeckSource[]
}

/** Every deck, for a chooser that has to offer somewhere to put a card. */
export function deckChoices(): { deck_id: number; deck_name: string }[] {
  return getDb().all(
    "SELECT id AS deck_id, name AS deck_name FROM decks WHERE source = 'archidekt' ORDER BY name"
  ) as { deck_id: number; deck_name: string }[]
}

/**
 * Records a move in the ledger.
 *
 * `quantity` is signed: negative took copies out of the deck, positive put them in.
 * The baseline is what the decklist says right now, which is what a later sync
 * measures its own progress against.
 */
/**
 * What the copies in one deck entry are: a proxy, a particular kind of foil, or both.
 *
 * Keyed on the entry's printing. `deck_cards` cannot hold either fact -- a sync
 * rewrites every row of it -- and `deck_card_overrides` held them keyed on the card,
 * which is the bug migration 18 exists to end.
 *
 * A row that says nothing is deleted rather than kept as a row of defaults, so the
 * absence of a trait is one state and not two.
 */
export function setEntryTraits(
  db: Sql,
  deckId: number,
  oracleId: string,
  scryfallId: string,
  traits: { proxied?: boolean; foilTreatment?: string | null }
): void {
  const existing = db.get(
    `SELECT proxied, foil_treatment FROM deck_entry_traits
      WHERE deck_id = ? AND oracle_id = ? AND scryfall_id = ?`,
    [deckId, oracleId, scryfallId]
  ) as { proxied: number; foil_treatment: string | null } | undefined

  const proxied = traits.proxied ?? existing?.proxied === 1
  const treatment =
    traits.foilTreatment === undefined ? (existing?.foil_treatment ?? null) : traits.foilTreatment

  if (!proxied && treatment === null) {
    db.run(
      `DELETE FROM deck_entry_traits
        WHERE deck_id = ? AND oracle_id = ? AND scryfall_id = ?`,
      [deckId, oracleId, scryfallId]
    )
    return
  }

  db.run(
    `INSERT INTO deck_entry_traits
       (deck_id, oracle_id, scryfall_id, proxied, foil_treatment, created_at)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(deck_id, oracle_id, scryfall_id) DO UPDATE SET
       proxied = excluded.proxied,
       foil_treatment = excluded.foil_treatment`,
    [deckId, oracleId, scryfallId, proxied ? 1 : 0, treatment, nowIso()]
  )
}

/**
 * Drops deck entries that hold nothing and mean nothing.
 *
 * An emptied entry is usually worth keeping: when the decklist wants a card the deck no
 * longer has, that empty slot is the fact the deck screen exists to show, and it is what
 * you click to undo the move. So a row at zero survives as long as the ledger still says
 * this card differs from the decklist.
 *
 * What it must not do is outlive the reason. Move a card the decklist never mentioned
 * into a deck and back out and the moves cancel, leaving an entry that was invented by a
 * move that no longer says anything -- a row at zero for ever, on a card Archidekt has
 * never heard of.
 *
 * The net is the test, not the number of ledger rows: a +1 and a -1 are two rows saying
 * nothing. Called from every path that can empty a row -- a move out, a revert, and the
 * replay after a sync -- because the last of those would otherwise put it back.
 */
export function pruneEmptyEntries(db: Sql, deckId: number, oracleId: string): void {
  /*
    Per entry, not per card, and real data is what showed why.

    One deck held two empty entries of the same card for opposite reasons: an Archidekt
    entry whose copy had been taken out -- which must keep its slot, that is where the
    tag hangs -- and beside it an entry a move had invented and then cancelled. Summed
    across the card the two moves netted to zero and a per-card rule would have deleted
    the decklist entry along with the phantom.
  */
  db.run(
    `DELETE FROM deck_cards
      WHERE deck_id = ? AND oracle_id = ? AND quantity = 0
      AND COALESCE((
            SELECT SUM(m.quantity) FROM deck_card_moves m
             WHERE m.deck_id = deck_cards.deck_id
               AND m.oracle_id = deck_cards.oracle_id
               AND COALESCE(m.entry_scryfall_id, m.scryfall_id) = deck_cards.scryfall_id
          ), 0) = 0`,
    [deckId, oracleId]
  )
}

export function recordMove(
  db: Sql,
  input: {
    deckId: number
    oracleId: string
    scryfallId: string
    finish: string
    condition: string
    quantity: number
    /** The treatment the copies carried, so a revert can put it back. */
    foilTreatment?: string | null
    /**
     * The printing of the deck entry these came out of, when it differs from the
     * copies' own. Left off, it is the same -- which it is unless the entry's printing
     * was overridden.
     */
    entryScryfallId?: string | null
  }
): void {
  const listed = (
    db.get(
      'SELECT COALESCE(SUM(quantity), 0) AS quantity FROM deck_cards WHERE deck_id = ? AND oracle_id = ?',
      [input.deckId, input.oracleId]
    ) as { quantity: number }
  ).quantity

  db.run(
    `INSERT INTO deck_card_moves
       (deck_id, oracle_id, scryfall_id, finish, condition, quantity,
        deck_quantity_at_move, foil_treatment, entry_scryfall_id, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      input.deckId,
      input.oracleId,
      input.scryfallId,
      input.finish,
      input.condition,
      input.quantity,
      listed,
      input.foilTreatment ?? null,
      input.entryScryfallId ?? null,
      nowIso()
    ]
  )
}

/**
 * The moves recorded against a deck, newest first, keyed by oracle id.
 *
 * What the badge on a deck card reads from: a negative entry means copies are out
 * of the deck while the decklist still counts them, a positive one means copies are
 * in it that the decklist has not caught up with.
 */
export function deckMoves(deckId: number): Map<string, DeckMove[]> {
  const rows = getDb().all(
    `SELECT id, deck_id, oracle_id, scryfall_id, finish, condition, quantity, created_at
     FROM deck_card_moves WHERE deck_id = ?
     ORDER BY created_at DESC, id DESC`,
    [deckId]
  ) as DeckMove[]

  const byOracle = new Map<string, DeckMove[]>()
  for (const row of rows) {
    const list = byOracle.get(row.oracle_id)
    if (list) list.push(row)
    else byOracle.set(row.oracle_id, [row])
  }
  return byOracle
}

export function clearCardOverride(deckId: number, oracleId: string): void {
  getDb().run('DELETE FROM deck_card_overrides WHERE deck_id = ? AND oracle_id = ?', [
    deckId,
    oracleId
  ])
  clearLanguageMiss(deckId, oracleId)
}

export function clearDeckOverrides(deckId: number): void {
  const db = getDb()
  db.run('DELETE FROM deck_card_overrides WHERE deck_id = ?', [deckId])
  db.run('DELETE FROM deck_card_lang_requests WHERE deck_id = ?', [deckId])
}

/**
 * Records that a language was asked for and no printing exists in it.
 *
 * Its own table rather than a column on `deck_card_overrides`, because that
 * table's `scryfall_id` is NOT NULL: a failure row would have to name some
 * printing, and naming the card's current one would pin it there — a lookup that
 * *failed* would then outrank Archidekt the next time it moved the entry.
 */
export function recordLanguageMiss(deckId: number, oracleId: string, requestedLang: string): void {
  getDb().run(
    `INSERT INTO deck_card_lang_requests (deck_id, oracle_id, requested_lang, created_at)
     VALUES (?,?,?,?)
     ON CONFLICT(deck_id, oracle_id) DO UPDATE SET requested_lang = excluded.requested_lang`,
    [deckId, oracleId, requestedLang, nowIso()]
  )
}

export function clearLanguageMiss(deckId: number, oracleId: string): void {
  getDb().run('DELETE FROM deck_card_lang_requests WHERE deck_id = ? AND oracle_id = ?', [
    deckId,
    oracleId
  ])
}

export function setDeckDefaultLang(deckId: number, lang: string | null): void {
  getDb().run('UPDATE decks SET default_lang = ? WHERE id = ?', [lang, deckId])
}

export interface DeckCardIdentity {
  oracle_id: string
  set_code: string | null
  collector_number: string | null
  name: string
}

/**
 * Distinct cards in a deck, optionally narrowed to the ones you picked.
 *
 * The renderer sends oracle ids and nothing else, so the set/number a Scryfall
 * lookup needs is read here rather than trusted from the other side of IPC.
 */
export function deckCardIdentities(deckId: number, oracleIds?: string[]): DeckCardIdentity[] {
  if (oracleIds && oracleIds.length === 0) return []
  const filter = oracleIds
    ? ` AND dc.oracle_id IN (${oracleIds.map(() => '?').join(',')})`
    : ''
  return getDb().all(
    `SELECT DISTINCT dc.oracle_id, dc.set_code, dc.collector_number, dc.name
     FROM deck_cards dc
     WHERE dc.deck_id = ? AND dc.oracle_id IS NOT NULL${filter}
     ORDER BY dc.name COLLATE NOCASE`,
    [deckId, ...(oracleIds ?? [])]
  ) as DeckCardIdentity[]
}

/** Scryfall ids referenced by decks that we have no cached printing for yet. */
export function deckPrintingsNeedingCache(limit = 500): string[] {
  const rows = getDb().all(
    `SELECT DISTINCT dc.scryfall_id
     FROM deck_cards dc
     LEFT JOIN printings p ON p.scryfall_id = dc.scryfall_id
     WHERE dc.scryfall_id IS NOT NULL AND p.scryfall_id IS NULL
     LIMIT ?`,
    [limit]
  ) as { scryfall_id: string }[]
  return rows.map((r) => r.scryfall_id)
}
