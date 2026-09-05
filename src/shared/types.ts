/** Types shared between the Electron main process and the renderer. */

import type { LocaleSetting } from './i18n/index.js'

export type { Locale, LocaleSetting, TranslationKey } from './i18n/index.js'

export type Finish = 'nonfoil' | 'foil' | 'etched'
export type Condition = 'NM' | 'LP' | 'MP' | 'HP' | 'DMG'
export type Rarity = 'common' | 'uncommon' | 'rare' | 'mythic' | 'special' | 'bonus'
export type Currency = 'usd' | 'eur'

export const FINISHES: Finish[] = ['nonfoil', 'foil', 'etched']
export const CONDITIONS: Condition[] = ['NM', 'LP', 'MP', 'HP', 'DMG']
/**
 * The finish to use for a printing when the one you asked for does not exist.
 *
 * Foil-only promos and etched-only Commander cards are common, and a picker that
 * refuses the click just leaves the card unaddable. Prefer the requested finish,
 * fall back to whatever the printing actually comes in.
 */
export function effectiveFinishFor(
  printing: { finishes: Finish[] },
  wanted: Finish
): Finish {
  if (printing.finishes.includes(wanted)) return wanted
  return printing.finishes[0] ?? wanted
}

/**
 * The kinds of foil Wizards has actually printed, as Scryfall tags them.
 *
 * A foil treatment is a property of a printing's FOIL VERSION, not of the
 * printing: a surge-foil card is sold as `["nonfoil","foil"]`, and only the foil
 * one is a surge foil. So this is derived from the printing and shown only for a
 * foil copy — see `foilTreatmentOf`.
 *
 * Names stay in English in both locales, the same choice already made for `foil`
 * and `etched`: these are product names French players use untranslated.
 *
 * Order is priority order. A printing can carry several tags
 * (`["surgefoil","universesbeyond"]`), so the first match wins.
 */
export const FOIL_TREATMENTS: { tag: string; label: string }[] = [
  { tag: 'surgefoil', label: 'Surge Foil' },
  { tag: 'galaxyfoil', label: 'Galaxy Foil' },
  { tag: 'ripplefoil', label: 'Ripple Foil' },
  { tag: 'halofoil', label: 'Halo Foil' },
  { tag: 'confettifoil', label: 'Confetti Foil' },
  { tag: 'dazzlefoil', label: 'Dazzle Foil' },
  { tag: 'fracturefoil', label: 'Fracture Foil' },
  { tag: 'rainbowfoil', label: 'Rainbow Foil' },
  { tag: 'doublerainbow', label: 'Double Rainbow Foil' },
  { tag: 'raisedfoil', label: 'Raised Foil' },
  { tag: 'firstplacefoil', label: 'First-Place Foil' },
  { tag: 'silverfoil', label: 'Silver Foil' },
  { tag: 'goldfoil', label: 'Gold Foil' },
  { tag: 'manafoil', label: 'Mana Foil' },
  { tag: 'chocobotrackfoil', label: 'Chocobo Track Foil' },
  { tag: 'textured', label: 'Textured Foil' },
  { tag: 'texturedfoil', label: 'Textured Foil' },
  { tag: 'oilslick', label: 'Oil Slick' },
  { tag: 'gilded', label: 'Gilded' },
  { tag: 'neonink', label: 'Neon Ink' },
  { tag: 'invisibleink', label: 'Invisible Ink' },
  { tag: 'stepandcompleat', label: 'Step-and-Compleat Foil' },
  { tag: 'shatteredglass', label: 'Shattered Glass' },
  { tag: 'magnified', label: 'Magnified Foil' },
  { tag: 'embossed', label: 'Embossed Foil' },
  { tag: 'serialized', label: 'Serialized' }
]

const TREATMENT_LABELS = new Map(FOIL_TREATMENTS.map((t) => [t.tag, t.label]))

/**
 * A readable name for a treatment tag.
 *
 * An unknown tag is tidied rather than dropped: Scryfall adds new ones every set,
 * and showing `Sparklefoil` for an unrecognised `sparklefoil` beats showing
 * nothing at all and looking like a card with no treatment.
 */
export function foilTreatmentLabel(tag: string): string {
  const known = TREATMENT_LABELS.get(tag)
  if (known) return known
  const spaced = tag.replace(/foil$/, ' foil').replace(/[-_]/g, ' ').trim()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/**
 * Which kind of foil this printing's foil version is, or null.
 *
 * Null for a nonfoil copy — a nonfoil card has no foil treatment, however the
 * printing is tagged — and null for a foil copy of an ordinary printing.
 */
export function foilTreatmentOf(
  printing: { promo_types: string[] },
  finish: Finish
): string | null {
  if (finish === 'nonfoil') return null
  for (const { tag } of FOIL_TREATMENTS) {
    if (printing.promo_types.includes(tag)) return tag
  }
  return null
}

export const RARITIES: Rarity[] = ['common', 'uncommon', 'rare', 'mythic', 'special', 'bonus']

/** Scryfall language codes, in rough order of how often they turn up in bulk. */
export const LANGUAGES = [
  'en', 'fr', 'de', 'it', 'es', 'pt', 'ja', 'ko', 'ru', 'zhs', 'zht',
  'he', 'la', 'grc', 'ar', 'sa', 'ph'
] as const

export const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English', fr: 'French', de: 'German', it: 'Italian', es: 'Spanish',
  pt: 'Portuguese', ja: 'Japanese', ko: 'Korean', ru: 'Russian',
  zhs: 'Chinese (S)', zht: 'Chinese (T)', he: 'Hebrew', la: 'Latin',
  grc: 'Ancient Greek', ar: 'Arabic', sa: 'Sanskrit', ph: 'Phyrexian'
}

export interface Prices {
  usd: string | null
  usd_foil: string | null
  usd_etched: string | null
  eur: string | null
  eur_foil: string | null
  tix: string | null
}

/** One language-specific Scryfall printing, cached locally. */
/**
 * The price a finish reads, out of an already-parsed prices object.
 *
 * Scryfall publishes only `usd`/`usd_foil`/`usd_etched`/`eur`/`eur_foil`, so
 * there is no per-treatment price and no `eur_etched` — an etched card in EUR
 * falls back to the foil price, which is the closest true figure.
 *
 * Shared so the SQL path (`priceExpr`) and the renderer agree; the Add-cards
 * tiles used to branch on the finish themselves and could drift.
 */
