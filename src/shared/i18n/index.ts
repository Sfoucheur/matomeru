import { en } from './en.js'
import { fr } from './fr.js'

/**
 * Translation, hand-rolled on purpose.
 *
 * The app has two runtime dependencies and a house style of small explicit
 * modules; pulling in an i18n framework for one target language would be
 * disproportionate. More importantly, `fr` is typed as
 * `Record<TranslationKey, string>`, so **a missing French string is a compile
 * error** rather than a silent fallback to English that nobody notices.
 *
 * Lives in `shared/` because the main process needs it too: every
 * `throw new Error(...)` there reaches the user verbatim through the renderer's
 * one `guard()` funnel, so those messages have to translate as well.
 *
 * Interpolation is by **name**, not position — French reorders words around an
 * embedded card or deck name, and `{name}` lets it.
 */

export type TranslationKey = keyof typeof en
export type Locale = 'en' | 'fr'
/** What the setting stores; `system` resolves against the OS language. */
export type LocaleSetting = 'system' | Locale

const DICTIONARIES: Record<Locale, Record<TranslationKey, string>> = { en, fr }

export const LOCALES: Locale[] = ['en', 'fr']

/** Native names, because a language picker should read in its own language. */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: 'English',
  fr: 'Français'
}

/** Resolves `system` against an OS locale like `fr-FR` or `en-US`. */
export function resolveLocale(setting: LocaleSetting, systemLocale: string): Locale {
  if (setting !== 'system') return setting
  const base = systemLocale.slice(0, 2).toLowerCase()
  return (LOCALES as string[]).includes(base) ? (base as Locale) : 'en'
}

export type Vars = Record<string, string | number>

function interpolate(template: string, vars?: Vars): string {
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole
  )
}

/**
 * One string in one language.
 *
 * Falls back to English for a key the target dictionary somehow lacks — which the
 * type system prevents at build time, but a locale read from disk could still be
 * nonsense, and a missing word should never blank out the UI.
 */
export function t(locale: Locale, key: TranslationKey, vars?: Vars): string {
  const dictionary = DICTIONARIES[locale] ?? en
  return interpolate(dictionary[key] ?? en[key] ?? key, vars)
}

/**
 * Plural form, chosen from paired `…_one` / `…_other` keys.
 *
 * Replaces the `count === 1 ? '' : 's'` pattern scattered through the views,
 * which cannot express French agreement.
 */
export function tp(
  locale: Locale,
  base: string,
  count: number,
  vars?: Vars
): string {
  const key = `${base}_${count === 1 ? 'one' : 'other'}` as TranslationKey
  return t(locale, key, { count, ...vars })
}
