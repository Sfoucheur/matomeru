import type { Finish, Prices, Printing, Rarity } from '@shared/types'
import type { ScryfallCard } from './client.js'

const KNOWN_RARITIES: Rarity[] = ['common', 'uncommon', 'rare', 'mythic', 'special', 'bonus']

function normalizeRarity(raw: string): Rarity {
  return KNOWN_RARITIES.includes(raw as Rarity) ? (raw as Rarity) : 'special'
}

function normalizePrices(raw: Record<string, string | null> | undefined): Prices | null {
  if (!raw) return null
  return {
    usd: raw.usd ?? null,
    usd_foil: raw.usd_foil ?? null,
    usd_etched: raw.usd_etched ?? null,
    eur: raw.eur ?? null,
    eur_foil: raw.eur_foil ?? null,
    tix: raw.tix ?? null
  }
}

/**
 * Double-faced layouts carry their images on `card_faces` rather than the card
 * itself, so fall back to the front face.
 */
function imageUris(card: ScryfallCard): { normal: string | null; small: string | null } {
  const direct = card.image_uris
  if (direct) return { normal: direct.normal ?? null, small: direct.small ?? null }
  const face = card.card_faces?.[0]?.image_uris
  if (face) return { normal: face.normal ?? null, small: face.small ?? null }
  return { normal: null, small: null }
}

/**
 * For multi-face cards Scryfall puts the localized title on each face; join
 * them the same way it formats the English `name` so the two stay comparable.
 */
function printedName(card: ScryfallCard): string | null {
  if (card.printed_name) return card.printed_name
  const faces = card.card_faces?.map((f) => f.printed_name).filter(Boolean)
  if (faces && faces.length > 1) return faces.join(' // ')
  return null
}

/**
 * Localized rules text. Joined across faces the same way `printedName` joins the
 * names, so the two stay comparable on double-faced cards.
 */
function printedText(card: ScryfallCard): string | null {
  if (card.printed_text) return card.printed_text
  const faces = card.card_faces?.map((f) => f.printed_text).filter(Boolean)
  if (faces && faces.length) return faces.join('\n//\n')
  return null
}

export function toPrinting(card: ScryfallCard): Printing {
  const images = imageUris(card)
  return {
    scryfall_id: card.id,
    oracle_id: card.oracle_id ?? null,
    name: card.name,
    printed_name: printedName(card),
    lang: card.lang,
    set_code: card.set,
    set_name: card.set_name,
    collector_number: card.collector_number,
    rarity: normalizeRarity(card.rarity),
    mana_cost: card.mana_cost ?? null,
    cmc: card.cmc ?? null,
    type_line: card.type_line ?? null,
    printed_type_line: card.printed_type_line ?? null,
    oracle_text:
      card.oracle_text ??
      card.card_faces?.map((f) => f.oracle_text).filter(Boolean).join('\n//\n') ??
      null,
    printed_text: printedText(card),
    colors: card.colors ?? [],
    color_identity: card.color_identity ?? [],
    layout: card.layout,
    finishes: (card.finishes ?? ['nonfoil']) as Finish[],
    promo_types: card.promo_types ?? [],
    in_boosters: card.booster ?? null,
    image_uri_normal: images.normal,
    image_uri_small: images.small,
    released_at: card.released_at ?? null,
    prices: normalizePrices(card.prices),
    price_updated_at: card.prices ? new Date().toISOString() : null
  }
}

/** Sort printings so the most useful choices surface first in the picker. */
export function sortPrintings(printings: Printing[]): Printing[] {
  return [...printings].sort((a, b) => {
    if (a.lang !== b.lang) {
      // English first, then everything else alphabetically by language code.
      if (a.lang === 'en') return -1
      if (b.lang === 'en') return 1
      return a.lang.localeCompare(b.lang)
    }
    const dateA = a.released_at ?? ''
    const dateB = b.released_at ?? ''
    if (dateA !== dateB) return dateB.localeCompare(dateA)
    return a.collector_number.localeCompare(b.collector_number, undefined, { numeric: true })
  })
}
