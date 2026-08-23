import type { DeckBreakdown, DeckCardRow, DeckFilters, DeckGroup } from '@shared/types'
import { matchesDeckFilters, sortDeckCards } from './deckFilter'

/**
 * Turning a deck into the sections and rows the screen draws.
 *
 * Pure functions in their own module, like `deckFilter.ts`, so `scripts/verify.ts`
 * can exercise the grouping and the chunking without a renderer — the assertion
 * that a tile row never straddles two categories is worth having in the suite
 * rather than in someone's memory.
 */

/** A group whose counts describe the filtered cards, not the whole category. */
export interface FilteredGroup extends DeckGroup {}

/** The name of the single section used when Archidekt categories are switched off. */
export const FLAT_GROUP_NAME = 'Deck'

function totalsFor(name: string, source: DeckGroup, cards: DeckCardRow[]): FilteredGroup {
  let cardCount = 0
  let ownedCards = 0
  let missingCards = 0
  let missingValue = 0
  let missingValueIsProxy = false
  for (const card of cards) {
    const missing = Math.max(0, card.quantity - card.held)
    cardCount += card.quantity
    ownedCards += Math.min(card.held, card.quantity)
    missingCards += missing
    if (card.unit_value) {
      missingValue += card.unit_value * missing
      if (missing > 0 && card.price_is_proxy) missingValueIsProxy = true
    }
  }
  return {
    name,
    inDeck: source.inDeck,
    isPremier: source.isPremier,
    cards,
    cardCount,
    ownedCards,
    missingCards,
    missingValue,
    missingValueIsProxy
  }
}

/**
 * The sections to display, filtered and sorted, with counts recomputed from what
 * survived the filter so no number on screen describes cards you cannot see.
 *
 * With `groupByCategory` off, the commander stays pinned and the excluded piles
 * (Cut, Maybeboard) stay separate — only the in-deck categories collapse into one
 * list. Merging is a plain concat with no dedup, because `DeckCardRow.group`
 * already puts each card in exactly one category group: they are a partition.
 */
export function buildDeckSections(
  breakdown: DeckBreakdown,
  filters: DeckFilters,
  groupByCategory: boolean
): FilteredGroup[] {
  const source: DeckGroup[] = groupByCategory ? breakdown.groups : collapse(breakdown.groups)
  return source
    .map((group) =>
      totalsFor(
        group.name,
        group,
        sortDeckCards(group.cards.filter((card) => matchesDeckFilters(card, filters)), filters)
      )
    )
    .filter((group) => group.cards.length > 0)
}

function collapse(groups: DeckGroup[]): DeckGroup[] {
  const premier = groups.filter((g) => g.isPremier)
  const inDeck = groups.filter((g) => g.inDeck && !g.isPremier)
  const excluded = groups.filter((g) => !g.inDeck && !g.isPremier)

  const merged: DeckGroup[] = [...premier]
  if (inDeck.length > 0) {
    merged.push({
      name: FLAT_GROUP_NAME,
      inDeck: true,
      isPremier: false,
      cards: inDeck.flatMap((g) => g.cards),
      // Recomputed downstream from the filtered cards; these are placeholders.
      cardCount: 0,
      ownedCards: 0,
      missingCards: 0,
      missingValue: 0,
      missingValueIsProxy: false
    })
  }
  return [...merged, ...excluded]
}

/** One entry per rendered row: a section heading, a card line, or a row of tiles. */
export type DeckBodyItem =
  | { kind: 'header'; key: string; group: FilteredGroup }
  | { kind: 'row'; key: string; card: DeckCardRow }
  /**
   * A row of tiles, carrying the column count it was chunked by.
   *
   * The count travels with the row on purpose: a tile row's height is derived
   * from that same number (via `tileWidth`), so laying it out with any other
   * number of tracks makes the row taller than it claims and it overlaps its
   * neighbours. Keeping both on one object is what stops the two drifting.
   */
  | { kind: 'tiles'; key: string; cards: DeckCardRow[]; columns: number }

export interface DeckBody {
  items: DeckBodyItem[]
  /**
   * Every visible card in display order, across sections. Shift-click ranges walk
   * this, which is what makes a range mean what it looks like it means.
   */
  ordered: DeckCardRow[]
}

export function buildDeckBody(
  sections: FilteredGroup[],
  mode: 'rows' | 'grid',
  columns: number
): DeckBody {
  const items: DeckBodyItem[] = []
  const ordered: DeckCardRow[] = []

  for (const group of sections) {
    items.push({ kind: 'header', key: `header:${group.name}`, group })
    ordered.push(...group.cards)

    if (mode === 'rows') {
      for (const card of group.cards) items.push({ kind: 'row', key: `row:${card.id}`, card })
      continue
    }
    // Chunked per section, so a tile row never mixes two categories — the last
    // chunk of a group is simply short, and renders into the same track count
    // with the trailing tracks left empty.
    const size = Math.max(1, columns)
    for (let i = 0; i < group.cards.length; i += size) {
      const cards = group.cards.slice(i, i + size)
      items.push({
        kind: 'tiles',
        key: `tiles:${group.name}:${cards[0].id}`,
        cards,
        columns: size
      })
    }
  }

  return { items, ordered }
}

/**
 * Whether a card can be selected for a language change.
 *
 * The Scryfall route that honours language is keyed on set and collector number,
 * so an entry missing either cannot be resolved — better to say so on the row
 * than to let it be selected and silently do nothing.
 */
export function deckCardSelectable(card: DeckCardRow): string | null {
  if (!card.oracle_id) return 'This entry has no oracle id, so it cannot be matched.'
  if (!card.set_code || !card.collector_number) {
    return 'This entry has no set and collector number to look up.'
  }
  return null
}
