import { type Currency, type Rarity, type TileDensity } from '@shared/types'
import { t, type Locale } from '@shared/i18n/index'

/**
 * Number, money and date formatting, locale-aware.
 *
 * These used to hardcode English conventions — `money()` produced `€1.00` where
 * French writes `1,00 €`, and `relativeTime()` spelled out "2h ago" by hand.
 * `Intl` is built into Electron, so this needs no dependency.
 *
 * The locale is module state rather than a parameter because these are called
 * from hundreds of places, most of them deep in render trees that have no
 * business threading it through. `setFormatLocale` is called once whenever the
 * setting changes.
 */
let formatLocale: Locale = 'en'
/** BCP 47 tag for Intl — the app's two locales map straight onto real ones. */
let intlLocale = 'en-GB'

export function setFormatLocale(locale: Locale): void {
  formatLocale = locale
  intlLocale = locale === 'fr' ? 'fr-FR' : 'en-GB'
}

export function currentFormatLocale(): Locale {
  return formatLocale
}

/**
 * Formats a money value. Null is rendered as an em dash rather than 0 — Scryfall
 * genuinely has no price for many non-English printings, and showing "0.00"
 * would understate a collection's worth instead of admitting the gap.
 */
export function money(value: number | null | undefined, currency: Currency = 'usd'): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  return new Intl.NumberFormat(intlLocale, {
    style: 'currency',
    currency: currency === 'eur' ? 'EUR' : 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value)
}

/**
 * A price borrowed from another printing of the same card, marked as such.
 *
 * Non-English printings almost never carry a price of their own, so without a
 * stand-in a French deck reads as worthless. The `≈` is the whole point: a plain
 * figure means this printing's price, and this one does not.
 */
export function proxyMoney(
  value: number | null | undefined,
  currency: Currency = 'usd'
): string {
  const text = money(value, currency)
  return text === '—' ? text : `≈ ${text}`
}


export function bigMoney(value: number, currency: Currency = 'usd'): string {
  return money(value, currency)
}

/** A probability as a percentage, with enough precision for rare pulls. */
export function percent(value: number): string {
  const digits = value > 0 && value < 0.01 ? 2 : value < 0.1 ? 1 : 0
  return new Intl.NumberFormat(intlLocale, {
    style: 'percent',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  }).format(value)
}

export function count(value: number): string {
  return new Intl.NumberFormat(intlLocale).format(value)
}

/** A card language's name, in the app's language. */
export function languageName(code: string): string {
  const key = `lang.${code}`
  const name = t(formatLocale, key as Parameters<typeof t>[1])
  // `t` echoes the key back when it does not know it, which is how an unusual
  // Scryfall language code shows up as its own code rather than as "lang.xx".
  return name === key ? code.toUpperCase() : name
}

/** A rarity's name, in the app's language. Display only — never a stored value. */
export function rarityName(rarity: string): string {
  const key = `rarity.${rarity}`
  const name = t(formatLocale, key as Parameters<typeof t>[1])
  return name === key ? rarity : name
}

/** A finish's name, in the app's language. */
export function finishName(finish: string): string {
  const key = `finish.${finish}`
  const name = t(formatLocale, key as Parameters<typeof t>[1])
  return name === key ? finish : name
}

/** A colour's name, in the app's language. */
export function colorName(code: string): string {
  const key = `color.${code}`
  const name = t(formatLocale, key as Parameters<typeof t>[1])
  return name === key ? code : name
}

/** The colour filter options, hoisted here so two screens stop duplicating them. */
export const COLOR_CODES = ['W', 'U', 'B', 'R', 'G', 'C'] as const

export function colorOptions(): { value: string; label: string }[] {
  return COLOR_CODES.map((value) => ({ value, label: colorName(value) }))
}

export const RARITY_LABEL: Record<string, string> = {
  common: 'C',
  uncommon: 'U',
  rare: 'R',
  mythic: 'M',
  special: 'S',
  bonus: 'B'
}

export const RARITY_COLOR: Record<string, string> = {
  common: 'text-rarity-common',
  uncommon: 'text-rarity-uncommon',
  rare: 'text-rarity-rare',
  mythic: 'text-rarity-mythic',
  special: 'text-rarity-special',
  bonus: 'text-rarity-special'
}

export function rarityLabel(rarity: Rarity | string | null): string {
  if (!rarity) return '?'
  return RARITY_LABEL[rarity] ?? rarity.charAt(0).toUpperCase()
}

/**
 * Kept as a lookup for the many call sites that index it directly, but now
 * resolved through the dictionary so it follows the app language.
 */
export const FINISH_LABEL: Record<string, string> = new Proxy(
  {},
  { get: (_target, key: string) => finishName(key) }
) as Record<string, string>

/**
 * A foil name trimmed to fit the tile it is drawn on.
 *
 * Shared because two different badges need the identical rule: `FoilBadge`, which
 * says what the copy you hold is, and the Add-cards tile, which says what a
 * printing's foil version is. They differ in placement, colour and meaning — but
 * not in how a long product name has to give way on a narrow tile.
 *
 * `compact` drops a trailing "Foil", since both badges already carry a sparkle
 * that says as much: "Surge Foil" reads "Surge". `minimal` returns nothing at
 * all, leaving the icon to speak; callers keep the full name in the tooltip.
 * Stripping is skipped when it would leave the label empty, which is the plain
 * "Foil" case.
 */
export function foilLabelForDensity(label: string, density: TileDensity): string {
  if (density === 'minimal') return ''
  if (density === 'full') return label
  const trimmed = label.replace(/\s*foil$/i, '')
  return trimmed || label
}

/**
 * A file size, for messages about the backup.
 *
 * Whole megabytes above a megabyte, one decimal below it. A 33 MB database does not
 * benefit from "33.16", and a small one should not read as "0".
 */
export function megabytes(bytes: number): string {
  const mb = bytes / 1_048_576
  const value = mb >= 1 ? Math.round(mb) : Math.round(mb * 10) / 10
  return `${new Intl.NumberFormat(intlLocale).format(value)} MB`
}

export function relativeTime(iso: string | null): string {
  if (!iso) return t(formatLocale, 'common.never')
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return t(formatLocale, 'common.never')
  const seconds = Math.round((Date.now() - then) / 1000)
  if (seconds < 60) return t(formatLocale, 'time.justNow')
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return t(formatLocale, 'time.minutes', { count: minutes })
  const hours = Math.round(minutes / 60)
  if (hours < 24) return t(formatLocale, 'time.hours', { count: hours })
  const days = Math.round(hours / 24)
  if (days < 30) return t(formatLocale, 'time.days', { count: days })
  return new Intl.DateTimeFormat(intlLocale, { dateStyle: 'medium' }).format(new Date(iso))
}

/**
 * The name to lead with: the localized title when there is one, the English
 * name otherwise. Both are shown together in the UI when they differ.
 */
export function displayName(printing: { name: string; printed_name: string | null }): string {
  return printing.printed_name ?? printing.name
}

export function hasDistinctPrintedName(printing: {
  name: string
  printed_name: string | null
}): boolean {
  return !!printing.printed_name && printing.printed_name !== printing.name
}
