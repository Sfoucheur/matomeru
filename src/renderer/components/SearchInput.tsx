import { useEffect, useState } from 'react'
import { Search, X } from 'lucide-react'
import { useT } from '../hooks/useT'

/**
 * Debounced search field.
 *
 * Extracted from `FilterBar` once the Decks screen needed the same behaviour:
 * type freely, commit 220ms later. The local draft is what the input renders, so
 * keystrokes stay instant even when committing is expensive; the effect below
 * pulls the draft back in line when the committed value changes from elsewhere
 * (a chip being cleared, "Clear all", switching decks).
 */
export default function SearchInput({
  value,
  onChange,
  placeholder,
  className = 'min-w-64 flex-1'
}: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  className?: string
}): React.ReactElement {
  const t = useT()
  const [draft, setDraft] = useState(value)

  useEffect(() => {
    const timer = setTimeout(() => {
      if (draft !== value) onChange(draft)
    }, 220)
    return () => clearTimeout(timer)
  }, [draft, value, onChange])

  useEffect(() => setDraft(value), [value])

  return (
    <div className={`field flex items-center gap-2 py-1.5 ${className}`}>
      <Search size={14} className="shrink-0 text-ink-500" />
      <input
        data-search
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={placeholder ?? t('search.placeholder')}
        className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-ink-500"
      />
      {draft && (
        <button
          onClick={() => setDraft('')}
          className="shrink-0 rounded p-0.5 text-ink-500 transition-colors hover:text-ink-200"
          aria-label={t('search.clear')}
        >
          <X size={13} />
        </button>
      )}
    </div>
  )
}
