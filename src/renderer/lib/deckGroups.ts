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

/**
 * The flat list's second section, holding every card the commander's does not.
 *
 * A sentinel rather than a name, because the heading is translated: `SectionHeader` maps it
 * the way it maps `UNCATEGORIZED`. Archidekt has no category by this name, and no card
 * reports it as its `section` — nothing filters on it.
 */
export const FLAT_CARDS = '__cards__'

/** A group whose counts describe the filtered cards, not the whole category. */
export interface FilteredGroup extends DeckGroup {
  /**
   * Whether this section draws a heading.
   *
   * Every section does now. Kept because the flat list spent a version without one, and a
   * heading is not a property of the cards — it is a decision about how they are laid out.
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
 * survived the filter — so no number on screen describes cards the filter excluded. A page
 * is a different thing from a filter: see `pageOfSections`, which narrows what is drawn
 * without touching what a heading counts.
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
      Two sections: the commander, then the cards.

      Flat mode has been through three shapes. It used to merge the in-deck categories under
      a heading the app made up -- "Deck", which Archidekt has never heard of -- with the
      commander pinned above and the excluded piles below. That heading had to go, and the
      commander's pinning went with it, which was a step too far. Then the commander came
      back with a rule under it. Now the run below the commander is named as well, because a
      heading separates the two better than a hairline did and says what the list is.

      Only the commander is a real category here: everything else is one list of cards,
      Maybeboard included, saying so on its own rows. `breakdown.cards` is the distinct list;
      taking the union of the sections would hand the same card back once per section.
    */
    const premier = breakdown.groups.filter((group) => group.isPremier)
    const pinned = new Set(premier.flatMap((group) => group.cards.map((card) => card.id)))
    const rest = breakdown.cards.filter((card) => !pinned.has(card.id))

    return [
      ...premier.map((group) => totalsFor(group.name, group, keep(group.cards))),
      totalsFor(FLAT_CARDS, { inDeck: true, isPremier: false } as DeckGroup, keep(rest))
    ].filter((section) => section.cards.length > 0)
  }

  return breakdown.groups
    .map((group) => totalsFor(group.name, group, keep(group.cards)))
    .filter((group) => group.cards.length > 0)
}

/** Every card the sections hold, in the order they are drawn. */
export function cardsOf(sections: readonly FilteredGroup[]): DeckCardRow[] {
  return sections.flatMap((section) => section.cards)
}

/**
 * One page of a deck: the same sections, holding only the cards in the window.
 *
 * A separate pass rather than an argument to `buildDeckSections` or `buildDeckBody`, and
 * deliberately so — both of those are asserted at length against whole decks, and a page is
 * neither a filter nor a grouping. It is a viewport, the way a scroll position is.
 *
 * A category that straddles the boundary keeps its heading on both pages, because
 * `buildDeckBody` draws a heading for every section it is handed and neither page contains
 * the whole category. That is the behaviour asked for: a page is N cards, and headings fall
 * where their cards do.
 *
 * **The headings go on counting the category, not the page.** `totalsFor` derives every
 * figure from the array it is given, so re-running it here would have a heading read
 * "Land · 7 cards · €4.10" for a category of thirty-eight — arithmetically true about the
 * page and a lie about the thing it names. The counts are carried through untouched instead,
 * and the page's own extent is stated by the paginator, where it is labelled as such. The
 * exception is `FLAT_CARDS`, which is not a category: "the cards on this page" is a coherent
 * thing to count, so that one is recomputed.
 *
 * @param columns In grid mode, the boundary inside a section rounds down to a multiple of
 *   this, so a tile row is never left short in the middle of a category. Pass 0 for rows,
 *   where every card is its own line and no rounding is needed.
 */
export function pageOfSections(
  sections: readonly FilteredGroup[],
  offset: number,
  size: number,
  columns = 0
): FilteredGroup[] {
  if (size <= 0) return [...sections]
  const end = offset + size
  const page: FilteredGroup[] = []
  let seen = 0

  for (const section of sections) {
    const start = seen
    seen += section.cards.length
    if (seen <= offset || start >= end) continue

    // Where this section is cut, in its own indices.
    let from = Math.max(0, offset - start)
    let to = Math.min(section.cards.length, end - start)
    if (columns > 1) {
      // Down to a whole tile row at both ends: a chunk that starts mid-row would draw a
      // short row in the middle of a category, and `buildDeckBody` chunks from what it is
      // handed rather than from the section's true start.
      from = Math.floor(from / columns) * columns
      if (to < section.cards.length) to = Math.floor(to / columns) * columns
    }
    if (to <= from) continue

    const cards = section.cards.slice(from, to)
    page.push(
      section.name === FLAT_CARDS
        ? totalsFor(FLAT_CARDS, section, cards)
        : // Counts carried, not recomputed: a heading names a category.
          { ...section, cards }
    )
  }

  return page
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
