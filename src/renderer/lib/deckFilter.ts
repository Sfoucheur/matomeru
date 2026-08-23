import { NO_LABEL, type DeckCardRow, type DeckFilters, type DeckSortField } from '@shared/types'

/**
 * Filtering and sorting for one deck, in the renderer.
 *
 * Deliberately not SQL. A deck is a few hundred rows that are already fully
 * fetched, so doing this locally is instant and costs no IPC round trip per
 * keystroke — unlike the Collection screen, which pages over an unbounded set
 * and has to filter in the query.
 *
 * Pure functions in their own module so `scripts/verify.ts` can exercise them
 * without a renderer.
 */

const RARITY_ORDER: Record<string, number> = {
  common: 0,
  uncommon: 1,
  rare: 2,
  mythic: 3,
  special: 4,
  bonus: 5
}

/** WUBRG, then multicolour, then colourless — the same order the SQL uses. */
export function colorRank(identity: string | null): number {
  let colors: string[] = []
  try {
    colors = identity ? (JSON.parse(identity) as string[]) : []
  } catch {
    colors = []
  }
  if (colors.length === 0) return 7
  if (colors.length > 1) return 6
  return { W: 1, U: 2, B: 3, R: 4, G: 5 }[colors[0]] ?? 5
}

function colorsOf(identity: string | null): string[] {
  try {
    const parsed = identity ? (JSON.parse(identity) as string[]) : []
    return parsed.length ? parsed : ['C']
  } catch {
    return ['C']
  }
}

export function matchesDeckFilters(card: DeckCardRow, filters: DeckFilters): boolean {
  const term = filters.search.trim().toLowerCase()
  if (term) {
    const haystack = [
      card.name,
      card.set_code,
      card.collector_number,
      card.type_line,
      card.lang
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
    if (!haystack.includes(term)) return false
  }

  if (filters.ownership === 'owned' && card.held < card.quantity) return false
  if (filters.ownership === 'missing' && card.held >= card.quantity) return false

  // A card is kept if *any* of its categories is selected, not just its owning
  // group — filtering by "Ramp" should find a card tagged ["Ramp","Creature"]
  // even though it is counted under Creature.
  if (filters.categories.length) {
    const tags = card.categories.length ? card.categories : [card.group]
    if (!tags.some((tag) => filters.categories.includes(tag))) return false
  }

  if (filters.colors.length) {
    const colors = colorsOf(card.color_identity)
    if (!colors.some((color) => filters.colors.includes(color))) return false
  }

  if (filters.rarities.length && !filters.rarities.includes(card.rarity as never)) return false

  // The effective language: after an override or a forced one, which is the only
  // language the row actually claims to be.
  if (filters.langs.length && !filters.langs.includes(card.lang)) return false

  if (filters.typeLine.trim()) {
    const needle = filters.typeLine.trim().toLowerCase()
    if (!(card.type_line ?? '').toLowerCase().includes(needle)) return false
  }

  if (filters.labels.length) {
    const key = card.label_color ?? card.label_name ?? null
    const mine = key && key.trim() !== '' ? key : NO_LABEL
    if (!filters.labels.includes(mine)) return false
  }

  return true
}

function compareBy(field: DeckSortField, a: DeckCardRow, b: DeckCardRow): number {
  switch (field) {
    case 'name':
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    case 'color':
      return colorRank(a.color_identity) - colorRank(b.color_identity)
    case 'cmc':
      return (a.cmc ?? 0) - (b.cmc ?? 0)
    case 'rarity':
      return (RARITY_ORDER[a.rarity ?? ''] ?? 9) - (RARITY_ORDER[b.rarity ?? ''] ?? 9)
    case 'set_code':
      return (a.set_code ?? '').localeCompare(b.set_code ?? '')
    case 'ownership':
      // Most-missing first when descending; fully owned cards sort together.
      return a.quantity - a.held - (b.quantity - b.held)
    case 'price':
      return (a.unit_value ?? 0) - (b.unit_value ?? 0)
    default:
      return 0
  }
}

export function sortDeckCards(cards: DeckCardRow[], filters: DeckFilters): DeckCardRow[] {
  const sign = filters.dir === 'desc' ? -1 : 1
  const sign2 = filters.dir2 === 'desc' ? -1 : 1
  return [...cards].sort((a, b) => {
    const primary = compareBy(filters.sort, a, b) * sign
    if (primary !== 0) return primary
    if (filters.sort2) {
      const secondary = compareBy(filters.sort2, a, b) * sign2
      if (secondary !== 0) return secondary
    }
    // Name last, so an otherwise-tied group is at least stable and readable.
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })
}
