import { protocol } from 'electron'
import { createWriteStream, existsSync } from 'node:fs'
import { readFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { getDb, getImagesDir } from '../db/connection.js'
import { setIconUrl } from './sets.js'

/**
 * Card images are fetched once and kept on disk, then served over a custom
 * `matomeru://` protocol. Going through a protocol handler rather than `file://`
 * keeps the renderer's CSP tight and avoids exposing the filesystem to it.
 */

const PROTOCOL = 'matomeru'
const inFlight = new Map<string, Promise<string | null>>()

/** `large` is 672x936 — worth it for the detail view, wasteful for a grid tile. */
export type ImageSize = 'small' | 'normal' | 'large'

/**
 * Which side of the card. 0 is the front, and the only one that existed before.
 *
 * A `Cat // Dragon` token is one physical card with two usable faces, and Scryfall
 * puts a double-faced card's images *only* on `card_faces` -- so face 0 was being
 * shown for both sides and the back was unreachable.
 */
export type Face = 0 | 1

/**
 * Face 0 keeps its old filename, deliberately.
 *
 * Every image already on disk was written under the unsuffixed name, so adding the
 * face to it unconditionally would orphan the entire cache and re-download it.
 */
function imagePath(scryfallId: string, size: ImageSize, face: Face = 0): string {
  const suffix = face === 0 ? '' : `-face${face}`
  return join(getImagesDir(), `${scryfallId}-${size}${suffix}.jpg`)
}

/**
 * Only `small` and `normal` have their own columns. `large` is read out of the
 * stored Scryfall object instead, so no re-sync is needed to start using it —
 * with a `card_faces` fallback for double-faced cards, which carry their images
 * per face, and a final fall back to `normal` when neither is present.
 */
function remoteUrl(scryfallId: string, size: ImageSize, face: Face = 0): string | null {
  /*
    A back face is only ever in the stored Scryfall object -- the two columns hold
    one image each, and that one is the front. No re-sync is needed for this:
    `raw_json` has been kept whole all along.

    It falls back to the front rather than to nothing, so asking for a second face
    of a single-faced card gives the card instead of a broken image.
  */
  if (face !== 0) {
    const row = getDb().get(
      `SELECT COALESCE(
                json_extract(raw_json, '$.card_faces[${face}].image_uris.${size}'),
                json_extract(raw_json, '$.card_faces[0].image_uris.${size}'),
                json_extract(raw_json, '$.image_uris.${size}'),
                image_uri_normal
              ) AS uri
       FROM printings WHERE scryfall_id = ?`,
      [scryfallId]
    ) as { uri: string | null } | undefined
    return row?.uri ?? null
  }
  if (size === 'large') {
    const row = getDb().get(
      `SELECT COALESCE(
                json_extract(raw_json, '$.image_uris.large'),
                json_extract(raw_json, '$.card_faces[0].image_uris.large'),
                image_uri_normal
              ) AS uri
       FROM printings WHERE scryfall_id = ?`,
      [scryfallId]
    ) as { uri: string | null } | undefined
    return row?.uri ?? null
  }
  const column = size === 'small' ? 'image_uri_small' : 'image_uri_normal'
  const row = getDb().get(`SELECT ${column} AS uri FROM printings WHERE scryfall_id = ?`, [
    scryfallId
  ]) as { uri: string | null } | undefined
  return row?.uri ?? null
}

/**
 * Whether this printing has a second face with a picture of its own.
 *
 * Read from the stored object, so it costs one query and no request. The UI uses it
 * to decide whether a flip control belongs on the card at all -- offering one that
 * turns the card into a copy of itself would be worse than offering none.
 */
export function hasSecondFace(scryfallId: string): boolean {
  const row = getDb().get(
    `SELECT json_extract(raw_json, '$.card_faces[1].image_uris.normal') AS uri
       FROM printings WHERE scryfall_id = ?`,
    [scryfallId]
  ) as { uri: string | null } | undefined
  return typeof row?.uri === 'string' && row.uri.length > 0
}

async function download(
  scryfallId: string,
  size: ImageSize,
  face: Face = 0
): Promise<string | null> {
  const target = imagePath(scryfallId, size, face)
  if (existsSync(target)) return target

  const url = remoteUrl(scryfallId, size, face)
  if (!url) return null

  // Write to a temp name first so a killed download never leaves a truncated
  // file that later reads would treat as a valid cached image.
  const temp = `${target}.part`
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Matomeru/1.0 (local MTG collection manager)' }
    })
    if (!response.ok || !response.body) return null
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(temp))
    await rename(temp, target)
    return target
  } catch {
    await unlink(temp).catch(() => undefined)
    return null
  }
}

