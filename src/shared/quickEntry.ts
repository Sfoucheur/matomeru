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
 *   "c17 008/011"     the number exactly as printed on the card
 *   "c17 008/011 // 003"  one card with a different token on each side
 */
export interface QuickEntry {
  set: string
  collectorNumber: string
  lang: string
  quantity: number
  /**
   * The number on the other side, when the card has two different tokens on it.
   *
   * A Commander 2017 token card is a Cat Warrior on the front and a Rat on the back,
   * filed by Scryfall as two unrelated tokens. Adding both as usual claims two cards
   * when one is what is in the binder, so the line can name both sides at once.
   */
  backNumber: string | null
  /** The back's own denominator, if it was typed. Must agree with the front's. */
  backSheetTotal: number | null
  /**
   * The denominator, when the number was given as printed.
   *
   * This is the only thing that distinguishes a token from the card at the same
   * number. A Cat Warrior token reads `C17 008/011`, and `c17 8` is Teferi's
   * Protection — both are real, so nothing errors and the wrong card lands in the
   * collection. C17 has 309 cards and its token sheet has 11, so the denominator
   * says which of the two you are holding. Null when no fraction was typed.
   */
  sheetTotal: number | null
}

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
function splitNumber(raw: string): { collectorNumber: string; sheetTotal: number | null } {
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

export function parseQuickEntry(line: string): QuickEntry | null {
  /*
    `//` becomes its own token first, so "008/011 // 003" and "008/011//003" are one
    code path. A single slash is left alone -- that is the printed fraction.
  */
  const tokens = line
    .trim()
    .replace(/\s*\/\/\s*/g, ' // ')
    .split(/\s+/)
    .filter(Boolean)
  if (tokens.length < 2) return null

  let quantity = 1
  const last = tokens[tokens.length - 1]
  const quantityMatch = last.match(/^x(\d+)$/i) ?? last.match(/^(\d+)x$/i)
  if (quantityMatch) {
    quantity = Math.max(1, Number(quantityMatch[1]))
    tokens.pop()
  }
  if (tokens.length < 2) return null

  // The back, if there is one, sits between the number and the language.
  const paired = tokens[2] === '//'
  const backRaw = paired ? tokens[3] : undefined
  // A separator with nothing after it is a half-typed line, not a card.
  if (paired && backRaw === undefined) return null

  const [set, number] = tokens
  const lang = paired ? tokens[4] : tokens[2]
  /*
    Belt and braces after the length checks above. The guards are what keep this
    total today, and a parser that throws on a short line would take the whole
    verification run down with it rather than reporting which rule it broke.
  */
  if (set === undefined || number === undefined) return null
  const { collectorNumber, sheetTotal } = splitNumber(number)
  if (collectorNumber.length === 0) return null

  const back = backRaw === undefined ? null : splitNumber(backRaw)
  if (back !== null && back.collectorNumber.length === 0) return null
  /*
    Both sides of one card are on one sheet, by definition. So two denominators that
    disagree are a typo, and guessing which one was meant would put a card in the
    collection that nobody asked for -- the failure this whole feature exists to stop.
  */
  if (back !== null && back.sheetTotal !== null && sheetTotal !== null &&
      back.sheetTotal !== sheetTotal) {
    return null
  }

  return {
    set: set.toLowerCase(),
    collectorNumber,
    lang: (lang ?? 'en').toLowerCase(),
    quantity,
    sheetTotal: sheetTotal ?? back?.sheetTotal ?? null,
    backNumber: back?.collectorNumber ?? null,
    backSheetTotal: back?.sheetTotal ?? null
  }
}
