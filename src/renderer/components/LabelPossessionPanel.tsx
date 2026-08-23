import { useCallback, useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import type { DeckLabelColor, Possession, TranslationKey } from '@shared/types'
import { guard, useApp } from '../store/app'
import { Button, EmptyState } from './primitives'
import { count } from '../lib/format'
import { useT } from '../hooks/useT'

/**
 * What each Archidekt label colour means for possession.
 *
 * Matched on colour alone, because Archidekt label names are usually empty — a
 * label comes back as `",#656565"` far more often than as `"Don't Have,#F47373"`.
 * Archidekt also exposes no registry of labels, so the only way to know which
 * exist is to scan the cards of decks already synced.
 *
 * Rendered both in Settings and from the Decks screen, so it lives here rather
 * than inside either view.
 */

type State = Possession | 'ignore'

const STATES: { value: State; label: TranslationKey; hint: TranslationKey; active: string }[] = [
  {
    value: 'not_owned',
    label: 'labels.dontOwn',
    hint: 'labels.dontOwnHint',
    active: 'bg-bad/20 text-bad ring-1 ring-bad/40'
  },
  {
    value: 'ignore',
    label: 'labels.ignore',
    hint: 'labels.ignoreHint',
    active: 'bg-ink-700 text-ink-100 ring-1 ring-ink-500'
  },
  {
    value: 'owned',
    label: 'labels.own',
    hint: 'labels.ownHint',
    active: 'bg-good/20 text-good ring-1 ring-good/40'
  }
]

export default function LabelPossessionPanel({
  compact = false
}: {
  /** Drops the explanatory copy, for use inside a modal that already has a title. */
  compact?: boolean
}): React.ReactElement {
  const t = useT()
  const settings = useApp((s) => s.settings)
  const updateSettings = useApp((s) => s.updateSettings)
  const invalidate = useApp((s) => s.invalidate)
  const toast = useApp((s) => s.toast)
  const dataVersion = useApp((s) => s.dataVersion)

  const [colors, setColors] = useState<DeckLabelColor[]>([])
  const [manual, setManual] = useState('')
  const [loading, setLoading] = useState(true)

  const load = useCallback(() => {
    window.api.decks
      .labelColors()
      .then(setColors)
      .catch(() => setColors([]))
      .finally(() => setLoading(false))
  }, [])

  useEffect(load, [load, dataVersion])

  const mapping = settings?.labelPossession ?? {}

  const apply = async (next: Record<string, Possession>): Promise<void> => {
    await updateSettings({ labelPossession: next })
    // Deck locations, badges, collection totals and the loose-bulk filter all
    // shift together, so refresh every view rather than just this one.
    invalidate()
    load()
  }

  const setState = (color: string, state: State): void => {
    const next = { ...mapping }
    if (state === 'ignore') delete next[color]
    else next[color] = state
    void guard(() => apply(next))
  }

  const addManual = (): void => {
    const value = manual.trim().toLowerCase()
    if (!/^#[0-9a-f]{3,8}$/.test(value)) {
      toast('warn', t('labels.badHex'))
      return
    }
    setManual('')
    void guard(() => apply({ ...mapping, [value]: 'not_owned' }))
  }

  return (
    <div className="space-y-3">
      {!compact && (
        <p className="text-[11px] leading-relaxed text-ink-500">
          {t('labels.intro1')} <span className="text-bad">{t('labels.dontOwn')}</span>{' '}
          {t('labels.intro2')} <span className="text-good">{t('labels.own')}</span>{' '}
          {t('labels.intro3')} <span className="text-ink-300">{t('labels.ignore')}</span>{' '}
          {t('labels.intro4')}
        </p>
      )}

      {loading ? (
        <div className="space-y-1.5">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="skeleton h-12 rounded-lg" />
          ))}
        </div>
      ) : colors.length === 0 ? (
        <EmptyState
          title={t('labels.emptyTitle')}
          hint={t('labels.emptyHint')}
        />
      ) : (
        <ul className="space-y-1.5">
          {colors.map((entry) => {
            const current: State = entry.possession ?? 'ignore'
            return (
              <li
                key={entry.color}
                className="flex flex-wrap items-center gap-2.5 rounded-lg border border-ink-800 bg-ink-900 px-2.5 py-2"
              >
                <span
                  className="h-4 w-4 shrink-0 rounded ring-1 ring-black/40"
                  style={{ backgroundColor: entry.color }}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs text-ink-200">
                    {entry.name ?? <span className="text-ink-500">{t('labels.unnamed')}</span>}
                  </span>
                  <span className="numeric block text-[10px] uppercase text-ink-600">
                    {entry.color}
                    {entry.cardCount > 0
                      ? ` · ${t.p('labels.usage', entry.deckCount, {
                          cards: count(entry.cardCount)
                        })}`
                      : ` · ${t('labels.unused')}`}
                  </span>
                </span>

                <div className="flex shrink-0 overflow-hidden rounded-lg border border-ink-700 text-[10px]">
                  {STATES.map((state, index) => (
                    <button
                      key={state.value}
                      onClick={() => setState(entry.color, state.value)}
                      title={t(state.hint)}
                      className={`px-2.5 py-1.5 transition-colors ${
                        index > 0 ? 'border-l border-ink-700' : ''
                      } ${
                        current === state.value
                          ? state.active
                          : 'text-ink-500 hover:bg-ink-800 hover:text-ink-200'
                      }`}
                    >
                      {t(state.label)}
                    </button>
                  ))}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <input
          value={manual}
          onChange={(e) => setManual(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') addManual()
          }}
          placeholder="#f47373"
          className="field w-28 font-mono text-xs outline-none placeholder:text-ink-600"
        />
        <Button size="sm" icon={<Plus size={13} />} onClick={addManual}>
          {t('labels.addColour')}
        </Button>
        <p className="flex-1 text-[10px] leading-tight text-ink-600">
          {t('labels.addHint1')} <span className="text-bad">{t('labels.dontOwn')}</span>
          {'; '}
          {t('labels.addHint2')}
        </p>
      </div>
    </div>
  )
}
