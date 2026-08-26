import { allocateCopies } from '@shared/types'
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
export interface FilteredGroup extends DeckGroup {
  /**
   * Whether this section draws a heading.
   *
   * False for the flat list, which is every card once and has no category to name. It used
   * to be given one — a section called "Deck" that Archidekt has never heard of.
   */
  header: boolean
}

function totalsFor(
  name: string,
  source: DeckGroup,
  cards: DeckCardRow[],
  header = true
): FilteredGroup {
  let cardCount = 0
  let ownedCards = 0
  let inCollectionCards = 0
  let missingCards = 0
  let missingValue = 0
  let missingValueIsProxy = false
  for (const card of cards) {
    // The same allocation the breakdown uses, so a filtered group and the deck header
    // can never disagree about what is in the deck and what is merely yours.
    const { inDeck, fromCollection, missing } = allocateCopies(card)
    cardCount += card.quantity
    ownedCards += inDeck
    inCollectionCards += fromCollection
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
    header,
    cards,
    cardCount,
    ownedCards,
    inCollectionCards,
    missingCards,
    missingValue,
    missingValueIsProxy
  }
}

/**
 * The sections to display, filtered and sorted, with counts recomputed from what
 * survived the filter so no number on screen describes cards you cannot see.
 *
 * Grouped by category, the sections are Archidekt's own and each card appears in exactly
 * one: the category Archidekt lists first, which is the one its own view groups by. So the
 * sections partition the deck, and ticking a category shows that category.
 *
 * With `groupByCategory` off, there is one list of every card exactly once and no headings
 * at all. That used to be a section named "Deck" — a category the app made up — with the
 * commander pinned above it and the excluded piles below. Now that the categories overlap,
 * this flat view is the only place each card appears once, which is worth more than the
 * invented heading was.
 */
export function buildDeckSections(
  breakdown: DeckBreakdown,
  filters: DeckFilters,
  groupByCategory: boolean
): FilteredGroup[] {
  const keep = (cards: DeckCardRow[]): DeckCardRow[] =>
    sortDeckCards(cards.filter((card) => matchesDeckFilters(card, filters)), filters)

  if (!groupByCategory) {
    /*
      Every entry once. `breakdown.cards` is already the distinct list -- taking the union of
      the sections would hand the same card back several times.
    */
    const flat = totalsFor(
      '',
      { inDeck: true, isPremier: false } as DeckGroup,
      keep(breakdown.cards),
      false
    )
    return flat.cards.length > 0 ? [flat] : []
  }

  return breakdown.groups
    .map((group) => totalsFor(group.name, group, keep(group.cards)))
    .filter((group) => group.cards.length > 0)
}

/**
 * One item per thing the virtualized list draws.
 *
 * A row carries the section it was drawn in, because the same card can be drawn in several:
 * the key has to include it, and so does anything that asks "which heading is this under".
 */
export type DeckBodyItem =
  | { kind: 'header'; key: string; group: FilteredGroup }
  | { kind: 'row'; key: string; card: DeckCardRow; section: string }
  | { kind: 'tiles'; key: string; cards: DeckCardRow[]; columns: number; section: string }

export interface DeckBody {
  items: DeckBodyItem[]
  /**
   * Every visible card once, in first-appearance order.
   *
   * Distinct on purpose: this is the order a shift-range walks and the list select-all
   * reads, and both are about cards. With the same card in three sections, a repeated key
   * would make a range resolve to whichever copy came first and a select-all count rows.
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

  const seen = new Set<number>()
  for (const group of sections) {
    if (group.header) items.push({ kind: 'header', key: `header:${group.name}`, group })
    for (const card of group.cards) {
      if (seen.has(card.id)) continue
      seen.add(card.id)
      ordered.push(card)
    }

    if (mode === 'rows') {
      for (const card of group.cards) {
        // Keyed by section as well as card: the same card is drawn under every category it
        // carries, and a repeated key makes the virtualizer hand one row another's height.
        items.push({ kind: 'row', key: `row:${group.name}:${card.id}`, card, section: group.name })
      }
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
        columns: size,
        section: group.name
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