/**
 * Set symbols, cached the same way card images are.
 *
 * Keyed on the URL's own filename rather than the set code: Scryfall serves one
 * SVG for a set and its sub-sets, so 1047 sets share about 364 symbols, and
 * keying on the file means those are downloaded once between them.
 */
function iconPath(url: string): string {
  const file = new URL(url).pathname.split('/').pop() ?? 'set.svg'
  const safe = file.replace(/[^a-z0-9._-]/gi, '')
  return join(getImagesDir(), `set-${safe}`)
}

async function downloadIcon(code: string): Promise<string | null> {
  const url = await setIconUrl(code)
  if (!url) return null

  const target = iconPath(url)
  if (existsSync(target)) return target

  // Same temp-then-rename as the card images: a killed download must never leave
  // a truncated file that later reads treat as a valid symbol.
  const temp = `${target}.part`
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Matomeru/1.0 (local MTG collection manager)' }
    })
    if (!response.ok || !response.body) return null
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(temp))
    await rename(temp, target)
    return target
  } catch {
    await unlink(temp).catch(() => undefined)
    return null
  }
}

export function cachedSetIcon(code: string): Promise<string | null> {
  const key = `set:${code.toLowerCase()}`
  const existing = inFlight.get(key)
  if (existing) return existing
  const task = downloadIcon(code).finally(() => inFlight.delete(key))
  inFlight.set(key, task)
  return task
}

export function cachedImage(
  scryfallId: string,
  size: ImageSize,
  face: Face = 0
): Promise<string | null> {
  // The face is part of the key, or the front's download would be handed back for
  // the back and both faces would show the same picture.
  const key = `${scryfallId}:${size}:${face}`
  const existing = inFlight.get(key)
  if (existing) return existing
  const task = download(scryfallId, size, face).finally(() => inFlight.delete(key))
  inFlight.set(key, task)
  return task
}

/**
 * Registers `matomeru://image/{scryfallId}?size=small|normal[&face=1]` and
 * `matomeru://seticon/{setCode}`.
 *
 * `face` is absent for every URL the app built before double-faced cards could be
 * flipped, and absent means the front -- so no existing URL changes meaning.
 *
 * Must be called before any window loads. Missing images resolve to a 404 so
 * the renderer can fall back to a placeholder without an unhandled failure.
 */
export function registerImageProtocol(): void {
  protocol.handle(PROTOCOL, async (request) => {
    const url = new URL(request.url)

    // matomeru://seticon/{setCode} — the set's symbol, as SVG.
    if (url.hostname === 'seticon') {
      const code = url.pathname.replace(/^\/+/, '').toLowerCase()
      if (!/^[a-z0-9]{1,10}$/.test(code)) return new Response('Bad request', { status: 400 })
      const iconFile = await cachedSetIcon(code)
      if (!iconFile) return new Response('Not found', { status: 404 })
      try {
        const data = await readFile(iconFile)
        return new Response(data, {
          status: 200,
          headers: {
            'Content-Type': 'image/svg+xml',
            'Cache-Control': 'public, max-age=31536000'
          }
        })
      } catch {
        return new Response('Not found', { status: 404 })
      }
    }

    if (url.hostname !== 'image') {
      return new Response('Not found', { status: 404 })
    }
    const scryfallId = url.pathname.replace(/^\/+/, '')
    const requested = url.searchParams.get('size')
    const size: ImageSize =
      requested === 'large' ? 'large' : requested === 'normal' ? 'normal' : 'small'
    if (!/^[0-9a-f-]{10,}$/i.test(scryfallId)) {
      return new Response('Bad request', { status: 400 })
    }

    // Only two faces exist in Scryfall's data; anything else is the front.
    const face: Face = url.searchParams.get('face') === '1' ? 1 : 0

    const path = await cachedImage(scryfallId, size, face)
    if (!path) return new Response('Not found', { status: 404 })

    try {
      const data = await readFile(path)
      return new Response(data, {
        status: 200,
        headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=31536000' }
      })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}

/** Declares the scheme as privileged. Must run before `app.whenReady()`. */
export function registerImageScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PROTOCOL,
      privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: false }
    }
  ])
}
