import { AnimatePresence } from 'motion/react'
import { X } from 'lucide-react'
import type { Finish, PrintingChoice, PrintingFilters, Rarity } from '@shared/types'
import { Chip, MultiSelect } from './primitives'
import { FINISH_LABEL, languageName, rarityName } from '../lib/format'
import { useT } from '../hooks/useT'
import SetIcon from './SetIcon'
import { printingFacets } from '../lib/printingFilter'

/**
 * Narrowing a card's printings down to the one in your hand.
 *
 * Every option comes from the results themselves, with counts, so the controls
 * can never offer a language or set that would return nothing. Shared by the
 * Add-cards picker and the card-detail one: both work from the same
 * `PrintingChoice[]`, and a filter you set in one is the filter in the other.
 */
export default function PrintingFilterBar({
  printings,
  filters,
  onChange,
  onReset,
  shown
}: {
  /** The unfiltered results, which is what the options are derived from. */
  printings: PrintingChoice[]
  filters: PrintingFilters
  onChange: (patch: Partial<PrintingFilters>) => void
  onReset: () => void
  shown: number
}): React.ReactElement | null {
  const t = useT()
  const facets = printingFacets(printings)
  // One printing has nothing to narrow.
  if (printings.length < 2) return null

  const chips: { key: string; label: string; clear: () => void }[] = []
  for (const lang of filters.langs) {
    chips.push({
      key: `lang-${lang}`,
      label: languageName(lang),
      clear: () => onChange({ langs: filters.langs.filter((l) => l !== lang) })
    })
  }
  for (const set of filters.sets) {
    chips.push({
      key: `set-${set}`,
      label: set.toUpperCase(),
      clear: () => onChange({ sets: filters.sets.filter((s) => s !== set) })
    })
  }
  for (const rarity of filters.rarities) {
    chips.push({
      key: `rarity-${rarity}`,
      label: rarityName(rarity),
      clear: () => onChange({ rarities: filters.rarities.filter((r) => r !== rarity) })
    })
  }
  for (const finish of filters.finishes) {
    chips.push({
      key: `finish-${finish}`,
      label: FINISH_LABEL[finish] ?? finish,
      clear: () => onChange({ finishes: filters.finishes.filter((f) => f !== finish) })
    })
  }

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <MultiSelect
          label={t('filters.language')}
          options={facets.langs.map((f) => ({
            value: f.value,
            label: languageName(f.value),
            count: f.count
          }))}
          selected={filters.langs}
          onChange={(langs) => onChange({ langs })}
        />
        <MultiSelect
          label={t('filters.set')}
          options={facets.sets.map((f) => ({
            value: f.value,
            label: `${f.value.toUpperCase()} — ${f.label}`,
            count: f.count,
            icon: <SetIcon code={f.value} />
          }))}
          selected={filters.sets}
          onChange={(sets) => onChange({ sets })}
        />
        <MultiSelect
          label={t('filters.rarity')}
          options={facets.rarities.map((f) => ({
            value: f.value,
            label: rarityName(f.value),
            count: f.count
          }))}
          selected={filters.rarities}
          onChange={(rarities) => onChange({ rarities: rarities as Rarity[] })}
        />
        <MultiSelect
          label={t('filters.finish')}
          options={facets.finishes.map((f) => ({
            value: f.value,
            label: FINISH_LABEL[f.value] ?? f.value,
            count: f.count
          }))}
          selected={filters.finishes}
          onChange={(finishes) => onChange({ finishes: finishes as Finish[] })}
        />

        <span className="numeric ml-auto text-[11px] text-ink-500">
          {shown === printings.length
            ? t('printing.count', { count: printings.length })
            : t('common.of', { shown, total: printings.length })}
        </span>
      </div>

      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <AnimatePresence mode="popLayout">
            {chips.map((chip) => (
              <Chip key={chip.key} tone="accent" onRemove={chip.clear}>
                {chip.label}
              </Chip>
            ))}
          </AnimatePresence>
          <button
            onClick={onReset}
            className="ml-1 flex items-center gap-1 text-[11px] text-ink-500 transition-colors hover:text-ink-200"
          >
            <X size={11} />
            {t('common.clearAll')}
          </button>
        </div>
      )}
    </div>
  )
}
