/**
 * Parses the fast-entry line used when sorting a physical pile.
 *
 * Shared between the renderer (to validate before a round trip) and the main
 * process (to parse authoritatively), so the two can never disagree on format.
 *
 * Accepts:
 *   "m10 146 ja"      set, collector number, language
 *   "m10 146"         language defaults to English
 *   "m10 146 ja x3"   trailing quantity, also written "3x"
 */
export interface QuickEntry {
  set: string
  collectorNumber: string
  lang: string
  quantity: number
}

export function parseQuickEntry(line: string): QuickEntry | null {
  const tokens = line.trim().split(/\s+/).filter(Boolean)
  if (tokens.length < 2) return null

  let quantity = 1
  const last = tokens[tokens.length - 1]
  const quantityMatch = last.match(/^x(\d+)$/i) ?? last.match(/^(\d+)x$/i)
  if (quantityMatch) {
    quantity = Math.max(1, Number(quantityMatch[1]))
    tokens.pop()
  }
  if (tokens.length < 2) return null

  const [set, collectorNumber, lang] = tokens
  return {
    set: set.toLowerCase(),
    collectorNumber,
    lang: (lang ?? 'en').toLowerCase(),
    quantity
  }
}
