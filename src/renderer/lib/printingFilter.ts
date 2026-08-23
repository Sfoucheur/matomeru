import type { PrintingChoice, PrintingFilters } from '@shared/types'

/**
 * Filtering a card's printings, and the options worth offering.
 *
 * Pure and in its own module like `deckFilter.ts`, so `scripts/verify.ts` can
 * exercise it without a renderer — the facet counts in particular are the sort of
 * thing that silently drifts from what the list actually contains.
 */

export function matchesPrintingFilters(
  printing: PrintingChoice,
  filters: PrintingFilters
): boolean {
  if (filters.langs.length && !filters.langs.includes(printing.lang)) return false
  if (filters.sets.length && !filters.sets.includes(printing.set_code)) return false
  if (filters.rarities.length && !filters.rarities.includes(printing.rarity)) return false
  // "Comes in this finish", not "is only this finish": a card printed in both
  // should appear when you are hunting for the foil.
  if (filters.finishes.length && !filters.finishes.some((f) => printing.finishes.includes(f))) {
    return false
  }
  return true
}

export interface PrintingFacets {
  langs: { value: string; count: number }[]
  sets: { value: string; label: string; count: number }[]
  rarities: { value: string; count: number }[]
  finishes: { value: string; count: number }[]
}

/**
 * The values actually present in a result set, with counts.
 *
 * Built from the results rather than from a fixed list, so the controls never
 * offer a language or set that would return nothing — the same reason the deck
 * screen derives its category and label filters from the deck.
 */
export function printingFacets(printings: PrintingChoice[]): PrintingFacets {
  const langs = new Map<string, number>()
  const sets = new Map<string, { label: string; count: number }>()
  const rarities = new Map<string, number>()
  const finishes = new Map<string, number>()

  for (const printing of printings) {
    langs.set(printing.lang, (langs.get(printing.lang) ?? 0) + 1)
    const set = sets.get(printing.set_code)
    if (set) set.count += 1
    else sets.set(printing.set_code, { label: printing.set_name, count: 1 })
    rarities.set(printing.rarity, (rarities.get(printing.rarity) ?? 0) + 1)
    // A printing offering both finishes counts towards both.
    for (const finish of new Set(printing.finishes)) {
      finishes.set(finish, (finishes.get(finish) ?? 0) + 1)
    }
  }

  return {
    // English first, then by frequency — the order the picker already used.
    langs: [...langs.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) =>
        a.value === 'en' ? -1 : b.value === 'en' ? 1 : b.count - a.count || a.value.localeCompare(b.value)
      ),
    sets: [...sets.entries()]
      .map(([value, { label, count }]) => ({ value, label, count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
    rarities: [...rarities.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count),
    finishes: [...finishes.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count)
  }
}

/** True when nothing is being narrowed, so callers can skip the work entirely. */
export function printingFiltersEmpty(filters: PrintingFilters): boolean {
  return (
    filters.langs.length === 0 &&
    filters.sets.length === 0 &&
    filters.rarities.length === 0 &&
    filters.finishes.length === 0
  )
}
