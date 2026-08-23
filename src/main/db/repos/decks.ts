import { getDb, nowIso, transaction } from '../connection.js'
import { priceExpr, priceIsProxyExpr } from './printings.js'
import { parseLabel } from '../../archidekt/mappers.js'
import { foilTreatmentOf } from '@shared/types'
import type {
  Currency,
  Deck,
  DeckBreakdown,
  DeckCardRow,
  DeckGroup,
  DeckLabelColor,
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
  })
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
            o.foil_treatment AS override_treatment,
            COALESCE(o.proxied, 0) AS proxied,
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
            ${price} AS unit_value,
            ${proxy} AS price_is_proxy,
            COALESCE((SELECT SUM(ci.quantity) FROM collection_items ci
                      WHERE ci.scryfall_id = COALESCE(o.scryfall_id, dc.scryfall_id)), 0) AS owned_exact,
            COALESCE((SELECT SUM(ci.quantity) FROM collection_items ci
                      JOIN printings p2 ON p2.scryfall_id = ci.scryfall_id
                      WHERE dc.oracle_id IS NOT NULL AND p2.oracle_id = dc.oracle_id), 0) AS owned_any
     FROM deck_cards dc
     LEFT JOIN deck_card_overrides o
            ON o.deck_id = dc.deck_id AND o.oracle_id = dc.oracle_id
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
  > & {
    forced_lang: string | null
    override_finish: string | null
    override_treatment: string | null
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
      // The single source of truth for "how many do I have for this entry".
      // A card under an "owned" label is held by definition — that is the whole
      // point of the label — added to what the collection holds, matching the
      // additive rule: a loose copy plus one sleeved in a deck is two.
      //
      // A proxied entry is held outright: the slot is filled by a card you can
      // actually play, so the deck reads complete and it leaves the Missing pile.
      // It is still marked, so a deck is never quietly complete on stand-ins.
      held:
        row.proxied === 1
          ? row.quantity
          : (row.label_possession === 'owned' ? row.quantity : 0) +
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
    let missingCards = 0
    let missingValue = 0
    let missingValueIsProxy = false
    for (const card of groupCardList) {
      const owned = Math.min(card.held, card.quantity)
      const missing = Math.max(0, card.quantity - card.held)
      cardCount += card.quantity
      ownedCards += owned
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

  // Clear first, then set each state, so a colour that was just unmapped falls
  // back to NULL (ignored) rather than keeping a stale flag.
  db.run('UPDATE deck_cards SET label_possession = NULL WHERE label_possession IS NOT NULL')

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
            COALESCE(o.lang, dc.lang) AS lang
     FROM deck_cards dc
     LEFT JOIN deck_card_overrides o ON o.deck_id = dc.deck_id AND o.oracle_id = dc.oracle_id
     WHERE dc.deck_id = ? AND dc.oracle_id = ? AND dc.scryfall_id IS NOT NULL
     LIMIT 1`,
    [deckId, oracleId]
  ) as { scryfall_id: string; lang: string } | undefined
  if (!current) throw new Error(tr('err.noFinishAnchor'))

  // A nonfoil card has no foil treatment, so setting one would be a value no
  // screen could ever show. Clearing the finish clears it too.
  const nextTreatment =
    treatment === undefined ? null : finish === 'nonfoil' || finish === null ? null : treatment

  db.run(
    `INSERT INTO deck_card_overrides
       (deck_id, oracle_id, scryfall_id, lang, finish, foil_treatment, created_at)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(deck_id, oracle_id) DO UPDATE SET
       finish = excluded.finish,
       foil_treatment = excluded.foil_treatment`,
    [deckId, oracleId, current.scryfall_id, current.lang, finish, nextTreatment, nowIso()]
  )
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
  const current = db.get(
    `SELECT COALESCE(o.scryfall_id, dc.scryfall_id) AS scryfall_id,
            COALESCE(o.lang, dc.lang) AS lang
     FROM deck_cards dc
     LEFT JOIN deck_card_overrides o ON o.deck_id = dc.deck_id AND o.oracle_id = dc.oracle_id
     WHERE dc.deck_id = ? AND dc.oracle_id = ? AND dc.scryfall_id IS NOT NULL
     LIMIT 1`,
    [deckId, oracleId]
  ) as { scryfall_id: string; lang: string } | undefined
  if (!current) throw new Error(tr('err.noProxyAnchor'))

  db.run(
    `INSERT INTO deck_card_overrides
       (deck_id, oracle_id, scryfall_id, lang, proxied, created_at)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(deck_id, oracle_id) DO UPDATE SET proxied = excluded.proxied`,
    [deckId, oracleId, current.scryfall_id, current.lang, proxied ? 1 : 0, nowIso()]
  )
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
