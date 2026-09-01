import { ChevronLeft, ChevronRight } from 'lucide-react'
import { ROWS_PER_PAGE_CHOICES, type PagedScreen } from '@shared/types'
import { useApp } from '../store/app'
import { useT } from '../hooks/useT'
import { count } from '../lib/format'
import { Select } from './primitives'

/**
 * One page of a long list, and the choice of how long a page is.
 *
 * Both lists it serves are virtualized, so this is not about drawing fewer rows — it is
 * about reaching the ones a single query never returned. The Collection asked SQLite for the
 * first 200 rows and offset zero, for ever; a bulk collection of three thousand cards had
 * two thousand eight hundred of them unreachable except by narrowing the filters, which is
 * what the note this replaces used to advise.
 *
 * The extent is stated as a range rather than a page number, because "1–200 of 3 412" answers
 * the question people actually have. Deliberately no "rows" or "lignes" next to a figure: a
 * live check scrapes the screen for that word beside a number to find the list's own summary,
 * and a second match would answer it instead.
 */
export default function Paginator({
  screen,
  offset,
  onOffset,
  total,
  shown
}: {
  screen: PagedScreen
  /** Index of the first card on this page, counted over the whole filtered set. */
  offset: number
  onOffset: (offset: number) => void
  /** Everything the filters matched, which is what the pages divide. */
  total: number
  /** Cards on this page — the last one is usually short. */
  shown: number
}): React.ReactElement {
  const t = useT()
  const size = useApp((s) => s.rowsPerPageFor(screen))
  const setSize = useApp((s) => s.setRowsPerPage)

  const pages = Math.max(1, Math.ceil(total / size))
  const page = Math.floor(offset / size) + 1
  const first = total === 0 ? 0 : offset + 1

  return (
    <div
      data-paginator={screen}
      className="flex shrink-0 items-center justify-between gap-4 border-t border-ink-800 px-5 py-2"
    >
      <label className="flex items-center gap-2 text-[11px] text-ink-500">
        {t('page.perPage')}
        <Select
          className="w-20"
          value={String(size)}
          onChange={(value) => {
            /*
              Anchored on the first card of the current page, not on the page number: a page
              number means a different card at every size, so growing the page from 50 to 500
              would jump somewhere unrelated. Landing on the page that contains what you were
              looking at is the honest answer.
            */
            const next = Number(value)
            setSize(screen, next)
            onOffset(Math.floor(offset / next) * next)
          }}
          options={ROWS_PER_PAGE_CHOICES.map((choice) => ({
            value: String(choice),
            label: String(choice)
          }))}
        />
      </label>

      <span data-page-range className="numeric text-[11px] text-ink-400">
        {t('page.range', {
          first: count(first),
          last: count(Math.min(offset + shown, total)),
          total: count(total)
        })}
      </span>

      <div className="flex items-center overflow-hidden rounded-lg border border-ink-700">
        <button
          data-action="prevPage"
          onClick={() => onOffset(Math.max(0, offset - size))}
          disabled={offset <= 0}
          aria-label={t('page.previous')}
          className="px-2 py-1.5 text-ink-400 transition-colors hover:bg-ink-800
            hover:text-gold-400 disabled:opacity-30 disabled:hover:bg-transparent"
        >
          <ChevronLeft size={13} />
        </button>
        <span
          className="numeric min-w-16 border-x border-ink-700 px-1 py-1.5 text-center
            text-[11px] text-ink-300"
        >
          {t('page.of', { page: count(page), pages: count(pages) })}
        </span>
        <button
          data-action="nextPage"
          onClick={() => onOffset(offset + size)}
          disabled={offset + size >= total}
          aria-label={t('page.next')}
          className="px-2 py-1.5 text-ink-400 transition-colors hover:bg-ink-800
            hover:text-gold-400 disabled:opacity-30 disabled:hover:bg-transparent"
        >
          <ChevronRight size={13} />
        </button>
      </div>
    </div>
  )
}
