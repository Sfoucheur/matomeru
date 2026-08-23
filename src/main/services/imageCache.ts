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

function imagePath(scryfallId: string, size: ImageSize): string {
  return join(getImagesDir(), `${scryfallId}-${size}.jpg`)
}

/**
 * Only `small` and `normal` have their own columns. `large` is read out of the
 * stored Scryfall object instead, so no re-sync is needed to start using it —
 * with a `card_faces` fallback for double-faced cards, which carry their images
 * per face, and a final fall back to `normal` when neither is present.
 */
function remoteUrl(scryfallId: string, size: ImageSize): string | null {
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

async function download(scryfallId: string, size: ImageSize): Promise<string | null> {
  const target = imagePath(scryfallId, size)
  if (existsSync(target)) return target

  const url = remoteUrl(scryfallId, size)
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

export function cachedImage(scryfallId: string, size: ImageSize): Promise<string | null> {
  const key = `${scryfallId}:${size}`
  const existing = inFlight.get(key)
  if (existing) return existing
  const task = download(scryfallId, size).finally(() => inFlight.delete(key))
  inFlight.set(key, task)
  return task
}

/**
 * Registers `matomeru://image/{scryfallId}?size=small|normal` and
 * `matomeru://seticon/{setCode}`.
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

    const path = await cachedImage(scryfallId, size)
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
