import type { Finish } from '@shared/types'
import type { DeckCardUpsert, DeckUpsert } from '../db/repos/decks.js'
import { deckUrl, formatName, type ArchidektDeck, type ArchidektDeckCard } from './client.js'

function toFinish(modifier: string | null): Finish {
  switch ((modifier ?? '').toLowerCase()) {
    case 'foil':
      return 'foil'
    case 'etched':
      return 'etched'
    default:
      return 'nonfoil'
  }
}

/**
 * Whether a card counts as part of the deck proper.
 *
 * Archidekt models sideboards and maybeboards as categories with
 * `includedInDeck: false`, so a card sitting only in those is not really
 * committed to the deck. A card with no categories is treated as in-deck.
 */
export interface ParsedLabel {
  name: string | null
  /** Lowercased hex, e.g. "#f47373". */
  color: string | null
}

/**
 * Parses Archidekt's per-card label, which is a single `"name,#color"` string.
 *
 * The name is very often empty (`",#656565"` is what an unnamed label looks
 * like), which is why the app keys "I don't own this" off the colour. The first
 * group is greedy so a label name containing a comma still parses correctly.
 */
export function parseLabel(raw: string | null | undefined): ParsedLabel {
  const value = (raw ?? '').trim()
  if (!value) return { name: null, color: null }

  const match = value.match(/^(.*),(#[0-9a-fA-F]{3,8})$/)
  if (match) {
    const name = match[1].trim()
    return { name: name || null, color: match[2].toLowerCase() }
  }
  // No trailing colour — treat the whole string as a name.
  return { name: value, color: null }
}

function buildIncludedLookup(deck: ArchidektDeck): (categories: string[]) => boolean {
  const excluded = new Set(
    (deck.categories ?? []).filter((c) => !c.includedInDeck).map((c) => c.name)
  )
  return (categories: string[]) => {
    if (!categories.length) return true
    return categories.some((name) => !excluded.has(name))
  }
}

export function toDeckUpsert(deck: ArchidektDeck): DeckUpsert {
  return {
    external_id: String(deck.id),
    name: deck.name,
    format: formatName(deck.deckFormat),
    owner_username: deck.owner?.username ?? null,
    url: deckUrl(deck.id),
    external_updated_at: deck.updatedAt,
    is_private: !!deck.private,
    is_unlisted: !!deck.unlisted,
    raw: deck
  }
}

export function toDeckCards(deck: ArchidektDeck): DeckCardUpsert[] {
  const isIncluded = buildIncludedLookup(deck)

  return (deck.cards ?? []).map((entry: ArchidektDeckCard) => {
    const categories = entry.categories ?? []
    const oracle = entry.card?.oracleCard ?? null
    return {
      // card.uid is the Scryfall printing id, so it matches a specific language.
      scryfall_id: entry.card?.uid ?? null,
      // oracleCard.uid is the Scryfall oracle id, which matches the card in any language.
      oracle_id: oracle?.uid ?? null,
      quantity: entry.quantity ?? 1,
      finish: toFinish(entry.modifier),
      categories,
      in_maindeck: isIncluded(categories),
      name: oracle?.name ?? 'Unknown card',
      lang: oracle?.lang ?? 'en',
      set_code: entry.card?.edition?.editioncode ?? null,
      collector_number: entry.card?.collectorNumber ?? null,
      rarity: entry.card?.rarity ?? null,
      image_uri_small: null,
      // Stored raw. Keeping the original string is what lets the "don't own"
      // flag be recomputed locally when the setting changes, without a re-sync.
      label: entry.label ?? null
    }
  })
}
