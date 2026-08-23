import { useCallback, useEffect, useLayoutEffect, useState } from 'react'
import { tileDensity, type GridKey, type TileDensity } from '@shared/types'
import { useApp } from '../store/app'

export interface GridMetrics {
  columns: number
  /** Measured tile width in px, so tiles degrade on real size not column count. */
  tileWidth: number
  density: TileDensity
  /** False until the container has been measured; nothing sized should render yet. */
  ready: boolean
}

/** A card's aspect ratio, which is what makes a tile row's height predictable. */
export const CARD_ASPECT = 680 / 488

/**
 * Measures one scroll container and reports the tile geometry for a grid.
 *
 * Extracted from `GalleryGrid` because the Decks screen used to mount one grid
 * per category — eighteen `ResizeObserver`s and eighteen non-passive `wheel`
 * listeners for what is conceptually one page of cards. Both now belong to
 * whoever owns the scrolling element, once.
 */
export function useGridMetrics(
  grid: GridKey,
  ref: React.RefObject<HTMLElement | null>,
  { gap = 16, enabled = true }: { gap?: number; enabled?: boolean } = {}
): GridMetrics {
  const columns = useApp((s) => s.columnsFor(grid))
  const nudge = useApp((s) => s.nudgeColumns)
  const [element, setElement] = useState<HTMLElement | null>(null)
  const [width, setWidth] = useState(0)

  /*
    The measured element is tracked in state rather than read straight from the
    ref, because a ref that belongs to a *parent* component is not attached yet
    when this hook's layout effect runs — React commits refs bottom-up, so a child
    sees null. Reading it in both phases means passing down a parent's scroll
    container works; giving up on the first miss silently left the grid unmeasured
    and therefore empty.
  */
  const adopt = (): void =>
    setElement((current) => (ref.current !== current ? ref.current : current))
  useLayoutEffect(adopt)
  useEffect(adopt)

  useLayoutEffect(() => {
    if (!element) return
    const measure = (next: number): void =>
      setWidth((current) => (Math.abs(current - next) > 0.5 ? Math.max(0, next) : current))
    const observer = new ResizeObserver((entries) => measure(entries[0]?.contentRect.width ?? 0))
    observer.observe(element)
    // contentRect excludes padding; getBoundingClientRect does not, so read the
    // same box the observer will report to avoid a one-frame width jump.
    const style = getComputedStyle(element)
    const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
    measure(element.getBoundingClientRect().width - padding)
    return () => observer.disconnect()
  }, [element])

  // Ctrl+scroll over the grid, the gesture people try first.
  const onWheel = useCallback(
    (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      nudge(grid, e.deltaY > 0 ? 1 : -1)
    },
    [grid, nudge]
  )

  useEffect(() => {
    if (!element || !enabled) return
    // Non-passive, or preventDefault cannot stop the browser zooming instead.
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [element, onWheel, enabled])

  const tileWidth = width > 0 ? (width - gap * (columns - 1)) / columns : 0
  return { columns, tileWidth, density: tileDensity(tileWidth || 999), ready: width > 0 }
}
