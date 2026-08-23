import { useState } from 'react'

/**
 * A set's symbol, served from the local cache over `matomeru://seticon/{code}`.
 *
 * The renderer never reaches Scryfall itself: the main process resolves the URL
 * from its cached set list, downloads the SVG once and serves it, exactly as card
 * images work. That keeps the CSP tight and means a set filter scrolls without
 * firing a request per row on every open.
 *
 * A set with no symbol — or one Scryfall does not know — renders nothing rather
 * than a broken image, so the label simply sits where the icon would be.
 */
export default function SetIcon({
  code,
  size = 12,
  className = ''
}: {
  code: string
  size?: number
  className?: string
}): React.ReactElement | null {
  const [failed, setFailed] = useState(false)
  if (!code || failed) return null
  return (
    <img
      src={`matomeru://seticon/${code.toLowerCase()}`}
      alt=""
      aria-hidden
      width={size}
      height={size}
      onError={() => setFailed(true)}
      // Symbols are black-on-transparent, so they need inverting to read on a
      // dark panel. `brightness-0 invert` gets pure white; the opacity keeps them
      // from shouting over the label they belong to.
      className={`inline-block shrink-0 brightness-0 invert opacity-70 ${className}`}
      style={{ width: size, height: size }}
    />
  )
}
