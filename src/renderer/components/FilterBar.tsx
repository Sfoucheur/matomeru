import { AnimatePresence, motion } from 'motion/react'
import { SlidersHorizontal } from 'lucide-react'
import { useState } from 'react'
import {
  CONDITIONS,
  FINISHES,
  RARITIES,
  foilTreatmentLabel,
  type Deck,
  type FacetCounts
} from '@shared/types'
import { useApp } from '../store/app'
import { Button, Chip, MultiSelect, Select } from './primitives'
import SearchInput from './SearchInput'
import SetIcon from './SetIcon'
import { FINISH_LABEL, colorName, colorOptions, languageName, rarityName } from '../lib/format'
import { useT } from '../hooks/useT'

export default function FilterBar({
  facets,
  decks
}: {
  facets: FacetCounts | null
  decks: Deck[]
}): React.ReactElement {
  const filters = useApp((s) => s.filters)
  const setFilters = useApp((s) => s.setFilters)
  const resetFilters = useApp((s) => s.resetFilters)
  const t = useT()
  const COLOR_OPTIONS = colorOptions()
  const [advanced, setAdvanced] = useState(false)

  const activeChips: {
    key: string
    label: string
    /** Optional leading glyph — the set symbol, so a chip reads like the option did. */
    icon?: React.ReactNode
    clear: () => void
  }[] = []
  if (filters.search) {
    activeChips.push({
      key: 'search',
      label: `“${filters.search}”`,
      clear: () => setFilters({ search: '' })
    })
  }
  for (const lang of filters.langs) {
    activeChips.push({
      key: `lang-${lang}`,
      label: languageName(lang),
      clear: () => setFilters({ langs: filters.langs.filter((l) => l !== lang) })
    })
  }
  for (const rarity of filters.rarities) {
    activeChips.push({
      key: `rarity-${rarity}`,
      label: rarityName(rarity),
      clear: () => setFilters({ rarities: filters.rarities.filter((r) => r !== rarity) })
    })
  }
  for (const set of filters.sets) {
    activeChips.push({
      key: `set-${set}`,
      label: set.toUpperCase(),
      icon: <SetIcon code={set} size={11} />,
      clear: () => setFilters({ sets: filters.sets.filter((s) => s !== set) })
    })
  }
  for (const finish of filters.finishes) {
    activeChips.push({
      key: `finish-${finish}`,
      label: FINISH_LABEL[finish] ?? finish,
      clear: () => setFilters({ finishes: filters.finishes.filter((f) => f !== finish) })
    })
  }
  for (const treatment of filters.treatments) {
    activeChips.push({
      key: `treatment-${treatment}`,
      label: foilTreatmentLabel(treatment),
      clear: () =>
        setFilters({ treatments: filters.treatments.filter((tr) => tr !== treatment) })
    })
  }
  if (filters.proxied !== null) {
    activeChips.push({
      key: 'proxied',
      label: filters.proxied ? t('proxy.filterOnly') : t('proxy.filterExclude'),
      clear: () => setFilters({ proxied: null })
    })
  }
  for (const condition of filters.conditions) {
    activeChips.push({
      key: `cond-${condition}`,
      label: condition,
      clear: () => setFilters({ conditions: filters.conditions.filter((c) => c !== condition) })
    })
  }
  for (const color of filters.colors) {
    activeChips.push({
      key: `color-${color}`,
      label: colorName(color),
      clear: () => setFilters({ colors: filters.colors.filter((c) => c !== color) })
    })
  }
  if (filters.typeLine) {
    activeChips.push({
      key: 'type',
      label: t('filters.typePrefix', { value: filters.typeLine }),
      clear: () => setFilters({ typeLine: '' })
    })
  }
  if (filters.cmcMin !== null || filters.cmcMax !== null) {
    activeChips.push({
      key: 'cmc',
      label: t('filters.cmcRange', { min: filters.cmcMin ?? 0, max: filters.cmcMax ?? '∞' }),
      clear: () => setFilters({ cmcMin: null, cmcMax: null })
    })
  }
  if (filters.valueMin !== null || filters.valueMax !== null) {
    activeChips.push({
      key: 'value',
      label: t('filters.valueRange', { min: filters.valueMin ?? 0, max: filters.valueMax ?? '∞' }),
      clear: () => setFilters({ valueMin: null, valueMax: null })
    })
  }
  if (filters.deckScope !== null) {
    const label =
      filters.deckScope === 'in'
        ? t('filters.inADeck')
        : filters.deckScope === 'out'
          ? t('filters.notInAnyDeck')
          : t('filters.deckPrefix', {
              name: decks.find((d) => d.id === filters.deckScope)?.name ?? filters.deckScope
            })
    activeChips.push({ key: 'deck', label, clear: () => setFilters({ deckScope: null }) })
  }
  if (filters.source) {
    activeChips.push({
      key: 'source',
      label: filters.source === 'collection' ? t('filters.bulkOnly') : t('filters.inDecksOnly'),
      clear: () => setFilters({ source: null })
    })
  }
  if (filters.onlyReserved) {
    activeChips.push({
      key: 'reserved',
      label: t('filters.reserved'),
      clear: () => setFilters({ onlyReserved: false })
    })
  }

  return (
    <div className="shrink-0 border-b border-ink-800 bg-ink-900/80 backdrop-blur">
      <div className="flex flex-wrap items-center gap-2 px-5 py-3">
        <SearchInput
          value={filters.search}
          onChange={(search) => setFilters({ search })}
          placeholder={t('filters.searchPlaceholder')}
        />

        <MultiSelect
          label={t('filters.language')}
          options={(facets?.langs ?? []).map((f) => ({
            value: f.value,
            label: languageName(f.value),
            count: f.count
          }))}
          selected={filters.langs}
          onChange={(langs) => setFilters({ langs })}
        />
        <MultiSelect
          label={t('filters.rarity')}
          options={RARITIES.map((rarity) => ({
            value: rarity,
            label: rarityName(rarity),
            count: facets?.rarities.find((f) => f.value === rarity)?.count
          }))}
          selected={filters.rarities}
          onChange={(rarities) => setFilters({ rarities: rarities as typeof filters.rarities })}
        />
        <MultiSelect
          label={t('filters.set')}
          options={(facets?.sets ?? []).map((f) => ({
            value: f.value,
            label: `${f.value.toUpperCase()} — ${f.label}`,
            count: f.count,
            icon: <SetIcon code={f.value} />
          }))}
          selected={filters.sets}
          onChange={(sets) => setFilters({ sets })}
        />
        <MultiSelect
          label={t('filters.finish')}
          options={FINISHES.map((finish) => ({
            value: finish,
            label: FINISH_LABEL[finish],
            count: facets?.finishes.find((f) => f.value === finish)?.count
          }))}
          selected={filters.finishes}
          onChange={(finishes) => setFilters({ finishes: finishes as typeof filters.finishes })}
        />
        {!!facets?.treatments.length && (
          <MultiSelect
            label={t('filters.treatment')}
            options={facets.treatments.map((tr) => ({
              value: tr.value,
              label: foilTreatmentLabel(tr.value),
              count: tr.count
            }))}
            selected={filters.treatments}
            onChange={(treatments) => setFilters({ treatments })}
          />
        )}
        <Select
          className="w-32"
          value={filters.proxied === null ? '' : filters.proxied ? 'only' : 'hide'}
          onChange={(value) =>
            setFilters({ proxied: value === '' ? null : value === 'only' })
          }
          placeholder={t('proxy.filter')}
          options={[
            { value: 'only', label: t('proxy.filterOnly') },
            { value: 'hide', label: t('proxy.filterExclude') }
          ]}
        />
        <MultiSelect
          label={t('filters.condition')}
          options={CONDITIONS.map((condition) => ({
            value: condition,
            label: condition,
            count: facets?.conditions.find((f) => f.value === condition)?.count
          }))}
          selected={filters.conditions}
          onChange={(conditions) =>
            setFilters({ conditions: conditions as typeof filters.conditions })
          }
        />

        {/*
          Where the copies are, in the row rather than behind More. It decides whether
          you are looking at loose bulk, at cards sleeved in decks, or at both, which
          is a question you ask constantly while sorting a pile.

          Bare, like the proxy filter beside it: every control in this row states
          itself through a label prop or a placeholder, and "Bulk and decks" is what
          this one reads while it is not filtering. The tooltip comes with it — it
          explains that deck copies carry no condition, so a condition filter only ever
          matches cards you entered yourself, which is a real interaction between two
          filters and exactly the kind of note that evaporates in a move.
        */}
        {/* `data-filter` so a check can find this without reading a translated label. */}
        <span title={t('filters.conditionHint')} data-filter="source">
          <Select
            className="w-44"
            value={filters.source ?? ''}
            onChange={(value) =>
              setFilters({ source: value === '' ? null : (value as 'collection' | 'deck') })
            }
            placeholder={t('filters.whereCopies')}
            options={[
              { value: 'collection', label: t('filters.bulkOnly') },
              { value: 'deck', label: t('filters.inDecksOnly') }
            ]}
          />
        </span>

        <Button
          variant={advanced ? 'primary' : 'subtle'}
          size="sm"
          icon={<SlidersHorizontal size={13} />}
          onClick={() => setAdvanced((v) => !v)}
        >
          {t('filters.more')}
        </Button>
      </div>

      <AnimatePresence initial={false}>
        {advanced && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.25, 1, 0.5, 1] }}
            className="overflow-hidden border-t border-ink-800"
          >
            <div className="flex flex-wrap items-end gap-4 px-5 py-3">
              <MultiSelect
                label={t('filters.colors')}
                options={COLOR_OPTIONS}
                selected={filters.colors}
                onChange={(colors) => setFilters({ colors })}
              />

              <label className="flex flex-col gap-1 text-[11px] text-ink-400">
                {t('filters.typeLine')}
                <input
                  value={filters.typeLine}
                  onChange={(e) => setFilters({ typeLine: e.target.value })}
                  placeholder={t('filters.typeLinePlaceholder')}
                  className="field w-40 text-sm outline-none placeholder:text-ink-600"
                />
              </label>

              <RangeInput
                label={t('filters.manaValue')}
                min={filters.cmcMin}
                max={filters.cmcMax}
                onChange={(cmcMin, cmcMax) => setFilters({ cmcMin, cmcMax })}
              />
              <RangeInput
                label={t('filters.unitValue')}
                min={filters.valueMin}
                max={filters.valueMax}
                step="0.01"
                onChange={(valueMin, valueMax) => setFilters({ valueMin, valueMax })}
              />

              <label className="flex flex-col gap-1 text-[11px] text-ink-400">
                {t('filters.deckLocation')}
                <Select
                  className="w-48"
                  value={filters.deckScope === null ? '' : String(filters.deckScope)}
                  onChange={(value) => {
                    if (value === '') setFilters({ deckScope: null })
                    else if (value === 'in' || value === 'out') setFilters({ deckScope: value })
                    else setFilters({ deckScope: Number(value) })
                  }}
                  placeholder={t('filters.anywhere')}
                  options={[
                    { value: 'in', label: t('filters.inADeck') },
                    { value: 'out', label: t('filters.notInAnyDeck') },
                    ...decks.map((deck) => ({ value: String(deck.id), label: deck.name }))
                  ]}
                />
              </label>

              <label className="flex items-center gap-2 pb-1.5 text-xs text-ink-300">
                <input
                  type="checkbox"
                  checked={filters.onlyReserved}
                  onChange={(e) => setFilters({ onlyReserved: e.target.checked })}
                  className="accent-gold-500"
                />
                {t('filters.onlyReserved')}
              </label>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {activeChips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-ink-800 px-5 py-2">
          <AnimatePresence mode="popLayout">
            {activeChips.map((chip) => (
              <Chip key={chip.key} tone="accent" onRemove={chip.clear}>
                {chip.icon}
                {chip.label}
              </Chip>
            ))}
          </AnimatePresence>
          <button
            onClick={resetFilters}
            className="ml-1 text-[11px] text-ink-500 underline-offset-2 transition-colors hover:text-ink-200 hover:underline"
          >
            {t('common.clearAll')}
          </button>
        </div>
      )}
    </div>
  )
}

function RangeInput({
  label,
  min,
  max,
  step = '1',
  onChange
}: {
  label: string
  min: number | null
  max: number | null
  step?: string
  onChange: (min: number | null, max: number | null) => void
}): React.ReactElement {
  const t = useT()
  const parse = (value: string): number | null => {
    if (value.trim() === '') return null
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return (
    <label className="flex flex-col gap-1 text-[11px] text-ink-400">
      {label}
      <span className="flex items-center gap-1.5">
        <input
          type="number"
          step={step}
          value={min ?? ''}
          onChange={(e) => onChange(parse(e.target.value), max)}
          placeholder={t('filters.min')}
          className="field numeric w-20 text-sm outline-none placeholder:text-ink-600"
        />
        <span className="text-ink-600">–</span>
        <input
          type="number"
          step={step}
          value={max ?? ''}
          onChange={(e) => onChange(min, parse(e.target.value))}
          placeholder={t('filters.max')}
          className="field numeric w-20 text-sm outline-none placeholder:text-ink-600"
        />
      </span>
    </label>
  )
}
