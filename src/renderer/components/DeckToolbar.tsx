import { AnimatePresence } from 'motion/react'
import { FolderTree, List, MousePointerClick } from 'lucide-react'
import { DECK_SORT_FIELDS, NO_LABEL, RARITIES } from '@shared/types'
import type { DeckBreakdown, DeckFilters, DeckOwnership, Rarity } from '@shared/types'
import { Chip, MultiSelect, Select } from './primitives'
import { colorName, colorOptions, languageName, rarityName } from '../lib/format'
import { useT } from '../hooks/useT'
import SearchInput from './SearchInput'
import SortMenu from './SortMenu'

/**
 * Search, filters and sort for one deck.
 *
 * The category and label options are built from the deck itself, not from a
 * fixed list: they are the user's own Archidekt groupings, so the only correct
 * source is whatever that deck actually has cards in.
 */
export default function DeckToolbar({
  breakdown,
  filters,
  onChange,
  onReset,
  groupByCategory,
  onToggleGrouping,
  onSelectAll,
  shown,
  total
}: {
  breakdown: DeckBreakdown
  filters: DeckFilters
  onChange: (patch: Partial<DeckFilters>) => void
  onReset: () => void
  groupByCategory: boolean
  onToggleGrouping: (value: boolean) => void
  onSelectAll: () => void
  shown: number
  total: number
}): React.ReactElement {
  const t = useT()
  const COLOR_OPTIONS = colorOptions()
  const OWNERSHIP_LABEL: Record<DeckOwnership, string> = {
    all: t('deck.ownershipAll'),
    owned: t('deck.ownershipOwned'),
    missing: t('deck.ownershipMissing')
  }
  const labelOptions = [
    ...breakdown.labels.map((label) => ({
      value: label.color ?? label.name ?? '',
      label: label.name?.trim() || (label.color ?? t('deck.label')),
      count: label.cardCount
    })),
    { value: NO_LABEL, label: t('deck.noLabel') }
  ]

  const chips: { key: string; label: string; clear: () => void }[] = []
  if (filters.search) {
    chips.push({ key: 'q', label: `“${filters.search}”`, clear: () => onChange({ search: '' }) })
  }
  if (filters.ownership !== 'all') {
    chips.push({
      key: 'own',
      label: OWNERSHIP_LABEL[filters.ownership],
      clear: () => onChange({ ownership: 'all' })
    })
  }
  for (const category of filters.categories) {
    chips.push({
      key: `cat-${category}`,
      label: category,
      clear: () => onChange({ categories: filters.categories.filter((c) => c !== category) })
    })
  }
  for (const color of filters.colors) {
    chips.push({
      key: `col-${color}`,
      label: colorName(color),
      clear: () => onChange({ colors: filters.colors.filter((c) => c !== color) })
    })
  }
  for (const rarity of filters.rarities) {
    chips.push({
      key: `rar-${rarity}`,
      label: rarity,
      clear: () => onChange({ rarities: filters.rarities.filter((r) => r !== rarity) })
    })
  }
  for (const lang of filters.langs) {
    chips.push({
      key: `lang-${lang}`,
      label: languageName(lang),
      clear: () => onChange({ langs: filters.langs.filter((l) => l !== lang) })
    })
  }
  for (const label of filters.labels) {
    chips.push({
      key: `lab-${label}`,
      label:
        label === NO_LABEL
          ? t('deck.noLabel')
          : (labelOptions.find((o) => o.value === label)?.label ?? label),
      clear: () => onChange({ labels: filters.labels.filter((l) => l !== label) })
    })
  }
  if (filters.typeLine) {
    chips.push({
      key: 'type',
      label: t('filters.typePrefix', { value: filters.typeLine }),
      clear: () => onChange({ typeLine: '' })
    })
  }

  return (
    <div className="shrink-0 border-b border-ink-800">
      <div className="flex flex-wrap items-center gap-2 px-5 py-2.5">
        <SearchInput
          value={filters.search}
          onChange={(search) => onChange({ search })}
          placeholder={t('deck.searchPlaceholder')}
          className="min-w-56 flex-1"
        />

        <Select
          className="w-40"
          value={filters.ownership}
          onChange={(ownership) => onChange({ ownership: ownership as DeckOwnership })}
          options={[
            { value: 'all', label: OWNERSHIP_LABEL.all },
            { value: 'owned', label: OWNERSHIP_LABEL.owned },
            { value: 'missing', label: OWNERSHIP_LABEL.missing }
          ]}
        />

        <MultiSelect
          label={t('deck.category')}
          options={breakdown.categories.map((category) => ({
            value: category.name,
            label: category.inDeck
              ? category.name
              : t('deck.categoryNotInDeck', { name: category.name }),
            count: category.cardCount
          }))}
          selected={filters.categories}
          onChange={(categories) => onChange({ categories })}
        />
        <MultiSelect
          label={t('filters.colors')}
          options={COLOR_OPTIONS}
          selected={filters.colors}
          onChange={(colors) => onChange({ colors })}
        />
        <MultiSelect
          label={t('filters.rarity')}
          options={RARITIES.map((rarity) => ({ value: rarity, label: rarityName(rarity) }))}
          selected={filters.rarities}
          onChange={(rarities) => onChange({ rarities: rarities as Rarity[] })}
        />
        <MultiSelect
          label={t('filters.language')}
          options={breakdown.languages.map((entry) => ({
            value: entry.lang,
            label: languageName(entry.lang),
            count: entry.cardCount
          }))}
          selected={filters.langs}
          onChange={(langs) => onChange({ langs })}
        />
        <MultiSelect
          label={t('deck.label')}
          options={labelOptions}
          selected={filters.labels}
          onChange={(labels) => onChange({ labels })}
        />

        <input
          value={filters.typeLine}
          onChange={(e) => onChange({ typeLine: e.target.value })}
          placeholder={t('deck.typeLinePlaceholder')}
          className="field w-32 text-xs outline-none placeholder:text-ink-600"
        />

        <SortMenu
          fields={DECK_SORT_FIELDS}
          value={{ sort: filters.sort, dir: filters.dir, sort2: filters.sort2, dir2: filters.dir2 }}
          onChange={onChange}
          title={t('deck.sortTitle')}
        />

        {/*
          Grouping off keeps the commander pinned and the excluded piles separate,
          and collapses only the in-deck categories — so the deck proper stays
          distinguishable from cards you cut.
        */}
        <div className="flex items-center overflow-hidden rounded-lg border border-ink-700">
          <button
            onClick={() => onToggleGrouping(true)}
            className={`px-2 py-1.5 transition-colors ${
              groupByCategory ? 'bg-ink-750 text-gold-400' : 'text-ink-400 hover:bg-ink-800'
            }`}
            aria-label={t('deck.groupByCategory')}
            title={t('deck.groupByCategory')}
          >
            <FolderTree size={14} />
          </button>
          <button
            onClick={() => onToggleGrouping(false)}
            className={`border-l border-ink-700 px-2 py-1.5 transition-colors ${
              groupByCategory ? 'text-ink-400 hover:bg-ink-800' : 'bg-ink-750 text-gold-400'
            }`}
            aria-label={t('deck.flatList')}
            title={t('deck.flatListHint')}
          >
            <List size={14} />
          </button>
        </div>

        <button
          onClick={onSelectAll}
          title={t('deck.selectAllHint')}
          className="field flex items-center gap-1.5 whitespace-nowrap text-xs text-ink-300"
        >
          <MousePointerClick size={13} className="text-ink-500" />
          {t('common.selectAllShown')}
        </button>
      </div>

      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-ink-800 px-5 py-2">
          <AnimatePresence mode="popLayout">
            {chips.map((chip) => (
              <Chip key={chip.key} tone="accent" onRemove={chip.clear}>
                {chip.label}
              </Chip>
            ))}
          </AnimatePresence>
          <span className="numeric ml-1 text-[11px] text-ink-500">
            {t('deck.cardsShown', { shown, total })}
          </span>
          <button
            onClick={onReset}
            className="ml-1 text-[11px] text-ink-500 underline-offset-2 transition-colors hover:text-ink-200 hover:underline"
          >
            {t('common.clearAll')}
          </button>
        </div>
      )}
    </div>
  )
}
