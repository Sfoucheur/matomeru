/**
 * Reading what is printed on a card, for the fast-entry fields.
 *
 * Fast entry was one text line and a parser for it. It is four fields now — set,
 * number, language, quantity — because a pile from one set meant retyping the set and
 * the language for every card in it. What survives the line is this file: the number
 * is still the hard part, and both sides of the IPC still have to agree about it.
 */

/**
 * The number as the API wants it, plus the sheet size if one was given.
 *
 * Leading zeros are stripped because Scryfall rejects them — `blb/008` is a 404
 * and `blb/8` is the card — but only from an all-digit number, so `008a` becomes
 * `8a` while `★` and letter suffixes are left exactly as printed.
 *
 * The fraction is only read as a fraction when both halves are digits. No
 * collector number in 512 sampled from the oddest-numbered sets (memorabilia,
 * promos, tokens, funny) contains a slash at all, so this costs nothing and
 * leaves any future one intact.
 */
export function parseCollectorNumber(raw: string): {
  collectorNumber: string
  sheetTotal: number | null
} {
  const fraction = raw.match(/^(\d+)\/(\d+)$/)
  if (fraction) {
    return { collectorNumber: stripZeros(fraction[1]), sheetTotal: Number(fraction[2]) }
  }
  return { collectorNumber: stripZeros(raw), sheetTotal: null }
}

function stripZeros(number: string): string {
  const digits = number.match(/^0+(\d.*)$/)
  return digits ? digits[1] : number
}

/** A set the line could mean, with the size its cards claim to be numbered out of. */
export interface SetCandidate {
  code: string
  /** `printed_size` where Scryfall publishes it, else `card_count`. Null if unknown. */
  total: number | null
}

/**
 * Which sets to try, in order, for a line that named `typed`.
 *
 * Pure, and separate from the query that feeds it, because the ordering is the
 * whole behaviour and it is not worth a network round trip to test.
 *
 * Two rules, and the second matters more than the first:
 *
 *  - A denominator may *narrow* the choice. `c17 008/011` is a Cat Warrior because
 *    only C17's token sheet has 11 cards.
 *  - A denominator may never *veto* it. For most sets the printed number is not
 *    the card count at all -- Bloomburrow prints /261 and counts 398 -- so a total
 *    that matches nothing has to leave the typed set exactly as it was.
 *
 * Hence the typed set is always last, and always present.
 */
export function chooseSets(
  candidates: SetCandidate[],
  typed: string,
  sheetTotal: number | null
): string[] {
  if (sheetTotal === null) return [typed]

  const matching = candidates
    .filter((candidate) => candidate.total === sheetTotal)
    // The typed set before its children, so an exact match on the main set is never
    // stolen by a sheet that happens to be the same size. Then by code, so the
    // answer does not depend on the order rows came back in.
    .sort((a, b) => {
      const typedFirst = Number(b.code === typed) - Number(a.code === typed)
      return typedFirst !== 0 ? typedFirst : a.code.localeCompare(b.code)
    })
    .map((candidate) => candidate.code)

  return [...matching.filter((code) => code !== typed), typed]
}

/**
 * The forms of a collector number worth trying, in order.
 *
 * Scryfall's card route is case-sensitive and there is no rule that covers both
 * conventions: `unf/200a` is a card and `unf/200A` is a 404, while `plst/TDFT-14`
 * is a card and `plst/tdft-14` is a 404. Lowercase suffixes and uppercase prefixes
 * are both normal, so nothing can be normalised -- only tried.
 *
 * As typed always comes first, so a number that already matches costs exactly one
 * request and the extra forms only exist on the path that was going to fail. A
 * number with no letters in it yields a single form.
 */
export function numberVariants(collectorNumber: string): string[] {
  return [...new Set([collectorNumber, collectorNumber.toUpperCase(),
    collectorNumber.toLowerCase()])]
}

