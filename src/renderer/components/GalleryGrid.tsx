import { useLayoutEffect, useMemo, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { GridKey, TileDensity } from '@shared/types'
import { CARD_ASPECT, useGridMetrics } from '../hooks/useGridMetrics'

export interface GalleryGridRenderArgs {
  index: number
  /** Measured tile width in px, so tiles degrade on real size not column count. */
  tileWidth: number
  density: TileDensity
}

/**
 * A fixed-column image grid.
 *
 * The column count is explicit rather than `auto-fill`, because the point of the
 * control is that fewer columns produce bigger cards. `minmax(0, 1fr)` rather
 * than `1fr` matters: a plain `1fr` track refuses to shrink below its content
 * and would blow the row out sideways at high column counts.
 *
 * Pass `scrollRef` — the element that actually scrolls — to have the grid
 * virtualize its rows, rendering only the tiles on screen. Without it the grid
 * renders everything, which is the right choice for a handful of items (the
 * printing picker) and the wrong one for hundreds.
 */
export default function GalleryGrid<T>({
  grid,
  items,
  gap = 16,
  className = '',
  scrollRef,
  children
}: {
  grid: GridKey
  items: T[]
  gap?: number
  className?: string
  scrollRef?: React.RefObject<HTMLElement | null>
  children: (item: T, args: GalleryGridRenderArgs) => React.ReactNode
}): React.ReactElement {
  const ownRef = useRef<HTMLDivElement>(null)
  const measured = scrollRef ?? ownRef
  const { columns, tileWidth, density, ready } = useGridMetrics(grid, measured, { gap })

  const style = {
    gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
    gap
  }

  if (!scrollRef) {
    return (
      <div ref={ownRef} className={`grid ${className}`} style={style}>
        {items.map((item, index) => children(item, { index, tileWidth, density }))}
      </div>
    )
  }

  return (
    <VirtualRows
      items={items}
      columns={columns}
      gap={gap}
      tileWidth={tileWidth}
      density={density}
      ready={ready}
      scrollRef={scrollRef}
      className={className}
      style={style}
    >
      {children}
    </VirtualRows>
  )
}

function VirtualRows<T>({
  items,
  columns,
  gap,
  tileWidth,
  density,
  ready,
  scrollRef,
  className,
  style,
  children
}: {
  items: T[]
  columns: number
  gap: number
  tileWidth: number
  density: TileDensity
  ready: boolean
  scrollRef: React.RefObject<HTMLElement | null>
  className: string
  style: React.CSSProperties
  children: (item: T, args: GalleryGridRenderArgs) => React.ReactNode
}): React.ReactElement {
  const rows = useMemo(() => {
    const size = Math.max(1, columns)
    const chunks: { items: T[]; from: number }[] = []
    for (let i = 0; i < items.length; i += size) {
      chunks.push({ items: items.slice(i, i + size), from: i })
    }
    return chunks
  }, [items, columns])

  // A card's aspect ratio makes the row height exact rather than estimated, so
  // there is no measure-then-correct pass while scrolling.
  const rowHeight = tileWidth * CARD_ASPECT + gap

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 3
  })

  // Column count and width both change the row height, and the virtualizer caches
  // sizes, so it has to be told.
  useLayoutEffect(() => {
    virtualizer.measure()
  }, [virtualizer, rowHeight])

  // Until the container has been measured every row would estimate to zero height,
  // and a zero estimate makes the virtualizer render the entire list at once.
  if (!ready) return <div className={className} />

  return (
    <div
      className={className}
      style={{ height: virtualizer.getTotalSize(), position: 'relative' }}
    >
      {virtualizer.getVirtualItems().map((virtualRow) => {
        const row = rows[virtualRow.index]
        return (
          <div
            key={virtualRow.key}
            className="grid"
            style={{
              ...style,
              position: 'absolute',
              top: virtualRow.start,
              left: 0,
              width: '100%'
            }}
          >
            {row.items.map((item, offset) =>
              children(item, { index: row.from + offset, tileWidth, density })
            )}
          </div>
        )
      })}
    </div>
  )
}