export function priceFor(
  prices: Prices | null,
  finish: Finish,
  currency: Currency
): number | null {
  if (!prices) return null
  const key =
    currency === 'eur'
      ? finish === 'nonfoil'
        ? 'eur'
        : 'eur_foil'
      : finish === 'foil'
        ? 'usd_foil'
        : finish === 'etched'
          ? 'usd_etched'
          : 'usd'
  const raw = prices[key as keyof Prices]
  if (raw === null || raw === undefined) return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

/**
 * What a screen should show for a printing: its own price, else the English twin's.
 *
 * Scryfall prices a printing, and it prices non-English ones almost never — 1 of 141 French
 * printings in one real collection, against 254 of 259 English. The SQL paths have borrowed a
 * sibling's figure all along; this is the same answer for the screens that hold a `Printing`
 * and have no way back to the database. `borrowed` is what earns the ≈: a stand-in is shown,
 * never passed off as the exact figure. Null still means null — nowhere prices this card.
 */
export function priceOfPrinting(
  printing: { prices: Prices | null; borrowed_prices?: Prices | null },
  finish: Finish,
  currency: Currency
): { value: number | null; borrowed: boolean } {
  const own = priceFor(printing.prices, finish, currency)
  if (own !== null) return { value: own, borrowed: false }
  const borrowed = priceFor(printing.borrowed_prices ?? null, finish, currency)
  return { value: borrowed, borrowed: borrowed !== null }
}

/**
 * Layouts that carry a picture per face, as opposed to two names on one picture.
 *
 * Measured against Scryfall rather than reasoned about, because the distinction is
 * not what the name suggests: a split, flip, adventure or meld card also has "A //
 * B" for a name and exactly one image, while a battle is filed under `transform`.
 * The five below are every layout whose newest printing has an image on
 * `card_faces[1]`.
 *
 * The card name cannot answer this -- it is `A // B` in both groups -- which is why
 * the flip control could switch the rules text long before the picture could
 * follow.
 */
export const TWO_IMAGE_LAYOUTS = [
  'transform',
  'modal_dfc',
  'double_faced_token',
  'reversible_card',
  'art_series'
]

export function hasTwoImages(layout: string | null | undefined): boolean {
  return layout !== null && layout !== undefined && TWO_IMAGE_LAYOUTS.includes(layout)
}

/** One side of a card: which picture to ask for, and what to call it. */
export interface CardSide {
  scryfallId: string
  /** Which face of that printing. Always 0 when the two sides are two printings. */
  face: 0 | 1
  title: string
}

/**
 * The two sides of a card, or null for a card with one.
 *
 * Two-sided here means one of Scryfall's own two-faced printings: Kefka and every other
 * `transform` / `modal_dfc` / `double_faced_token` / `reversible_card` / `art_series`
 * card, whose second picture is `face: 1` of the same id.
 *
 * There was briefly a second kind -- two separate printings a user declared to be one
 * physical card, for a token sheet with a different token on each face. It is gone. It
 * could be built out of a token and an ordinary card, it outlived the copies it claimed
 * to describe, and it renamed cards in the catalogue that had nothing to do with anyone's
 * collection. What is left is data Scryfall publishes, which nobody has to maintain.
 *
 * The names come from splitting on ` // `, the separator Scryfall itself uses for a
 * two-faced name. A two-image layout whose name has no separator keeps the whole name
 * for both sides rather than being reported as one-sided -- the pictures differ, which
 * is what a stacked pair is showing.
 */
export function twoSides(printing: {
  scryfall_id: string
  name: string
  printed_name?: string | null
  layout?: string | null
}): { front: CardSide; back: CardSide } | null {
  const shown = printing.printed_name ?? printing.name
  if (!hasTwoImages(printing.layout)) return null
  const parts = shown.split(' // ')
  return {
    front: { scryfallId: printing.scryfall_id, face: 0, title: parts[0] },
    back: {
      scryfallId: printing.scryfall_id,
      face: 1,
      title: parts.length > 1 ? parts.slice(1).join(' // ') : shown
    }
  }
}

/**
 * What to call a card, naming both sides when it has two.
 *
 * A two-faced printing is already named `A // B` by Scryfall, so today this composes
 * nothing and simply agrees with the printing. It stays as the one place that answers
 * "what do I call this card", which is where every tile and every row asks.
 */
export function bothSidesTitle(printing: {
  scryfall_id: string
  name: string
  printed_name?: string | null
  layout?: string | null
}): string {
  const sides = twoSides(printing)
  if (sides === null) return printing.printed_name ?? printing.name
  return `${sides.front.title} // ${sides.back.title}`
}

export interface Printing {
  scryfall_id: string
  oracle_id: string | null
  name: string
  /** Localized name, e.g. the Japanese or French title. Null for English printings. */
  printed_name: string | null
  lang: string
  set_code: string
  set_name: string
  collector_number: string
  rarity: Rarity
  mana_cost: string | null
  cmc: number | null
  type_line: string | null
  printed_type_line: string | null
  oracle_text: string | null
  /** Localized rules text. Null for English printings — fall back to oracle_text. */
  printed_text: string | null
  colors: string[]
  color_identity: string[]
  layout: string
  finishes: Finish[]
  /**
   * Scryfall's promo tags. These describe THE FOIL VERSION of this printing, not
   * the printing as a whole: a surge-foil card is sold as `["nonfoil","foil"]` and
   * only the foil one is a surge foil. Read it through `foilTreatmentOf`.
   */
  promo_types: string[]
  /**
   * Whether the card comes in booster packs, per Scryfall. Null only for a
   * printing cached before this was recorded — which is "unknown", not "no".
   */
  in_boosters: boolean | null
  image_uri_normal: string | null
  image_uri_small: string | null
  released_at: string | null
  prices: Prices | null
  price_updated_at: string | null
  /**
   * The English twin's prices, filled in by the query, when this printing has none.
   *
   * Optional because a printing straight off a Scryfall search has no twin resolved yet —
   * only a cached row can answer that. Read it through `priceOfPrinting`, never directly,
   * so a borrowed figure always arrives with the fact that it was borrowed.
   */
  borrowed_prices?: Prices | null
}

export interface CollectionItem {
  id: number
  scryfall_id: string
  finish: Finish
  condition: Condition
  quantity: number
  purchase_price: number | null
  notes: string | null
  added_at: string
  updated_at: string
}

/**
 * Where a collection row comes from.
 *
 * `collection` is a real `collection_items` row you entered. `deck` is derived:
 * a card sitting in an Archidekt deck under a label colour you have marked as
 * one you own. Derived rows are read-only — there is no underlying row to edit,
 * and the card is physically sleeved in a deck rather than loose in bulk.
 */
export type RowSource = 'collection' | 'deck'

export interface CollectionRow {
  /**
   * Stable identity for React keys and selection. Derived rows have no numeric
   * id, so everything the UI tracks per row keys off this instead.
   */
  key: string
  source: RowSource
  /** Null for a derived deck row. */
  id: number | null
  scryfall_id: string
  finish: Finish
  /**
   * Which kind of foil these copies are, e.g. `surgefoil`. Null for a nonfoil
   * copy or an ordinary foil. Normally derived from the printing.
   */
  foil_treatment: string | null
  /**
   * True when the treatment is one you set by hand rather than one read off the
   * printing, so the UI can mark it the way a declared language is marked.
   */
  treatment_forced: boolean
  /**
   * A proxy — a card you printed rather than bought.
   *
   * Distinct from `price_is_proxy`, which is about a borrowed *price*. A proxied
   * copy contributes nothing to any total while `unit_value` still reports the
   * printing's real market price, so the row says both "this is worth nothing to
   * me" and "this is what the real card costs".
   */
  proxied: boolean
  /** Null for a derived deck row — Archidekt does not record condition. */
  condition: Condition | null
  quantity: number
  purchase_price: number | null
  notes: string | null
  added_at: string | null
  updated_at: string | null
  printing: Printing
  /** Copies staged in open pick lists. Counts derived rows too — a sleeved card can be pulled. */
  reserved: number
  /** quantity minus reserved: what can still be staged, whichever source the row has. */
  available: number
  /** Number of synced decks containing this card (exact printing or same oracle id). */
  deck_count: number
  /** For a derived row, the decks the copies are sleeved in. */
  deck_names: string[]

  /** Unit value in the active currency, honouring finish. Null when Scryfall has no price. */
  unit_value: number | null
  /**
   * True when `unit_value` is another printing of the same card standing in,
   * because this printing carries no price of its own. The UI marks it, so a
   * shown price always means something exact.
   */
  price_is_proxy: boolean
  /**
   * True when the language and name shown are ones you declared, because Scryfall
   * has no printing of this card in that language. The printing underneath is
   * still a real one, and still what prices and rules text come from.
   */
  language_forced: boolean
  total_value: number | null
}

export type SortField =
  | 'name' | 'color' | 'cmc' | 'lang' | 'rarity' | 'set_code' | 'collector_number'
  | 'finish' | 'condition' | 'quantity' | 'unit_value' | 'total_value'
  | 'added_at'

/** Sort fields in menu order, with the labels the UI shows. */
export const SORT_FIELDS: { value: SortField; label: string }[] = [
  { value: 'name', label: 'Card name' },
  { value: 'color', label: 'Colour' },
  { value: 'cmc', label: 'Mana value' },
  { value: 'rarity', label: 'Rarity' },
  { value: 'set_code', label: 'Set' },
  { value: 'collector_number', label: 'Collector number' },
  { value: 'lang', label: 'Language' },
  { value: 'finish', label: 'Finish' },
  { value: 'condition', label: 'Condition' },
  { value: 'quantity', label: 'Quantity' },
  { value: 'unit_value', label: 'Unit value' },
  { value: 'total_value', label: 'Total value' },
  { value: 'added_at', label: 'Recently added' }
]

export interface CollectionFilters {
  search: string
  langs: string[]
  rarities: Rarity[]
  sets: string[]
  finishes: Finish[]
  /** Foil treatment tags, e.g. `surgefoil`. Empty means every treatment. */
  treatments: string[]
  /** null = every copy; true = only proxies; false = only real cards. */
  proxied: boolean | null
  conditions: Condition[]
  colors: string[]
  typeLine: string
  cmcMin: number | null
  cmcMax: number | null
  valueMin: number | null
  valueMax: number | null
  /** null = no deck filter; 'in' / 'out' = in any deck / in no deck; a number = that deck. */
  deckScope: null | 'in' | 'out' | number
  /**
   * Which row sources to include. null = both. Lets you see just the loose bulk
   * while sorting, or just what is sleeved in decks.
   */
  source: RowSource | null
  onlyReserved: boolean
  sort: SortField
  dir: 'asc' | 'desc'
  /**
   * Optional tie-breaker. A colour sort with no second level leaves each colour
   * internally jumbled, which is the case this exists for.
   */
  sort2: SortField | null
  dir2: 'asc' | 'desc'
}

export const DEFAULT_FILTERS: CollectionFilters = {
  search: '', langs: [], rarities: [], sets: [], finishes: [], treatments: [],
  proxied: null, conditions: [],
  colors: [], typeLine: '', cmcMin: null, cmcMax: null, valueMin: null,
  valueMax: null, deckScope: null, source: null, onlyReserved: false,
  sort: 'added_at', dir: 'desc', sort2: null, dir2: 'asc'
}

export interface CollectionPage {
  rows: CollectionRow[]
  total: number
  /** Sums over the whole filtered set, not just this page. */
  totalQuantity: number
  totalValue: number
  /** Split of the same totals, so the combined figure never hides its origin. */
  bulkQuantity: number
  bulkValue: number
  deckQuantity: number
  deckValue: number
}

export interface FacetCounts {
  langs: { value: string; count: number }[]
  rarities: { value: string; count: number }[]
  sets: { value: string; label: string; count: number }[]
  finishes: { value: string; count: number }[]
  treatments: { value: string; count: number }[]
  conditions: { value: string; count: number }[]
}

// ---------- Pick lists ----------

export type PickListStatus = 'open' | 'confirmed' | 'cancelled'

export interface PickList {
  id: number
  name: string
  status: PickListStatus
  created_at: string
  closed_at: string | null
  note: string | null
  itemCount: number
  cardCount: number
  totalValue: number
}

/**
 * One move of copies between a deck and the collection.
 *
 * `quantity` is signed: negative took copies out of the deck, positive put them in.
 * A move lives in this ledger only while Archidekt disagrees with what the deck
 * physically holds — once a sync catches up it is deleted, because there is nothing
 * left to record.
 *
 * Replaces `DeckPull`, which could only describe the out direction because taking
 * a card out of a deck was routed through a pick list. `PullSource` went with it:
 * nothing needs to ask where a card could be pulled from now that moving is direct.
 */
export interface DeckMove {
  id: number
  deck_id: number
  oracle_id: string
  scryfall_id: string
  finish: Finish
  condition: Condition
  quantity: number
  created_at: string
}

/**
 * A deck a copy could be taken out of, with how many are still takeable.
 *
 * Its own type rather than a `DeckRef`: that says where a card appears, this says
 * where one can be taken from, and it carries the `oracle_id` a `PickSource` needs.
 */
export interface DeckSource {
  deck_id: number
  deck_name: string
  oracle_id: string
  /** Copies still takeable: what the deck holds, less anything already staged. */
  quantity: number
}

export interface DeckRef {
  deck_id: number
  deck_name: string
  quantity: number
  /** exact = same printing and language; oracle = same card, different printing. */
  match: 'exact' | 'oracle'
  /** The finish these copies are held in, once your override is applied. */
  finish: Finish
  /** An override you set; null means the printing's own tag applies. */
  foil_treatment: string | null
  /** 1 when the finish is yours rather than Archidekt's. */
  finish_forced: number
}

/**
 * What a pull does with the copies when the list is validated.
 *
 * A collection row only ever has one answer — it leaves your possession, which is
 * what a pick list is for. A deck card has two, and they are genuinely different
 * acts: taking it out to put in your box, or taking it out to sell. The list is a
 * batch of things to physically do, so it has to carry which.
 */
export type PickDestination = 'collection' | 'gone'

/**
 * Where a staged copy comes from.
 *
 * A deck card has no `collection_items` row to name, so the source says which of
 * the two it is rather than passing a number and guessing — and a deck source
 * carries its destination, because taking a card out of a deck does not say by
 * itself whether you are keeping it.
 */
export type PickSource =
  | { kind: 'collection'; itemId: number }
  | {
      kind: 'deck'
      deckId: number
      oracleId: string
      destination: PickDestination
    }

export interface PickListItem {
  /** The printing's layout, for deciding whether a tile draws two sides. */
  layout?: string | null
  id: number
  pick_list_id: number
  collection_item_id: number | null
  quantity: number
  /** Snapshot, so confirmed lists stay readable after the collection row is gone. */
  scryfall_id: string
  name: string
  printed_name: string | null
  lang: string
  set_code: string
  set_name: string
  collector_number: string
  rarity: Rarity
  finish: Finish
  /** Which kind of foil, snapshotted with the finish. */
  foil_treatment: string | null
  /** A proxy, snapshotted so a confirmed list still reads honestly. */
  proxied: number
  condition: Condition
  image_uri_small: string | null
  unit_value: number | null
  /** Copies still in the collection. Null once the row has been removed. */
  owned_quantity: number | null
  /**
   * What validating will do with a deck-sourced copy, or null for a collection row.
   *
   * Worth showing: a list can hold both a card you are pulling out to keep and one
   * you are pulling out to sell, and nothing else on the row distinguishes them.
   */
  destination: PickDestination | null
  /** Decks that use this card, so we can warn before pulling it. */
  decks: DeckRef[]
}

// ---------- Decks ----------

export interface Deck {
  id: number
  source: 'archidekt'
  external_id: string
  name: string
  format: string | null
  owner_username: string | null
  url: string | null
  external_updated_at: string | null
  last_synced_at: string | null
  is_private: boolean
  is_unlisted: boolean
  sync_error: string | null
  cardCount: number
  /** Whole-deck language default that per-card overrides take precedence over. */
  default_lang: string | null
}

export interface DeckCardRow {
  /** The printing's layout, for deciding whether a tile draws two sides. */
  layout?: string | null
  id: number
  deck_id: number
  scryfall_id: string | null
  oracle_id: string | null
  quantity: number
  finish: Finish
  /** True when the finish is one you set, not the one Archidekt reported. */
  finish_forced: boolean
  /** Which kind of foil, e.g. `surgefoil`. Null for nonfoil or an ordinary foil. */
  foil_treatment: string | null
  /** True when the treatment is yours rather than read off the printing. */
  treatment_forced: boolean
  /**
   * A proxy filling this slot. Counts as held — it is playable — and contributes
   * nothing to the missing-pile value, since there is nothing left to buy.
   */
  proxied: boolean
  categories: string[]
  in_maindeck: boolean
  name: string
  lang: string
  set_code: string | null
  collector_number: string | null
  rarity: Rarity | null
  image_uri_small: string | null
  /** Archidekt's raw per-card label, of the form "name,#color". */
  label: string | null
  /** Parsed from `label` — the name is frequently empty, the colour rarely is. */
  label_name: string | null
  label_color: string | null
  /**
   * What the label's colour means for possession, or null when the colour is not
   * mapped. `not_owned` still lists the card in the deck but stops the deck
   * counting as a place it lives; `owned` makes those copies count as part of
   * your collection.
   */
  label_possession: Possession | null
  /** Copies you own of this exact printing. */
  owned_exact: number
  /** Copies you own of this card in any printing or language. */
  owned_any: number
  /**
   * Copies this deck actually holds for the entry.
   *
   * The deck vouching for its own quantity: an "owned" label, or a proxy filling the
   * slot. This is what "have it" means on the Decks screen — a card sitting in your bulk
   * is yours, but it is not in the deck.
   */
  in_deck: number
  /**
   * Copies of it loose in your collection, accounting for the exact-printing setting.
   *
   * Kept apart from `in_deck` on purpose. The two were added together and the sum was
   * called "owned", so a deck holding none of a card you happened to have four of read
   * "have 4" and turned green.
   */
  in_collection: number
  /**
   * `in_deck + in_collection` — everywhere a copy for this entry could be.
   *
   * Still derived once in the main process, and still what the move and pick-list paths
   * read. The Decks screen does not display it any more: it shows the two halves.
   */
  held: number
  /**
   * Net local divergence from the decklist for this card, or 0 when there is none.
   *
   * Negative means copies were taken out of the deck, positive that copies were
   * put in, in both cases while Archidekt still says otherwise. Reported rather
   * than applied: `quantity` above already accounts for it, because a move is
   * written into the deck rows instead of adjusted while reading them.
   */
  moved: number
  /** The moves behind `moved`, newest first, so each can be reverted on its own. */
  moves: DeckMove[]
  /** True when this card sits in the deck's premier category (its commander). */
  is_commander: boolean
  /**
   * The category this entry is drawn under: its main one, and only that one.
   *
   * Archidekt lists a card's categories with the main one first — measured across 744
   * entries, an excluded category appears first 132 times and later never — so the first is
   * the section. A card carrying `Aura Buffs` as a second tag is not drawn under Aura Buffs
   * and is not found by filtering for it.
   *
   * When a card has no categories at all, Archidekt's UI files it under the card's *type*,
   * and the types come down in the same deck JSON — so that is used rather than a bucket the
   * app invents. `Uncategorized` is the last resort, for an entry with neither.
   *
   * Note what does *not* decide this: `includedInDeck`. A card whose main category is
   * `Maybeboard` belongs in Maybeboard. Skipping excluded categories when choosing is what
   * made those cards surface in whatever they happened to carry second.
   */
  section: string
  /**
   * Whether this entry counts towards the deck's totals.
   *
   * True when none of its categories is one Archidekt excludes. Stricter than the stored
   * `in_maindeck`, which asks whether *any* category is included: on the deck that prompted
   * this, the two disagree about 57 entries — all of them Maybeboard cards that also carry a
   * real category, and the difference between calling it a 157-card deck and a 100-card one.
   *
   * There is deliberately no owning-category field. A card is drawn under every category it
   * carries, so which section a row belongs to is a property of the row, not of the card.
   */
  counts: boolean
  /** Language actually recorded for this entry, once an override is applied. */
  override_lang: string | null
  /** Joined from the printing, so the deck screen can filter and sort locally. */
  cmc: number | null
  color_identity: string | null
  type_line: string | null
  /**
   * The card's rules text, English and localized joined, for the search box only.
   *
   * Nothing displays this. It is one field rather than two columns because the breakdown
   * is re-fetched on every invalidation and a big deck would otherwise ship the same text
   * twice over the IPC each time.
   */
  search_text: string | null
  unit_value: number | null
  /** True when `unit_value` came from a different printing of the same card. */
  price_is_proxy: boolean
  /** True when this entry's language and name are ones you declared. */
  language_forced: boolean
  /**
   * Set when a language was requested for this card but Scryfall has no printing
   * in it, so the original printing was kept rather than silently relabelled.
   */
  language_unavailable: string | null
}

export interface DeckGroup {
  /** Category name, e.g. "Land" or "Maybeboard". */
  name: string
  /** Archidekt's `includedInDeck` — false for Maybeboard and the like. */
  inDeck: boolean
  /** The deck's premier category: its commander, Oathbreaker, and so on. */
  isPremier: boolean
  cards: DeckCardRow[]
  /**
   * Sums of quantity, not row counts — a Forest x8 entry counts as 8.
   *
   * Each card is drawn in one section, so these partition the deck: they add up to
   * `DeckTotals.cards`. A section whose category Archidekt excludes counts towards that
   * total and not towards `inDeckCards`.
   */
  cardCount: number
  /** Copies the deck holds. */
  ownedCards: number
  /** Copies it does not hold but you do. */
  inCollectionCards: number
  /** Copies nobody has. The three sum to `cardCount`. */
  missingCards: number
  missingValue: number
  /** True when any card in this group priced off another printing. */
  missingValueIsProxy: boolean
}

/**
 * The deck, counted once.
 *
 * Computed over the entries rather than by summing the sections. The sections do partition
 * the cards, so the two agree — but the totals have to skip the entries Archidekt excludes,
 * which is a question about a card and not about a section.
 */
export interface DeckTotals {
  /** Sum of quantity across every entry — how long the decklist is. */
  cards: number
  /** Row count, which is a different and much less useful number. */
  entries: number
  /** Σ quantity over entries that count: `inDeckCards + excludedCards === cards`. */
  inDeckCards: number
  /** Σ quantity over entries carrying a category Archidekt excludes. */
  excludedCards: number
  /** Σ min(in_deck, quantity) — copies the decks themselves hold. */
  ownedCards: number
  /** Σ of the shortfall your loose copies cover. Yours, but not in the deck. */
  inCollectionCards: number
  /**
   * Σ what is neither in the deck nor in your collection.
   *
   * The three sum to `cards` — every entry, excluded categories included. They summed to
   * `inDeckCards` for a while, on the reasoning that a card Archidekt excludes is not
   * something the deck is missing; but the missing *filter* has always tested every entry,
   * so a deck whose shortfall sat in the Maybeboard listed those cards under a counter
   * reading 0. `inDeckCards` is where "does this count towards the 100" is answered.
   */
  missingCards: number
  missingValue: number
  /** True when any card contributing to the value priced off another printing. */
  missingValueIsProxy: boolean
}

export interface DeckBreakdown {
  deck: Deck
  /** Premier group first, then in-deck categories, then excluded ones. */
  groups: DeckGroup[]
  /**
   * Every entry once, in name order.
   *
   * `groups[].cards` are references into this. The totals, the facets and the selection all
   * resolve against this list rather than against the sections, so none of them can start
   * counting rows if the grouping rule changes again.
   */
  cards: DeckCardRow[]
  /**
   * Every category Archidekt defines for this deck, plus any a card carries that the
   * definitions do not, plus `Uncategorized` when something needs it. Card counts may be
   * zero: a category with no cards is still a category, and still worth filtering by.
   */
  categories: { name: string; inDeck: boolean; isPremier: boolean; cardCount: number }[]
  /** Distinct Archidekt labels present on this deck's cards. */
  labels: { name: string | null; color: string | null; cardCount: number }[]
  /** Languages this deck's cards are actually in, for the dynamic filter. */
  languages: { lang: string; cardCount: number }[]
  totals: DeckTotals
}

/**
 * The section for entries carrying no Archidekt category at all.
 *
 * Not a category the app invents to file things under — Archidekt shows one of these too,
 * so this mirrors it. A deck whose cards are all categorised never sees it.
 */
export const UNCATEGORIZED = 'Uncategorized'

/**
 * The main category out of what Archidekt sent, resolved once in the main process.
 *
 * `premier` wins where the card carries one, so the commander keeps its own section whatever
 * order its categories arrive in. Otherwise it is the first category, then the first type,
 * then nothing to go on.
 */
export function deckSection(
  categories: readonly string[],
  types: readonly string[],
  premier: ReadonlySet<string>
): string {
  return (
    categories.find((name) => premier.has(name)) ??
    categories[0] ??
    types[0] ??
    UNCATEGORIZED
  )
}

// ---------- Deck screen filters ----------

export type DeckOwnership = 'all' | 'owned' | 'inCollection' | 'missing'

/**
 * Where the copies for one deck entry stand: in the deck, in your bulk, or nowhere.
 *
 * Allocated in that order, so the three always add up to what the entry asks for. Shared
 * because it is worked out twice: once in the breakdown, and again in the renderer when a
 * filter changes which cards a group contains. Those were two copies of the same sum, and
 * two copies of a sum are two chances to disagree about whether a deck is finished.
 *
 * `missing` is what it always was -- the shortfall your bulk does not cover -- so the
 * missing pile still means "money you would have to spend". What this splits is the other
 * side: a card sitting in your collection is yours, but it is not in your deck.
 */
export function allocateCopies(card: {
  quantity: number
  in_deck: number
  in_collection: number
}): { inDeck: number; fromCollection: number; missing: number } {
  const inDeck = Math.min(card.in_deck, card.quantity)
  const fromCollection = Math.min(Math.max(0, card.quantity - inDeck), card.in_collection)
  return { inDeck, fromCollection, missing: Math.max(0, card.quantity - inDeck - fromCollection) }
}

export type DeckSortField =
  | 'name' | 'color' | 'cmc' | 'rarity' | 'set_code' | 'ownership' | 'price'

export const DECK_SORT_FIELDS: { value: DeckSortField; label: string }[] = [
  { value: 'name', label: 'Card name' },
  { value: 'color', label: 'Colour' },
  { value: 'cmc', label: 'Mana value' },
  { value: 'rarity', label: 'Rarity' },
  { value: 'set_code', label: 'Set' },
  { value: 'ownership', label: 'Ownership' },
  { value: 'price', label: 'Price' }
]

export interface DeckFilters {
  search: string
  ownership: DeckOwnership
  /** Category names to keep. Empty means every category. */
  categories: string[]
  colors: string[]
  rarities: Rarity[]
  typeLine: string
  /** Scryfall language codes to keep, tested against the card's effective language. */
  langs: string[]
  /**
   * Label colours to keep, plus the sentinel below for cards with no label at
   * all — otherwise "unlabelled" would be unreachable.
   */
  labels: string[]
  sort: DeckSortField
  dir: 'asc' | 'desc'
  sort2: DeckSortField | null
  dir2: 'asc' | 'desc'
}

/** Stands in for "this card has no Archidekt label" in `DeckFilters.labels`. */
export const NO_LABEL = '__none__'

export const DEFAULT_DECK_FILTERS: DeckFilters = {
  search: '',
  ownership: 'all',
  categories: [],
  colors: [],
  rarities: [],
  typeLine: '',
  langs: [],
  labels: [],
  sort: 'name',
  dir: 'asc',
  sort2: null,
  dir2: 'asc'
}

/** A label colour found across synced decks, for the Settings picker. */
export interface DeckLabelColor {
  color: string
  /** The most common name seen with this colour, or null when always unnamed. */
  name: string | null
  cardCount: number
  deckCount: number
  possession: Possession | null
}

/** Everywhere a card currently is. */
/**
 * What an opened card belongs to, so the detail view can change it.
 *
 * A deck entry is keyed by oracle id (its override survives Archidekt moving the
 * entry to another printing); a collection row is keyed by its own row id, since
 * a collection row *is* a printing.
 */
export type CardContext = { forcedLang: string | null } & (
  | { kind: 'deck'; deckId: number; oracleId: string; deckName: string }
  | { kind: 'collection'; itemId: number }
)

/** One sealed product that contains boosters, from MTGJSON. */
export interface BoosterProduct {
  name: string
  category: string | null
  subtype: string | null
  /** Which booster type it contains. */
  booster: string
  /** How many of them, so a product's chance follows from a pack's. */
  boosterCount: number
}

export interface BoosterSetInfo {
  set_code: string
  fetched_at: string
  boosters: {
    code: string
    name: string
    cardsPerPack: number
    /**
     * The share of this booster's picks we can name, 0 to 1.
     *
     * Sheets may list cards from *other* sets — bonus sheets, The List, box
     * toppers — and those uuids are not in this set's card list, so they carry no
     * Scryfall id to join on. HOB's box-topper booster is 100% such cards, which
     * meant every card read "0%" there when the truth is that this data says
     * nothing about it. Below 1 the odds are a floor, not an answer.
     */
    coverage: number
  }[]
  products: BoosterProduct[]
}

/**
 * The chance of pulling one card from each of its set's boosters.
 *
 * Three states, kept apart because they are three different answers:
 *
 *  - `fetched: true` — the real per-booster figures. These always win.
 *  - `in_boosters: true, fetched: false` — Scryfall says it does come in
 *    boosters; the chance has not been computed yet.
 *  - `in_boosters: false, fetched: false` — Scryfall does not list this printing
 *    as a booster card. A weaker statement than it sounds, so the fetch stays
 *    available: measured against real MTGJSON data, 14 of the 32 printings with
 *    genuine odds have this flag false, because Scryfall sets it on the *default*
 *    printing and a showcase or borderless version of the same card is still
 *    pulled from play and collector boosters. Claiming "not sold in boosters"
 *    here would hide real odds for exactly the cards worth chasing.
 *
 * Conflating the last two is what made the panel say nothing useful about a
 * collection whose sets had never been fetched.
 */
/** One finish's chance of turning up in one booster. */
export interface BoosterChance {
  /** P(at least one copy in one pack). Zero means on none of its sheets. */
  probability: number
  /** Expected copies per pack. */
  expected: number
  /** True when a colour-balanced sheet makes the figure approximate. */
  approximate: boolean
}

export interface BoosterOdds {
  fetched: boolean
  /**
   * Scryfall's `booster` flag for this printing, available for every card without
   * any download. True is trustworthy; false only means *this* printing is not
   * the booster one. Null for a printing cached before it was recorded, which is
   * "unknown" rather than "no".
   */
  in_boosters: boolean | null
  set_code: string
  boosters: {
    code: string
    name: string
    cardsPerPack: number
    /** See `BoosterSetInfo.coverage`. Zero means this booster is unaccounted for. */
    coverage: number
    /**
     * The chance per finish, because MTGJSON's sheets are per finish and the two
     * differ enormously — a HOB play booster gives Thranduil #167 at 1.75%
     * nonfoil but 0.125% foil.
     *
     * A bucket is **null when the printing does not come in that finish at all**,
     * which is a different statement from 0%: a foil-only surge printing has no
     * nonfoil version to pull, rather than a nonfoil version you never hit.
     */
    nonfoil: BoosterChance | null
    foil: BoosterChance | null
  }[]
  products: BoosterProduct[]
  /**
   * True when the figures were found through the card's English sibling.
   *
   * MTGJSON keys its sheets on the English printing's Scryfall id, so a French
   * card matches nothing on its own. The odds are identical — it is the same slot
   * in the same pack — but saying where the number came from is honest.
   */
  via_english: boolean
}

export interface CardLocations {
  scryfall_id: string
  oracle_id: string | null
  name: string
  printed_name: string | null
  /**
   * Every copy of this *card* you hold, not only of the printing asked for.
   *
   * Scoped to the oracle id, because a printing is not a card: your French copy and
   * your English one are different `scryfall_id`s, and keying this on the printing
   * meant each was invisible from the other's detail page -- so "keep the foil, drop
   * the other" could not be done from one screen. The printing asked for comes first.
   *
   * Each entry therefore carries its own identity: a row here may be a different
   * printing from the one at the top of this object.
   */
  loose: {
    collection_item_id: number
    scryfall_id: string
    set_code: string
    set_name: string
    collector_number: string
    lang: string
    printed_name: string | null
    /** True for rows on the printing this lookup was keyed on. */
    same_printing: boolean
    finish: Finish
    /** An override you set; null means the printing's own tag applies. */
    foil_treatment: string | null
    condition: Condition
    quantity: number
    reserved: number
    /**
     * The row's own printing, for the finish picker: which finishes it was sold in,
     * and the promo tags that say what its foil version is. See `foilTreatmentOf`.
     */
    finishes: Finish[]
    promo_types: string[]
  }[]
  reservations: { pick_list_id: number; pick_list_name: string; quantity: number }[]
  decks: DeckRef[]
}

// ---------- Add cards ----------

/**
 * Narrowing a card's printings down to the one you are holding.
 *
 * Every axis is multi-select and empty means "all", matching how the collection
 * and deck filters already behave. All four read fields `PrintingChoice` already
 * carries, so filtering costs no extra lookup.
 */
export interface PrintingFilters {
  langs: string[]
  sets: string[]
  rarities: Rarity[]
  /** Printings that come in this finish — a foil-only promo matches `foil`. */
  finishes: Finish[]
}

export const DEFAULT_PRINTING_FILTERS: PrintingFilters = {
  langs: [],
  sets: [],
  rarities: [],
  finishes: []
}

export interface PrintingChoice extends Printing {
  /** Copies of this exact printing already in the collection. */
  owned: number
}

export interface AddCardInput {
  scryfall_id: string
  finish: Finish
  condition: Condition
  quantity: number
  purchase_price?: number | null
  notes?: string | null
  /**
   * Only set when the copies being added are known proxies. Note that
   * `collection_items` is UNIQUE on (scryfall_id, finish, condition) and does
   * *not* include this, so a proxy merges into a real copy of the same printing
   * and would flag it too — which is why pulling a proxied deck entry is
   * refused rather than merged. See PICK_PROXY_REFUSED in pickLists.ts.
   */
  proxied?: boolean
}

export interface QuickAddInput {
  set: string
  collectorNumber: string
  lang: string
  finish: Finish
  condition: Condition
  quantity: number
  /**
   * The denominator printed on the card, when it was typed. Distinguishes a token
   * sheet from the set at the same number -- see `parseCollectorNumber`.
   */
  sheetTotal?: number | null
}

// ---------- CSV ----------

export interface CsvColumnMap {
  quantity?: string
  name?: string
  set?: string
  collectorNumber?: string
  lang?: string
  finish?: string
  condition?: string
  scryfallId?: string
  purchasePrice?: string
}

export type CsvPreset = 'auto' | 'manabox' | 'moxfield' | 'deckbox' | 'matomeru' | 'manual'

export interface CsvPreview {
  headers: string[]
  detectedPreset: CsvPreset
  map: CsvColumnMap
  sampleRows: Record<string, string>[]
  totalRows: number
}

export interface CsvResolvedRow {
  rowIndex: number
  raw: Record<string, string>
  status: 'matched' | 'ambiguous' | 'unmatched'
  quantity: number
  finish: Finish
  /** A foil type named in the file, e.g. `surgefoil`. Null when it said nothing. */
  treatment: string | null
  condition: Condition
  printing?: Printing
  candidates?: Printing[]
  reason?: string
}

export interface CsvDryRun {
  rows: CsvResolvedRow[]
  matched: number
  ambiguous: number
  unmatched: number
}

// ---------- Progress ----------

export interface ProgressEvent {
  job:
    | 'csv-import'
    | 'deck-sync'
    | 'deck-language'
    | 'collection-language'
    | 'booster-odds'
    | 'price-sync'
    | 'price-fill'
    | 'backup'
    | 'update'
  phase: string
  done: number
  total: number
  message?: string
  finished?: boolean
  error?: string
}

// ---------- Stats ----------

export interface Stats {
  totalCards: number
  distinctPrintings: number
  totalValue: number
  /** Cards you entered yourself, loose in bulk. */
  bulkCards: number
  bulkValue: number
  /** Cards sleeved in decks under a colour you marked as owned. */
  deckCards: number
  deckValue: number
  currency: Currency
  lastPriceSync: string | null
  byRarity: { key: string; count: number; value: number }[]
  byLanguage: { key: string; count: number; value: number }[]
  bySet: { key: string; label: string; count: number; value: number }[]
  topCards: {
    scryfall_id: string
    name: string
    printed_name: string | null
    lang: string
    set_code: string
    quantity: number
    unit_value: number
    total_value: number
  }[]
  inDecks: number
  notInDecks: number
}

// ---------- Grids ----------

/** The four image grids, each remembering its own column count. */
export type GridKey = 'collection' | 'printings' | 'picks' | 'decks'

export const GRID_MIN_COLUMNS = 2
export const GRID_MAX_COLUMNS = 14

export const DEFAULT_GRID_COLUMNS: Record<GridKey, number> = {
  collection: 7,
  printings: 6,
  picks: 6,
  decks: 8
}

/**
 * Returns a usable column count, or null when the input is not a number at all.
 *
 * The explicit null/empty-string rejection matters: `Number(null)` and
 * `Number('')` are both `0`, not `NaN`, so without it a missing stored value
 * would silently clamp to the minimum instead of falling back to the default.
 */
export function clampColumns(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return null
  return Math.min(GRID_MAX_COLUMNS, Math.max(GRID_MIN_COLUMNS, Math.round(n)))
}

/**
 * Tile-width thresholds for how much detail a card tile shows.
 *
 * Keyed on measured width rather than column count on purpose: twelve columns on
 * a 2560px monitor still leaves a comfortably large tile.
 */
export const TILE_DENSITY = { minimal: 110, compact: 160 } as const
export type TileDensity = 'minimal' | 'compact' | 'full'

export function tileDensity(width: number): TileDensity {
  if (width < TILE_DENSITY.minimal) return 'minimal'
  if (width < TILE_DENSITY.compact) return 'compact'
  return 'full'
}

/**
 * What an Archidekt label colour means for possession.
 *
 * Absent (no entry for a colour) is the third state: the label is ignored and
 * ownership is derived purely from the collection, which is the default.
 */
export type Possession = 'owned' | 'not_owned'

/** Screens that offer a list/grid choice, and what each calls its two modes. */
export interface ViewModes {
  collection: 'table' | 'gallery'
  picks: 'rows' | 'grid'
  decks: 'rows' | 'grid'
}

// ---------- Pages ----------

/** The two lists long enough to page: your bulk, and a deck of any size. */
export type PagedScreen = 'collection' | 'decks'

/**
 * How many cards a page holds, offered as a menu rather than a free number.
 *
 * The floor is 50 on purpose. Both lists are virtualized, so a page of ten would draw fewer
 * rows than the virtualizer already paints and make "everything on this page" smaller than
 * what is on screen — and the live checks that count painted rows against selected ones
 * would start failing on correct code.
 */
export const ROWS_PER_PAGE_CHOICES = [50, 100, 200, 500] as const

export const DEFAULT_ROWS_PER_PAGE: Record<PagedScreen, number> = {
  collection: 200,
  decks: 200
}

/**
 * Returns one of the offered page sizes, or null when the input is not a number at all.
 *
 * Null and the empty string are rejected before `Number` sees them, for the reason
 * `clampColumns` documents: both convert to 0, so a missing stored value would silently
 * become the smallest page instead of falling back to the default.
 */
export function clampRowsPerPage(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return null
  // The nearest offered size, so a stored 250 from a future build lands on 200 rather than
  // on a page size no menu can show.
  return ROWS_PER_PAGE_CHOICES.reduce((best, choice) =>
    Math.abs(choice - n) < Math.abs(best - n) ? choice : best
  )
}

export const DEFAULT_VIEW_MODES: ViewModes = {
  collection: 'table',
  // Rows by default on both: a pick list or deck list is something you read while
  // handling cards, not something you browse as art.
  picks: 'rows',
  decks: 'rows'
}

/**
 * What the undo stack can currently do, for the UI to label and disable by.
 *
 * Labels arrive already translated: the stack lives in the main process, which is
 * where the locale is resolved for every other message that reaches the user
 * verbatim.
 */
export interface UndoState {
  canUndo: boolean
  canRedo: boolean
  /** What Ctrl+Z would take back, or null when there is nothing. */
  undoLabel: string | null
  redoLabel: string | null
}

export interface AppSettings {
  currency: Currency
  archidektUsername: string
  lastPriceSync: string | null
  reduceMotion: boolean
  deckMatchExact: boolean
  gridColumns: Record<GridKey, number>
  /**
   * Archidekt label colours (lowercase hex) mapped to what they mean. Matched on
   * colour alone, because Archidekt label names are usually empty. A colour with
   * no entry here is ignored.
   */
  labelPossession: Record<string, Possession>
  /** List/grid choice per screen. A display preference, so it survives restarts. */
  viewModes: ViewModes
  /**
   * Cards per page, per screen. A display preference like the others, so it survives a
   * restart and never triggers a refetch of anything but the list that owns it.
   */
  rowsPerPage: Record<PagedScreen, number>
  /**
   * Whether a deck is grouped by its Archidekt categories. Off gives one flat
   * "Deck" section, with the commander and the excluded piles still separated —
   * a display preference, so it survives restarts.
   */
  deckGroupByCategory: boolean
  /**
   * The language of the app itself, not of the cards. `system` follows the OS.
   * A display preference, so it survives restarts and must never trigger a
   * refetch — nothing about what a query returns depends on it.
   */
  locale: LocaleSetting
  /**
   * Which colour scheme paints the shell and the accent. A display preference,
   * so it survives restarts. `matomeru` is the app's own look; the rest are
   * ports of Tadami's schemes, which is where the names come from.
   */
  theme: ThemeName
  /** Light or dark. `system` follows the OS, exactly as `locale` does. */
  themeMode: ThemeMode
  /** Whether to look for a new release shortly after launch. */
  checkUpdatesOnLaunch: boolean
  /**
   * True black backgrounds for OLED panels, where a near-black still glows.
   * Only meaningful in dark mode, so the UI hides it in light.
   */
  pureBlack: boolean
}

/**
 * The colour schemes, in the order the picker shows them: the app's own first,
 * then Tadami's eleven alphabetically.
 *
 * A theme is three CSS seeds — an accent, a neutral to tint the shell with, and
 * how hard to tint — not a transplanted palette; see index.css. The `swatch`
 * here is only for the picker's preview, which has to paint a colour before the
 * theme is applied and so cannot read it back out of a variable.
 *
 * Names are deliberately untranslated. They are proper nouns, like set names.
 */
export const THEMES = [
  { name: 'matomeru', label: 'Matomeru', swatch: '#d1a24b', shell: '#0b0d12' },
  { name: 'doom', label: 'Doom', swatch: '#f38020', shell: '#141112' },
  { name: 'greenapple', label: 'Green Apple', swatch: '#188140', shell: '#121412' },
  { name: 'lavender', label: 'Lavender', swatch: '#a177ff', shell: '#0e0e1a' },
  { name: 'midnightdusk', label: 'Midnight Dusk', swatch: '#f02475', shell: '#100f15' },
  { name: 'strawberry', label: 'Strawberry', swatch: '#ed4a65', shell: '#141112' },
  { name: 'tadami', label: 'Tadami', swatch: '#2979ff', shell: '#0d0f13' },
  { name: 'tako', label: 'Tako', swatch: '#f3b375', shell: '#100f16' },
  { name: 'tealturquoise', label: 'Teal Turquoise', swatch: '#40e0d0', shell: '#0c1215' },
  { name: 'tidalwave', label: 'Tidal Wave', swatch: '#5ed4fc', shell: '#100f15' },
  { name: 'yinyang', label: 'Yin Yang', swatch: '#f2f2f2', shell: '#080809' },
  { name: 'yotsuba', label: 'Yotsuba', swatch: '#ae3200', shell: '#141112' }
] as const

export type ThemeName = (typeof THEMES)[number]['name']

export type ThemeMode = 'system' | 'light' | 'dark'

const THEME_NAMES = new Set<string>(THEMES.map((t) => t.name))

/** A stale or hand-edited value must never leave the app unpainted. */
export function parseTheme(raw: string | null | undefined): ThemeName {
  return raw && THEME_NAMES.has(raw) ? (raw as ThemeName) : 'matomeru'
}

export function parseThemeMode(raw: string | null | undefined): ThemeMode {
  return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : 'dark'
}

// ---------- Backup ----------

/**
 * What a snapshot says about itself.
 *
 * Travels with the remote copy rather than beside it — as Drive `appProperties`
 * on the file — so one metadata request tells the dialog when the remote was
 * written, from which machine, and whether it matches what this machine holds,
 * without pulling 33 MB down to find out.
 */
export interface BackupManifest {
  /** When the snapshot was taken, ISO 8601. */
  snapshotAt: string
  /** The highest migration the writing app had applied. Restore refuses a higher one. */
  schemaVersion: number
  appVersion: string
  /**
   * SHA-256 of the bytes actually uploaded — the compressed file, not the database
   * inside it. That is what makes it able to prove a download arrived intact.
   */
  sha256: string
  /** Size of the uploaded, compressed file. */
  bytes: number
  /** Size of the database inside it, so the saving can be reported rather than implied. */
  uncompressedBytes: number
  /** Hostname of the machine that wrote it, which is what makes a clobber detectable. */
  machine: string
  cards: number
  decks: number
  pickLists: number
}

/** The remote as the dialog needs to describe it. Carries no credential, ever. */
export interface BackupStatus {
  /** A client id and secret are available — compiled into this build, or entered. */
  configured: boolean
  /**
   * True when this build carries its own OAuth client, so connecting is one click and
   * Settings needs to ask for nothing. False means the credential fields are the only
   * way in, and Settings says so rather than offering a button that cannot work.
   */
  bundled: boolean
  /** The Drive folder backups go into, by name. Never null; defaults to 'Matomeru'. */
  folderName: string
  /** Those credentials have been exchanged for a refresh token that still works. */
  connected: boolean
  /** Where the snapshot lives, for messages: the Drive folder name. */
  label: string
  /** When this machine last wrote a snapshot, ISO 8601. */
  lastBackupAt: string | null
  /** What is on the remote now, or null when nothing has ever been written. */
  remote: (BackupManifest & { bytes: number }) | null
  /**
   * True when the remote holds a snapshot this machine has never seen: newer than
   * our own last write, and stamped by a different machine. Saving over it would
   * lose whatever that machine did.
   */
  remoteIsNewer: boolean
  /** True when a fresh local snapshot would be byte-identical to the remote. */
  upToDate: boolean
  /** Set when the last status read failed — a revoked token, no network. */
  error: string | null
}

export interface BackupResult {
  /** False when nothing had been written since the last backup, so nothing was sent. */
  uploaded: boolean
  /** What went over the wire, compressed. */
  bytes: number
  /** What it was before compression, for a message that shows the saving. */
  uncompressedBytes: number
  at: string
  /** How many history copies were dropped by rotation. */
  pruned: number
}

export interface RestoreResult {
  bytes: number
  /** Where the pre-restore copy of the local database was kept. */
  safetyCopy: string
  /** The manifest of what was restored, for the message. */
  manifest: BackupManifest
}

// ---------- Updates ----------

/**
 * What updating can do in this build.
 *
 * - `auto` — an installed build: check, download, install on restart.
 * - `notify` — a portable build: nothing can be installed over it, so the most it can
 *   honestly do is notice a release and offer to open its page.
 * - `disabled` — not packaged at all, where `autoUpdater` throws.
 *
 * Declared here rather than beside the function that computes it, because this file
 * is compiled for the renderer as well and cannot reach into the main process.
 */
export type UpdateMode = 'auto' | 'notify' | 'disabled'

/**
 * What the Settings panel needs to describe updating.
 *
 * One shape for all three modes, so the panel has a single thing to render rather
 * than a branch per build type. `available` stays null until a check has actually
 * found something — "no update" and "have not looked" are different states, and
 * conflating them makes a silent launch check look like a clean bill of health.
 */
export interface UpdateState {
  mode: UpdateMode
  /** The running version, from Electron itself rather than from package.json at runtime. */
  current: string
  /** Set once a check has completed, whatever it found. */
  checkedAt: string | null
  /** The newer release, when there is one. */
  available: { version: string; notes: string; url: string } | null
  /** True once the installer is on disk and only a restart stands in the way. */
  downloaded: boolean
  /** True while a download is running, so the button can say so. */
  downloading: boolean
  /** Set when the last check or download failed. Null after a success. */
  error: string | null
}

/**
 * Whether an update is worth putting a dialog in front of someone.
 *
 * A function rather than a condition inside the subscription, because the interesting
 * case is easy to get wrong and impossible to see: mid-download the answer must be no, or
 * the dialog reopens on top of the progress it started. Downloaded is a yes again — that
 * is the "install, or not" prompt.
 *
 * Declared here rather than beside the updater because the renderer decides when to show
 * a dialog, and the renderer cannot import from the main process.
 */
export function shouldPrompt(state: {
  available: UpdateState['available']
  downloading: boolean
  /**
   * Taken, and deliberately not consulted: a landed download is a prompt again, because
   * that is the "install, or not" question. Named so the state table can say so.
   */
  downloaded: boolean
}): boolean {
  if (state.available === null || state.available === undefined) return false
  if (state.downloading) return false
  return true
}
