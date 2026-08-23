import { useEffect } from 'react'
import { Minus, Plus } from 'lucide-react'
import { GRID_MAX_COLUMNS, GRID_MIN_COLUMNS, type GridKey } from '@shared/types'
import { useApp } from '../store/app'
import { useT } from '../hooks/useT'

/**
 * Column-count control for an image grid. Fewer columns means bigger cards, so
 * the minus button (fewer columns) makes cards *larger* — the label reads as
 * "N per row" to keep that unambiguous.
 */
export default function ColumnStepper({
  grid,
  enabled = true
}: {
  grid: GridKey
  /** Bind the keyboard shortcuts only while this grid is the visible one. */
  enabled?: boolean
}): React.ReactElement {
  const t = useT()
  const columns = useApp((s) => s.columnsFor(grid))
  const nudge = useApp((s) => s.nudgeColumns)

  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent): void => {
      if (!e.ctrlKey && !e.metaKey) return
      // Zoom in means bigger cards, which means FEWER columns. Getting this
      // backwards is the easy mistake here.
      if (e.key === '=' || e.key === '+') {
        e.preventDefault()
        nudge(grid, -1)
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault()
        nudge(grid, 1)
      } else if (e.key === '0') {
        e.preventDefault()
        nudge(grid, null)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [enabled, grid, nudge])

  return (
    <div
      className="flex items-center overflow-hidden rounded-lg border border-ink-700"
      title={t('columns.title')}
    >
      <button
        onClick={() => nudge(grid, -1)}
        disabled={columns <= GRID_MIN_COLUMNS}
        className="px-2 py-1.5 text-ink-400 transition-colors hover:bg-ink-800 hover:text-gold-400
          disabled:opacity-30 disabled:hover:bg-transparent"
        aria-label={t('columns.fewer')}
      >
        <Minus size={13} />
      </button>
      <span className="numeric min-w-14 border-x border-ink-700 px-1 py-1.5 text-center text-[11px] text-ink-300">
        {t('columns.perRow', { count: columns })}
      </span>
      <button
        onClick={() => nudge(grid, 1)}
        disabled={columns >= GRID_MAX_COLUMNS}
        className="px-2 py-1.5 text-ink-400 transition-colors hover:bg-ink-800 hover:text-gold-400
          disabled:opacity-30 disabled:hover:bg-transparent"
        aria-label={t('columns.more')}
      >
        <Plus size={13} />
      </button>
    </div>
  )
}
