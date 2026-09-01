import { useEffect, useLayoutEffect, useRef, useState } from 'react'

export interface BoxSize {
  /** Attach to the element to measure. */
  ref: React.RefObject<HTMLDivElement | null>
  width: number
  height: number
}

/**
 * The measured content box of one element.
 *
 * For laying something out against room that only CSS knows about — the detail dialog's
 * artwork, which has to fit both the height its details column left and the width of its own
 * column, and stay card-shaped. CSS can hold one of those constraints or the other; `min` of
 * two measured numbers holds both.
 *
 * Safe only for something *out of flow*: measuring a box and then sizing a child that
 * contributes to that box's size is a feedback loop. `useGridMetrics` is the same pattern for
 * a scroll container; this is the small version, without the column arithmetic.
 *
 * Zero until the first measurement, so callers must have an answer for that frame.
 */
export function useBoxSize(): BoxSize {
  const ref = useRef<HTMLDivElement | null>(null)
  const [element, setElement] = useState<HTMLDivElement | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })

  /*
    The element is tracked in state rather than read once in an effect.

    The first commit does not always contain it: the detail dialog renders a skeleton while
    it fetches, so on mount there is no box to observe, and an effect with an empty dependency
    list gets one look and never another. It reported zero for ever, the size it feeds was
    skipped as "not measured yet", and the frame silently kept its old CSS behaviour --
    which is the exact failure `useGridMetrics` documents at its own `adopt`.
  */
  const adopt = (): void =>
    setElement((current) => (ref.current !== current ? ref.current : current))
  useLayoutEffect(adopt)
  useEffect(adopt)

  useLayoutEffect(() => {
    if (!element) return

    const measure = (width: number, height: number): void =>
      setSize((current) =>
        // A sub-pixel change is not worth a render; a real one is.
        Math.abs(current.width - width) > 0.5 || Math.abs(current.height - height) > 0.5
          ? { width: Math.max(0, width), height: Math.max(0, height) }
          : current
      )

    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect
      if (box) measure(box.width, box.height)
    })
    observer.observe(element)
    // The same box the observer reports — `contentRect` excludes padding and
    // `getBoundingClientRect` does not — so there is no one-frame jump.
    const style = getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    measure(
      rect.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
      rect.height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
    )
    return () => observer.disconnect()
  }, [element])

  return { ref, width: size.width, height: size.height }
}
