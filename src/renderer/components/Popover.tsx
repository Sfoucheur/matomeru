import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'

/**
 * A floating panel rendered into `document.body`.
 *
 * The portal is the point. An absolutely-positioned dropdown is at the mercy of
 * every ancestor: the filter bar's `backdrop-blur` creates a stacking context
 * that traps any z-index inside it, and the collapsible "More" panel's
 * `overflow-hidden` clips its children outright. No z-index can escape either.
 * Rendering outside the tree sidesteps both, and lets the blur and the height
 * animation stay exactly as they are.
 *
 * Positioned `fixed` from the trigger's rect, flipping above when it would run
 * off the bottom of the window.
 */
export default function Popover({
  open,
  onClose,
  trigger,
  /** Fixed panel width, or 'trigger' to match the trigger's width. */
  width = 224,
  align = 'start',
  /**
   * False when the child manages its own scrolling — a searchable list keeps its
   * input pinned outside the scroller, which a scrolling panel cannot do.
   */
  scroll = true,
  children,
  className = ''
}: {
  open: boolean
  onClose: () => void
  trigger: React.RefObject<HTMLElement | null>
  width?: number | 'trigger'
  align?: 'start' | 'end'
  scroll?: boolean
  children: React.ReactNode
  className?: string
}): React.ReactElement | null {
  const panelRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{
    top: number
    left: number
    width: number
    flipped: boolean
  } | null>(null)

  const measure = useCallback(() => {
    const el = trigger.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const panelWidth = width === 'trigger' ? rect.width : width
    const gap = 6
    // Prefer below; flip above when the remaining space cannot hold the panel.
    const panelHeight = panelRef.current?.offsetHeight ?? 288
    const spaceBelow = window.innerHeight - rect.bottom - gap
    const flipped = spaceBelow < panelHeight && rect.top > spaceBelow

    const rawLeft = align === 'end' ? rect.right - panelWidth : rect.left
    // Keep the panel on screen horizontally whichever edge it is near.
    const left = Math.max(8, Math.min(rawLeft, window.innerWidth - panelWidth - 8))

    setPos({
      top: flipped ? rect.top - gap - panelHeight : rect.bottom + gap,
      left,
      width: panelWidth,
      flipped
    })
  }, [align, trigger, width])

  useLayoutEffect(() => {
    if (!open) {
      setPos(null)
      return
    }
    measure()
  }, [open, measure])

  // A fixed panel would otherwise drift away from its trigger.
  useEffect(() => {
    if (!open) return
    const onScrollOrResize = (): void => measure()
    window.addEventListener('resize', onScrollOrResize)
    // Capture phase so scrolling any ancestor container counts, not just the window.
    window.addEventListener('scroll', onScrollOrResize, true)
    return () => {
      window.removeEventListener('resize', onScrollOrResize)
      window.removeEventListener('scroll', onScrollOrResize, true)
    }
  }, [open, measure])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node
      // Both refs must be checked: with a portal the panel is NOT a descendant of
      // the trigger, so testing the trigger alone would close on the first click
      // inside the list.
      if (trigger.current?.contains(target)) return
      if (panelRef.current?.contains(target)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, onClose, trigger])

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          ref={panelRef}
          initial={{ opacity: 0, y: pos?.flipped ? 6 : -6, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: pos?.flipped ? 6 : -6, scale: 0.97 }}
          transition={{ duration: 0.14, ease: [0.25, 1, 0.5, 1] }}
          style={{
            position: 'fixed',
            top: pos?.top ?? -9999,
            left: pos?.left ?? -9999,
            width: pos?.width,
            /*
              A popover on the page belongs below the modal layer; one opened from
              inside a modal has to be above it, or it renders behind the very
              dialog that owns it. Read from the trigger rather than passed in as a
              prop, so any popover placed in a modal is correct without the caller
              remembering a flag.
            */
            zIndex: trigger.current?.closest('[role="dialog"]') ? 55 : 45
          }}
          /*
            A stable hook for the live checks. They used to find this by its
            styling class, so renaming `.panel` to `.panel-floating` silently broke
            four of them — a check should not depend on how something looks.
          */
          data-popover=""
          className={`panel-floating p-1 shadow-2xl shadow-black/50 ${
            scroll ? 'max-h-72 overflow-y-auto' : ''
          } ${className}`}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  )
}
