import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import { Check, Copy, RefreshCw, X } from 'lucide-react'
import { guard } from '../store/app'
import { useT } from '../hooks/useT'

/**
 * A full-size look at one card's artwork, opened from the detail dialog.
 *
 * Sits at layer 55 — the tier the scale in `index.css` calls "popovers in a
 * modal" — because it is opened from inside the card dialog and has to sit above
 * it. Portalled for the same reason everything floating here is: the dialog is a
 * flex column with `overflow-hidden`, which would clip an in-tree overlay.
 *
 * Copying happens in the main process. The renderer cannot read the bytes: the
 * `matomeru://` scheme is permitted as an image source but not by `connect-src`, so
 * `fetch` on it fails, and drawing to a canvas to read it back would taint the
 * canvas across origins. Main already has the file on disk.
 */
/** The overlay pads itself by 1.5rem a side, so that is what the image gives up. */
const MAX_W = 'calc(100vw - 3rem)'
const MAX_H = 'calc(100vh - 3rem)'

export default function CardZoom({
  scryfallId,
  title,
  open,
  onClose,
  face = 0,
  hasBack = false
}: {
  scryfallId: string
  title: string
  open: boolean
  onClose: () => void
  /** Which side to open on — the one the caller is showing, not always the front. */
  face?: 0 | 1
  /** Whether there is another side to turn to at all. */
  hasBack?: boolean
}): React.ReactElement | null {
  const t = useT()
  const [copied, setCopied] = useState(false)
  const [loaded, setLoaded] = useState(false)
  /*
    Which side is up in here, seeded from the caller.

    Opening always showed the front, so turning a card over in the dialog and then
    clicking the artwork to see it properly showed the side you had just turned away
    from. Seeding from the caller is the fix; keeping it in state is what lets this view
    turn the card over on its own.
  */
  const [shown, setShown] = useState<0 | 1>(face)
  /*
    The side actually painted, which trails `shown` until its picture is decoded.

    Turning the card over used to swap the `src` immediately and blank to the skeleton
    while the new face was fetched -- and opened from a list row, nothing has ever drawn
    the back, so that fetch is cold. Measured: a click, then 50ms of empty grey on a fast
    machine, and however long a cold fetch takes on a slow one, which reads as "the flip
    side does not show; I have to flip again".

    So the current face stays up until the next one is ready to replace it. `decode()`
    rather than an onLoad handler, because an image that is already in the renderer's cache
    can finish before a handler attaches and leave the state stuck at "loading".
  */
  const [painted, setPainted] = useState<0 | 1>(face)

  useEffect(() => {
    if (open) {
      setShown(face)
      setPainted(face)
    }
  }, [open, face])

  useEffect(() => {
    if (!open || painted === shown) return
    let live = true
    const loader = new Image()
    loader.src = window.api.imageUrl(scryfallId, 'large', shown)
    // Either way the wait is over: a face that will not load must not freeze the view.
    void loader
      .decode()
      .catch(() => undefined)
      .then(() => {
        if (live) setPainted(shown)
      })
    return () => {
      live = false
    }
  }, [open, shown, painted, scryfallId])

  /*
    And the other side is fetched as soon as this opens, so the first turn is instant
    rather than paying for the round trip. One extra image per zoom, only for a card that
    has a second face.
  */
  useEffect(() => {
    if (!open || !hasBack) return
    const other = new Image()
    other.src = window.api.imageUrl(scryfallId, 'large', face === 0 ? 1 : 0)
  }, [open, hasBack, scryfallId, face])

  useEffect(() => {
    if (!open) setLoaded(false)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        // Stop the dialog underneath from closing on the same keypress.
        e.stopPropagation()
        onClose()
      }
    }
    // Capture, so this runs before the dialog's own Escape handler.
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  useEffect(() => {
    if (!open) setCopied(false)
  }, [open])

  const copy = async (): Promise<void> => {
    // The side on screen, not the front: copying what you are not looking at is a bug
    // you only notice after pasting it somewhere.
    const ok = await guard(() => window.api.cards.copyImage(scryfallId, shown))
    if (ok) {
      setCopied(true)
      // A tick that fades on its own reads better here than a toast, which would
      // land behind this overlay at layer 60.
      setTimeout(() => setCopied(false), 1600)
    }
  }

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
          onClick={onClose}
          style={{ zIndex: 55 }}
          /*
            A stable handle for the live checks. They used to hunt for `.fixed` or for any
            element with an aria-label, which is how three of them came to report a missing
            backdrop -- a check should not have to guess which div is the overlay.

            Deliberately not `role="dialog"`: this opens from the detail dialog, and the
            checks that reach into that one address it as `[role="dialog"] ...`. A second
            match would have them measuring the overlay instead of the card underneath.
          */
          data-zoom=""
          className="fixed inset-0 flex cursor-zoom-out items-center justify-center bg-black/85
            p-6 backdrop-blur-sm"
        >
          <motion.div
            initial={{ scale: 0.96 }}
            animate={{ scale: 1 }}
            exit={{ scale: 0.96 }}
            transition={{ type: 'spring', stiffness: 420, damping: 34 }}
            // The image is the subject; clicking it must not dismiss, and the
            // default arrow is right for something you only look at.
            //
            // Sized to the card and no larger. It briefly carried `h-full w-full`
            // — a leftover from capping the image with percentages — which made it
            // cover the whole overlay, so this `stopPropagation` swallowed every
            // click outside the card and its cursor hid the backdrop's `zoom-out`.
            onClick={(e) => e.stopPropagation()}
            className="flex max-h-full cursor-default items-center justify-center"
          >
            {/*
              One size, no control to press: actual size when the window can hold
              it, scaled down proportionally when it cannot. The default window is
              900px tall against a 936px card, so the cap is the normal case.

              Sized here rather than through `CardImage` because the cap has to be
              in viewport units. A percentage cap only resolves against an
              ancestor with a definite height, and a centred flex item has none —
              which is exactly how an earlier attempt ended up 672x652, keeping the
              width and breaking the card's proportions.
            */}
            <div className="relative">
              {!loaded && (
                <div
                  className="skeleton rounded-xl"
                  style={{ width: 672, aspectRatio: '488 / 680', maxWidth: MAX_W, maxHeight: MAX_H }}
                />
              )}
              <img
                src={window.api.imageUrl(scryfallId, 'large', painted)}
                alt={title}
                onLoad={() => setLoaded(true)}
                style={{ maxWidth: MAX_W, maxHeight: MAX_H }}
                className={`block h-auto w-auto rounded-xl ring-1 ring-ink-600
                  transition-opacity duration-200 ${
                    loaded ? 'opacity-100' : 'absolute inset-0 opacity-0'
                  }`}
              />
            </div>
          </motion.div>

          <div
            onClick={(e) => e.stopPropagation()}
            className="absolute right-5 top-5 flex items-center gap-2"
          >
            {hasBack && (
              <button
                onClick={() => setShown((s) => (s === 0 ? 1 : 0))}
                title={t('zoom.flip')}
                data-action="flipZoom"
                className="flex items-center gap-1.5 rounded-lg bg-ink-850/90 px-3 py-1.5 text-xs
                  text-ink-100 ring-1 ring-ink-600 transition-colors hover:bg-ink-800"
              >
                <RefreshCw size={13} />
                {t('zoom.flip')}
              </button>
            )}
            <button
              onClick={() => void copy()}
              title={t('zoom.copy')}
              className="flex items-center gap-1.5 rounded-lg bg-ink-850/90 px-3 py-1.5 text-xs
                text-ink-100 ring-1 ring-ink-600 transition-colors hover:bg-ink-800"
            >
              {copied ? <Check size={13} className="text-good" /> : <Copy size={13} />}
              {copied ? t('zoom.copied') : t('zoom.copy')}
            </button>
            <button
              onClick={onClose}
              title={t('common.close')}
              aria-label={t('common.close')}
              className="rounded-lg bg-ink-850/90 p-2 text-ink-200 ring-1 ring-ink-600
                transition-colors hover:bg-ink-800"
            >
              <X size={14} />
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  )
}
