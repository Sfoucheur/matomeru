import { useCallback, useRef, useState } from 'react'

/**
 * How a click changes the selection.
 *
 *  - `only`   — this one and nothing else. A plain click in a list.
 *  - `toggle` — add or remove this one. Ctrl, or Cmd on a Mac.
 *  - `range`  — everything from the last one picked to this one. Shift.
 */
export type PickMode = 'only' | 'toggle' | 'range'

/** One selectable thing, in the order it is drawn. */
export interface SelectableItem<K> {
  key: K
  /**
   * Whether a range may pick this one up.
   *
   * Ranges are the only place this is consulted: a direct click on something
   * unselectable never reaches here, because the row does not offer the gesture.
   */
  selectable: boolean
}

/**
 * Selection with Ctrl and Shift, shared by every screen that has a list of cards.
 *
 * There were two copies of this — the collection's and the Decks screen's — and
 * they had drifted: one offered a plain-click mode the other did not, and only one
 * of them was wired to a list at all, which is the bug this fixes. One
 * implementation is the only way "the same everywhere" stays true.
 *
 * Ranges walk `ordered`, never the DOM. Both lists are virtualized, so most rows
 * in a range are not mounted and a DOM walk would silently select a fraction of
 * what was asked for.
 */
export function useRangeSelection<K>(ordered: readonly SelectableItem<K>[]): {
  selected: Set<K>
  pick: (key: K, mode: PickMode) => void
  clear: () => void
  /** Set the selection outright — for a select-all that reaches past what is drawn. */
  replace: (keys: readonly K[]) => void
  /** Everything selectable that is currently drawn. */
  selectAllShown: () => void
  /** Drop everything the predicate rejects, for callers that prune on a requery. */
  keep: (predicate: (key: K) => boolean) => void
} {
  const [selected, setSelected] = useState<Set<K>>(() => new Set())
  /** Where a range starts: the last thing clicked, whatever it did. */
  const anchor = useRef<K | null>(null)

  /*
    `ordered` is rebuilt every render by both callers, so it is read through a ref
    rather than closed over. Otherwise `pick` changes identity on every render and
    every memoized row re-renders with it — which on a 200-row virtualized list is
    the difference between a click and a visible stutter.
  */
  const orderedRef = useRef(ordered)
  orderedRef.current = ordered

  const toggle = useCallback((key: K) => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
    anchor.current = key
  }, [])

  const pick = useCallback(
    (key: K, mode: PickMode) => {
      if (mode === 'only') {
        setSelected(new Set([key]))
        anchor.current = key
        return
      }
      if (mode === 'toggle' || anchor.current === null) {
        toggle(key)
        return
      }
      const list = orderedRef.current
      const from = list.findIndex((item) => item.key === anchor.current)
      const to = list.findIndex((item) => item.key === key)
      // An anchor that has since scrolled out of the result set is no anchor at
      // all; toggling is the honest fallback.
      if (from === -1 || to === -1) {
        toggle(key)
        return
      }
      const [start, end] = from <= to ? [from, to] : [to, from]
      setSelected((current) => {
        const next = new Set(current)
        for (let i = start; i <= end; i += 1) {
          if (list[i].selectable) next.add(list[i].key)
        }
        return next
      })
      anchor.current = key
    },
    [toggle]
  )

  const clear = useCallback(() => {
    setSelected(new Set())
    anchor.current = null
  }, [])

  const replace = useCallback((keys: readonly K[]) => {
    setSelected(new Set(keys))
    // The last of a bulk selection is a sensible place for a range to start from.
    anchor.current = keys.length > 0 ? keys[keys.length - 1] : null
  }, [])

  const selectAllShown = useCallback(() => {
    const selectable = orderedRef.current.filter((item) => item.selectable)
    setSelected(new Set(selectable.map((item) => item.key)))
    anchor.current = selectable.length > 0 ? selectable[selectable.length - 1].key : null
  }, [])

  const keep = useCallback((predicate: (key: K) => boolean) => {
    setSelected((current) => {
      const next = new Set([...current].filter(predicate))
      return next.size === current.size ? current : next
    })
    if (anchor.current !== null && !predicate(anchor.current)) anchor.current = null
  }, [])

  return { selected, pick, clear, replace, selectAllShown, keep }
}
