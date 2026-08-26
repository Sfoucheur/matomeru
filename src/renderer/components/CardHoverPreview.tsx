import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import { CardImage } from './primitives'

/** Drawn at 240 wide, in the card's own proportions. */
const WIDTH = 240
const HEIGHT = Math.round((WIDTH * 680) / 488)
/** The viewport margin the popovers already keep. */
const EDGE = 8
/** Clear of the thumbnail, so the card is not sitting on what you are pointing at. */
const GAP = 12

interface Shown {
  scryfallId: string
  top: number
  left: number
}

interface CardPreview {
  /**
   * Bind to the thumbnail's `mouseenter` (and `focus`, where the thumbnail can take it).
   * Stable, so handing it to a memoized row does not break the memo.
   */
  onEnter: (scryfallId: string | null, anchor: HTMLElement | null) => void
  /** Bind to `mouseleave` and `blur`. */
  onLeave: () => void
  /** Rendered once by the view. One panel for the whole list. */
  panel: React.ReactElement
}

/**
 * The card under the pointer, drawn big enough to read.
 *
 * In list mode a card is a row of text and a thumbnail 28px wide — the artwork is the one
 * thing the list cannot show you. Clicking already opens the full-screen look; this is for
 * running down a list without opening anything.
 *
 * One panel and one timer for the whole list, not one per row. The lists are virtualized
 * and mount and unmount hundreds of rows as they scroll, so per-row state would be
 * hundreds of timers, and a per-row `useState` would re-render the row under the pointer
 * on every hover. The rows get two stable callbacks and own nothing.
 */
export function useCardPreview(): CardPreview {
  const [shown, setShown] = useState<Shown | null>(null)
  /*
    Which size is on screen.

    The row's own thumbnail has just painted `small`, so that one is warm and appears
    instantly; `normal` may not be cached at all, and the protocol fetches it on demand,
    which on a cold card means a grey box for as long as Scryfall takes. So the panel
    opens with the size we already have and swaps up when the better one has decoded --
    the same trick, for the same reason, as the zoom view's face swapping.
  */
  const [painted, setPainted] = useState<'small' | 'normal'>('small')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** What is on screen, readable without making the callbacks depend on it. */
  const showing = useRef<string | null>(null)

  const place = useCallback((scryfallId: string, anchor: HTMLElement): Shown => {
    const rect = anchor.getBoundingClientRect()
    /*
      Beside the thumbnail, on whichever side has room. The thumbnail sits at the left of
      the row, so the right is nearly always the roomier side; the flip is for a window
      narrow enough that 240px does not fit there.
    */
    let left = rect.right + GAP
    if (left + WIDTH > window.innerWidth - EDGE) left = rect.left - GAP - WIDTH
    left = Math.max(EDGE, left)
    /*
      Centred on the row rather than aligned to its top, so the card does not climb the
      screen as the pointer moves down the list, then clamped so a row near either end of
      the window still shows a whole card.
    */
    const top = Math.min(
      Math.max(EDGE, rect.top + rect.height / 2 - HEIGHT / 2),
      window.innerHeight - HEIGHT - EDGE
    )
    return { scryfallId, top, left }
  }, [])

  /*
    Shown after a moment, cleared after a shorter one.

    Both delays earn their keep. The 180ms before the first appearance is what keeps a
    pointer crossing a long list from asking for a hundred images -- the protocol fetches a
    size it has not cached yet, so only a card you actually rest on is ever downloaded. The
    140ms before clearing is what stopped the printing list flashing between adjacent rows,
    and these rows are adjacent the same way. Once a card is up, moving to the next row
    swaps at once: the delay is about the first appearance, not about the switch.
  */
  const onEnter = useCallback(
    (scryfallId: string | null, anchor: HTMLElement | null) => {
      if (timer.current) clearTimeout(timer.current)
      if (scryfallId === null || anchor === null) {
        timer.current = setTimeout(() => {
          showing.current = null
          setShown(null)
        }, 140)
        return
      }
      const show = (): void => {
        // Measured when it appears rather than when the pointer arrived: 180ms is time
        // enough for the list to have moved under it.
        if (!anchor.isConnected) return
        showing.current = scryfallId
        setShown(place(scryfallId, anchor))
      }
      if (showing.current !== null) return show()
      timer.current = setTimeout(show, 180)
    },
    [place]
  )

  const onLeave = useCallback(() => onEnter(null, null), [onEnter])

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )

  /*
    Upgrade after the fact, and only once the bigger file can be drawn.

    `decode()` rather than an `onLoad` handler, because an image already in the renderer's
    cache can finish before a handler attaches -- which would leave this stuck on the
    small one forever.
  */
  const id = shown?.scryfallId ?? null
  useEffect(() => {
    setPainted('small')
    if (id === null) return undefined
    let live = true
    const bigger = new Image()
    bigger.src = window.api.imageUrl(id, 'normal')
    void bigger
      .decode()
      .catch(() => undefined)
      .then(() => {
        if (live) setPainted('normal')
      })
    return () => {
      live = false
    }
  }, [id])

  /*
    A scroll closes it.

    The rows are virtualized, so a wheel under a stationary pointer slides the row out from
    under the panel and may recycle the element it was measured against. Re-measuring would
    mean holding on to an element the list is about to discard; closing costs a line, and
    the browser re-runs its hit testing after a scroll, so the row that arrives under the
    pointer opens its own preview. Capture phase, because the scroller is an ancestor and
    scroll does not bubble.
  */
  useEffect(() => {
    if (shown === null) return undefined
    const close = (): void => {
      if (timer.current) clearTimeout(timer.current)
      showing.current = null
      setShown(null)
    }
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [shown])

  const panel = createPortal(
    <AnimatePresence>
      {shown && (
        <motion.div
          key="card-preview"
          initial={{ opacity: 0, scale: 0.97 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.13, ease: [0.25, 1, 0.5, 1] }}
          style={{
            position: 'fixed',
            top: shown.top,
            left: shown.left,
            width: WIDTH,
            // The popover tier, from the scale in index.css. Portalled, because a row is
            // inside a virtualized scroller that would clip it and declares a height this
            // would overflow.
            zIndex: 45,
            /*
              It takes no pointer events, and that is the load-bearing line.

              A panel that could take the pointer would take it from the thumbnail
              underneath, whose `mouseleave` would close the panel, which would hand the
              pointer back -- a flicker loop. A preview is not something you interact
              with, so it never receives a pointer at all.
            */
            pointerEvents: 'none'
          }}
          /* A stable hook for the live checks; `data-card-preview` is the detail dialog's. */
          data-hover-preview=""
          aria-hidden="true"
          className="panel-floating overflow-hidden p-0 shadow-2xl shadow-black/50"
        >
          <CardImage
            scryfallId={shown.scryfallId}
            size={painted}
            alt=""
            className="block aspect-[488/680] w-full"
          />
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  )

  return { onEnter, onLeave, panel }
}
