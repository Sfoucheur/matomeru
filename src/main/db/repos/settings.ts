import { getDb } from '../connection.js'
import { resolveLocale, type Locale } from '@shared/i18n/index.js'
import {
  DEFAULT_GRID_COLUMNS,
  DEFAULT_VIEW_MODES,
  clampColumns,
  type AppSettings,
  type Currency,
  type GridKey,
  type LocaleSetting,
  parseTheme,
  parseThemeMode,
  type Possession,
  type ViewModes
} from '@shared/types'

/** A hand-edited or stale value must never leave the app untranslatable. */
function parseLocale(raw: string | null | undefined): LocaleSetting {
  return raw === 'en' || raw === 'fr' || raw === 'system' ? raw : 'system'
}

const DEFAULTS: AppSettings = {
  currency: 'usd',
  archidektUsername: '',
  lastPriceSync: null,
  reduceMotion: false,
  deckMatchExact: false,
  gridColumns: { ...DEFAULT_GRID_COLUMNS },
  labelPossession: {},
  viewModes: { ...DEFAULT_VIEW_MODES },
  deckGroupByCategory: true,
  locale: 'system',
  theme: 'matomeru',
  /*
    Dark, not `system`. The app shipped dark-only with `class="dark"` hardcoded,
    so following the OS by default would flip every existing install to a light
    theme nobody asked for. `system` is one click away for anyone who wants it.
  */
  themeMode: 'dark',
  pureBlack: false
}

/** Settings stored as JSON rather than a bare string or boolean. */
const JSON_KEYS = new Set<keyof AppSettings>([
  'gridColumns',
  'labelPossession',
  'viewModes'
])

/**
 * Column counts are read defensively. A stale or hand-edited value must never
 * reach the renderer, where it would produce a broken `grid-template-columns`.
 */
function parseGridColumns(raw: string | null | undefined): Record<GridKey, number> {
  const result = { ...DEFAULT_GRID_COLUMNS }
  if (!raw) return result
  try {
    const parsed = JSON.parse(raw) as Partial<Record<GridKey, unknown>>
    for (const key of Object.keys(result) as GridKey[]) {
      const clamped = clampColumns(parsed[key])
      if (clamped !== null) result[key] = clamped
    }
  } catch {
    /* corrupt value — fall back to defaults */
  }
  return result
}

const HEX = /^#[0-9a-f]{3,8}$/

/** Label colours, normalized to lowercase hex so matching is case-insensitive. */
function parseColors(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return [
      ...new Set(
        parsed
          .filter((v): v is string => typeof v === 'string')
          .map((v) => v.trim().toLowerCase())
          .filter((v) => HEX.test(v))
      )
    ]
  } catch {
    return []
  }
}

/**
 * Colour-to-possession map, dropping anything that is not a hex colour paired
 * with a known state.
 *
 * `legacy` is the pre-tristate `notOwnedColors` array. When the new key has not
 * been written yet, those colours carry over as "not owned" so an existing
 * setting is not silently lost on upgrade.
 */
function parsePossession(
  raw: string | null | undefined,
  legacy: string | null | undefined
): Record<string, Possession> {
  const result: Record<string, Possession> = {}

  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed)) {
          const color = key.trim().toLowerCase()
          if (!HEX.test(color)) continue
          if (value === 'owned' || value === 'not_owned') result[color] = value
        }
        return result
      }
    } catch {
      /* corrupt value — fall through to the legacy key */
    }
  }

  for (const color of parseColors(legacy)) result[color] = 'not_owned'
  return result
}

/** Only the two modes each screen actually has are accepted; anything else falls back. */
const VALID_MODES: Record<keyof ViewModes, readonly string[]> = {
  collection: ['table', 'gallery'],
  picks: ['rows', 'grid'],
  decks: ['rows', 'grid']
}

function parseViewModes(raw: string | null | undefined): ViewModes {
  let parsed: Partial<Record<keyof ViewModes, unknown>> = {}
  if (raw) {
    try {
      const candidate = JSON.parse(raw)
      if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
        parsed = candidate as Partial<Record<keyof ViewModes, unknown>>
      }
    } catch {
      /* corrupt value — every key falls back below */
    }
  }

  // Per-key so each stays correctly typed; a loop over a union key widens the
  // assignment target to `never`.
  const pick = <K extends keyof ViewModes>(key: K): ViewModes[K] => {
    const value = parsed[key]
    return typeof value === 'string' && VALID_MODES[key].includes(value)
      ? (value as ViewModes[K])
      : DEFAULT_VIEW_MODES[key]
  }

  return { collection: pick('collection'), picks: pick('picks'), decks: pick('decks') }
}

export function getSettings(): AppSettings {
  const rows = getDb().all('SELECT key, value FROM settings') as {
    key: string
    value: string | null
  }[]
  const map = new Map(rows.map((r) => [r.key, r.value]))
  return {
    currency: (map.get('currency') as Currency) ?? DEFAULTS.currency,
    archidektUsername: map.get('archidektUsername') ?? DEFAULTS.archidektUsername,
    lastPriceSync: map.get('lastPriceSync') ?? DEFAULTS.lastPriceSync,
    reduceMotion: map.get('reduceMotion') === '1',
    deckMatchExact: map.get('deckMatchExact') === '1',
    // Defaults to on, so an existing install keeps the grouping it already has.
    deckGroupByCategory: (map.get('deckGroupByCategory') ?? '1') === '1',
    locale: parseLocale(map.get('locale')),
    theme: parseTheme(map.get('theme')),
    themeMode: parseThemeMode(map.get('themeMode')),
    pureBlack: map.get('pureBlack') === '1',
    gridColumns: parseGridColumns(map.get('gridColumns')),
    labelPossession: parsePossession(map.get('labelPossession'), map.get('notOwnedColors')),
    viewModes: parseViewModes(map.get('viewModes'))
  }
}

export function setSetting(key: keyof AppSettings, value: string | null): void {
  getDb().run(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, value]
  )
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    const typed = key as keyof AppSettings
    const serialized = JSON_KEYS.has(typed)
      ? JSON.stringify(value)
      : typeof value === 'boolean'
        ? value
          ? '1'
          : '0'
        : (value as string | null)
    setSetting(typed, serialized)
  }
  return getSettings()
}

/**
 * The resolved app language, for main-process messages.
 *
 * Synchronous like `getCurrency()`, which is what lets a thrown error be
 * translated at the point it is thrown — those strings reach the user verbatim
 * through the renderer's one `guard()` funnel.
 */
export function getLocale(systemLocale = 'en'): Locale {
  return resolveLocale(getSettings().locale, systemLocale)
}

export function getCurrency(): Currency {
  return getSettings().currency
}

export function getLabelPossession(): Record<string, Possession> {
  return getSettings().labelPossession
}
