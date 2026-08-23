import { useCallback } from 'react'
import { t, tp, type TranslationKey, type Vars } from '@shared/i18n/index'
import { useApp } from '../store/app'

export interface Translate {
  (key: TranslationKey, vars?: Vars): string
  /** Plural form, from paired `…_one` / `…_other` keys. */
  p: (base: string, count: number, vars?: Vars) => string
}

/**
 * The app's language, bound to the current locale.
 *
 * Reads the resolved locale from the store, so switching the setting re-renders
 * every subscriber and the whole UI changes language without a reload.
 */
export function useT(): Translate {
  const locale = useApp((s) => s.locale)
  return useCallback(
    Object.assign(
      (key: TranslationKey, vars?: Vars) => t(locale, key, vars),
      { p: (base: string, count: number, vars?: Vars) => tp(locale, base, count, vars) }
    ),
    [locale]
  ) as Translate
}
