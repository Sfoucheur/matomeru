import { useRef, useState } from 'react'
import { ArrowDown, ArrowUp, ArrowUpDown, X } from 'lucide-react'
import Popover from './Popover'
import { useT } from '../hooks/useT'
import type { TranslationKey } from '@shared/i18n/index'

export interface SortState<F extends string> {
  sort: F
  dir: 'asc' | 'desc'
  sort2: F | null
  dir2: 'asc' | 'desc'
}

/**
 * Two-level sort control, shown in both table and gallery mode.
 *
 * Generic over the field union and driven by `value`/`onChange` rather than
 * reading a store, because the Collection screen's sort is a persisted display
 * preference while the Decks screen's is session-only task state — and the two
 * screens sort by different fields.
 */
export default function SortMenu<F extends string>({
  fields,
  value,
  onChange,
  title = 'Sort'
}: {
  fields: readonly { value: F; label: string }[]
  value: SortState<F>
  onChange: (patch: Partial<SortState<F>>) => void
  title?: string
}): React.ReactElement {
  const t = useT()
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  // Field labels live in the dictionary keyed by field name, so both screens'
  // field lists translate without carrying their own English text.
  const labelFor = (field: string): string => t(`sort.${field}` as TranslationKey)
  const labels = new Map(fields.map((f) => [f.value, labelFor(f.value)]))

  const setPrimary = (field: F): void => {
    // Sorting by colour with no tie-breaker leaves each colour internally
    // jumbled, so pair it with mana value unless a second level is already set.
    const patch: Partial<SortState<F>> = { sort: field }
    const cmc = fields.find((f) => f.value === 'cmc')?.value
    if (field === 'color' && !value.sort2 && cmc) {
      patch.sort2 = cmc
      patch.dir2 = 'asc'
    }
    if (value.sort2 === field) patch.sort2 = null
    onChange(patch)
  }

  const summary = labels.get(value.sort) + (value.sort2 ? ` → ${labels.get(value.sort2)}` : '')

  return (
    <>
      <button
        ref={triggerRef}
        onClick={() => setOpen((v) => !v)}
        title={title}
        className="field flex items-center gap-1.5 whitespace-nowrap text-xs text-ink-300"
      >
        <ArrowUpDown size={13} className="text-ink-500" />
        <span className="max-w-44 truncate">{summary}</span>
      </button>

      <Popover open={open} onClose={() => setOpen(false)} trigger={triggerRef} width={252} align="end">
        <Level
          heading={t('sort.by')}
          fields={fields}
          value={value.sort}
          dir={value.dir}
          onField={setPrimary}
          onDir={(dir) => onChange({ dir })}
        />

        <div className="my-1 border-t border-ink-700" />

        <Level
          heading={t('sort.thenBy')}
          fields={fields}
          value={value.sort2}
          dir={value.dir2}
          // The primary is excluded: sorting by the same field twice does nothing.
          exclude={value.sort}
          onField={(field) => onChange({ sort2: field })}
          onDir={(dir2) => onChange({ dir2 })}
          onClear={value.sort2 ? () => onChange({ sort2: null }) : undefined}
        />
      </Popover>
    </>
  )
}

function Level<F extends string>({
  heading,
  fields,
  value,
  dir,
  exclude,
  onField,
  onDir,
  onClear
}: {
  heading: string
  fields: readonly { value: F; label: string }[]
  value: F | null
  dir: 'asc' | 'desc'
  exclude?: F
  onField: (field: F) => void
  onDir: (dir: 'asc' | 'desc') => void
  onClear?: () => void
}): React.ReactElement {
  const t = useT()
  const labelFor = (field: string): string => t(`sort.${field}` as TranslationKey)
  return (
    <div>
      <div className="flex items-center gap-2 px-2 pb-1 pt-1.5">
        <span className="flex-1 text-[10px] font-semibold uppercase tracking-wider text-ink-500">
          {heading}
        </span>
        {value && (
          <div className="flex overflow-hidden rounded border border-ink-700">
            <button
              onClick={() => onDir('asc')}
              title={t('sort.ascending')}
              className={`px-1.5 py-0.5 ${
                dir === 'asc' ? 'bg-ink-700 text-gold-400' : 'text-ink-500 hover:bg-ink-800'
              }`}
            >
              <ArrowUp size={11} />
            </button>
            <button
              onClick={() => onDir('desc')}
              title={t('sort.descending')}
              className={`border-l border-ink-700 px-1.5 py-0.5 ${
                dir === 'desc' ? 'bg-ink-700 text-gold-400' : 'text-ink-500 hover:bg-ink-800'
              }`}
            >
              <ArrowDown size={11} />
            </button>
          </div>
        )}
        {onClear && (
          <button
            onClick={onClear}
            title={t('sort.removeTiebreak')}
            className="rounded p-0.5 text-ink-500 transition-colors hover:bg-ink-800 hover:text-ink-200"
          >
            <X size={11} />
          </button>
        )}
      </div>

      {fields
        .filter((f) => f.value !== exclude)
        .map((field) => (
          <button
            key={field.value}
            onClick={() => onField(field.value)}
            className={`flex w-full items-center rounded px-2 py-1 text-left text-xs transition-colors
            hover:bg-ink-750 ${value === field.value ? 'text-gold-300' : 'text-ink-300'}`}
          >
              <span className="flex-1">{labelFor(field.value)}</span>
            {value === field.value && <span className="text-[10px] text-gold-400">●</span>}
          </button>
        ))}
    </div>
  )
}
