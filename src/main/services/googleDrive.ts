/**
 * `RemoteStore` over the Google Drive REST API.
 *
 * One folder, one current snapshot, and up to `HISTORY_KEPT` previous ones beside
 * it. Everything this app can see in the Drive it created itself — that is what the
 * `drive.file` scope means — so the folder is found among files this client owns,
 * never by searching the user's Drive. That is also why the folder is *named* rather
 * than browsed to: the scope that keeps the rest of the Drive invisible is the same
 * scope that cannot list it.
 *
 * The manifest rides on the file as Drive `appProperties` rather than as a second
 * file. One metadata request then answers everything the dialog needs to say —
 * when, which machine, how big, and whether it matches what we hold — without
 * pulling 33 MB down to find out, and there is no sidecar that can drift out of
 * step with the snapshot it describes.
 */
import { createReadStream, createWriteStream, statSync } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { BackupManifest } from '@shared/types'
import type { TranslationKey } from '@shared/types'
import { t } from '@shared/i18n/index.js'
import { getLocale, getRawSetting, setRawSetting } from '../db/repos/settings.js'
import { accessToken } from './googleAuth.js'
import type { RemoteSnapshot, RemoteStore } from './backup.js'

function tr(key: TranslationKey, vars?: Record<string, string | number>): string {
  return t(getLocale(), key, vars)
}

/** Used when nothing has been set, and when a saved name is blanked out again. */
export const DEFAULT_FOLDER_NAME = 'Matomeru'
const CURRENT_NAME = 'matomeru.db.gz'
const FOLDER_MIME = 'application/vnd.google-apps.folder'
const API = 'https://www.googleapis.com/drive/v3'
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3'

const KEY_FOLDER_ID = 'backup.folderId'
const KEY_FOLDER_NAME = 'backup.folderName'

/**
 * The name of the folder backups go into.
 *
 * Read from settings without touching the network, so the dialog and the settings
 * panel can say where backups go even offline, or before the app has ever connected.
 */
export function folderName(): string {
  const stored = getRawSetting(KEY_FOLDER_NAME)?.trim()
  return stored && stored.length > 0 ? stored : DEFAULT_FOLDER_NAME
}

/**
 * Renames the target folder, and forgets the cached id.
 *
 * Dropping the id is the load-bearing half: it is the thing `ensureFolder` trusts, so
 * leaving it behind would have the next backup write into the *old* folder while the
 * screen showed the new name. Existing snapshots stay where they are — this points
 * future ones somewhere else, it does not move anything.
 */
export function setFolderName(name: string): string {
  const trimmed = name.trim()
  const next = trimmed.length > 0 ? trimmed : DEFAULT_FOLDER_NAME
  if (next !== folderName()) setRawSetting(KEY_FOLDER_ID, null)
  setRawSetting(KEY_FOLDER_NAME, next === DEFAULT_FOLDER_NAME ? null : next)
  return next
}

/**
 * 8 MB per chunk.
 *
 * Google requires every chunk but the last to be a multiple of 256 KB, and
 * recommends multiples of 8 MB for throughput. It also decides the progress
 * granularity the user sees: at this size a 33 MB database reports four times,
 * which is enough to look alive without a callback per packet.
 */
const CHUNK = 8 * 1024 * 1024

async function authorized(
  url: string,
  init: RequestInit = {}
): Promise<Response> {
  const token = await accessToken()
  const headers = new Headers(init.headers)
  headers.set('authorization', `Bearer ${token}`)
  return fetch(url, { ...init, headers })
}

async function fail(response: Response): Promise<never> {
  const body = (await response.json().catch(() => null)) as
    | { error?: { message?: string } }
    | null
  throw new Error(
    tr('err.backupDriveStatus', {
      status: response.status,
      message: body?.error?.message ?? response.statusText
    })
  )
}

/**
 * `appProperties` values are strings, so the manifest is flattened on the way out
 * and rebuilt on the way in. A property that fails to parse yields a null manifest
 * rather than a wrong one — a restore refuses without a manifest, which is the safe
 * direction.
 */
function toProperties(manifest: BackupManifest): Record<string, string> {
  return {
    snapshotAt: manifest.snapshotAt,
    schemaVersion: String(manifest.schemaVersion),
    appVersion: manifest.appVersion,
    sha256: manifest.sha256,
    bytes: String(manifest.bytes),
    uncompressedBytes: String(manifest.uncompressedBytes),
    machine: manifest.machine,
    cards: String(manifest.cards),
    decks: String(manifest.decks),
    pickLists: String(manifest.pickLists)
  }
}

function fromProperties(props: Record<string, string> | undefined): BackupManifest | null {
  if (!props?.sha256 || !props.snapshotAt) return null
  const number = (raw: string | undefined): number => {
    const value = Number(raw)
    return Number.isFinite(value) ? value : 0
  }
  return {
    snapshotAt: props.snapshotAt,
    schemaVersion: number(props.schemaVersion),
    appVersion: props.appVersion ?? 'unknown',
    sha256: props.sha256,
    bytes: number(props.bytes),
    /*
      Falls back to the compressed size when absent, which is what a backup written
      before compression existed looks like: for those the two really were the same
      number, so the fallback is the truth rather than a guess.
    */
    uncompressedBytes: number(props.uncompressedBytes) || number(props.bytes),
    machine: props.machine ?? 'unknown',
    cards: number(props.cards),
    decks: number(props.decks),
    pickLists: number(props.pickLists)
  }
}

interface DriveFile {
  id: string
  name: string
  size?: string
  modifiedTime?: string
  appProperties?: Record<string, string>
}

export function driveStore(): RemoteStore {
  let folderId: string | null = getRawSetting(KEY_FOLDER_ID)
  let currentId: string | null = null
  let currentIsCompressed = true

  /**
   * Where the snapshot goes: the folder the user picked, or one the app makes.
   *
   * The stored id is checked rather than trusted, because it can stop being usable
   * without anything telling us — a folder deleted in Drive, or one picked while
   * signed into a different account. Without the check that is a 404 on every save
   * forever; with it, the app falls back to its own folder and keeps working, and the
   * name shown in Settings changes, which is how the user finds out.
   *
   * `trashed = false` matters: a trashed folder is still a folder to Drive, and
   * uploading into the bin is a quiet way to lose a backup.
   */
  const ensureFolder = async (): Promise<string> => {
    if (folderId) {
      const check = await authorized(`${API}/files/${folderId}?fields=id,trashed,mimeType`)
      if (check.ok) {
        const file = (await check.json()) as { id: string; trashed?: boolean; mimeType?: string }
        if (!file.trashed && file.mimeType === FOLDER_MIME) return folderId
      }
      folderId = null
      setRawSetting(KEY_FOLDER_ID, null)
    }

    /*
      Single quotes inside the name would end the query string and change what it
      matches, so they are doubled as Drive's query syntax requires. A folder called
      "Seb's cards" is an ordinary thing to want.
    */
    const wanted = folderName().replace(/'/g, "\\'")
    const query = encodeURIComponent(
      `name = '${wanted}' and mimeType = '${FOLDER_MIME}' and trashed = false`
    )
    const found = await authorized(`${API}/files?q=${query}&fields=files(id)&pageSize=1`)
    if (!found.ok) await fail(found)
    const list = (await found.json()) as { files: DriveFile[] }
    if (list.files[0]) {
      folderId = list.files[0].id
      setRawSetting(KEY_FOLDER_ID, folderId)
      return folderId
    }

    const created = await authorized(`${API}/files?fields=id`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: folderName(), mimeType: FOLDER_MIME })
    })
    if (!created.ok) await fail(created)
    folderId = ((await created.json()) as { id: string }).id
    setRawSetting(KEY_FOLDER_ID, folderId)
    return folderId
  }

  const listFolder = async (): Promise<DriveFile[]> => {
    const parent = await ensureFolder()
    const query = encodeURIComponent(`'${parent}' in parents and trashed = false`)
    const response = await authorized(
      `${API}/files?q=${query}&fields=files(id,name,size,modifiedTime,appProperties)` +
        '&orderBy=name&pageSize=100'
    )
    if (!response.ok) await fail(response)
    return ((await response.json()) as { files: DriveFile[] }).files
  }

  const findCurrent = async (): Promise<DriveFile | null> => {
    const files = await listFolder()
    // The compressed name first, then the old uncompressed one, so a Drive holding
    // both prefers the format this version writes.
    const current =
      files.find((file) => file.name === CURRENT_NAME) ??
      files.find((file) => file.name === 'matomeru.db') ??
      null
    currentId = current?.id ?? null
    currentIsCompressed = current === null ? true : current.name.endsWith('.gz')
    return current
  }

  /**
   * Resumable upload, in chunks.
   *
   * Not the simple upload: Google caps that at 5 MB and this database is already
   * six times that. Resumable also means a dropped connection loses one chunk
   * rather than the whole transfer, and it is the only shape that can report
   * progress at all.
   */
  const upload = async (
    path: string,
    manifest: BackupManifest,
    onProgress: (sent: number, total: number) => void
  ): Promise<void> => {
    const parent = await ensureFolder()
    const total = statSync(path).size
    const existing = currentId ?? (await findCurrent())?.id ?? null

    const metadata = existing
      ? { appProperties: toProperties(manifest) }
      : { name: CURRENT_NAME, parents: [parent], appProperties: toProperties(manifest) }

    const start = await authorized(
      existing
        ? `${UPLOAD}/files/${existing}?uploadType=resumable`
        : `${UPLOAD}/files?uploadType=resumable`,
      {
        method: existing ? 'PATCH' : 'POST',
        headers: {
          'content-type': 'application/json',
          'x-upload-content-type': 'application/gzip',
          'x-upload-content-length': String(total)
        },
        body: JSON.stringify(metadata)
      }
    )
    if (!start.ok) await fail(start)
    const session = start.headers.get('location')
    if (!session) throw new Error(tr('err.backupDriveStatus', { status: 200, message: 'no session' }))

    let sent = 0
    while (sent < total) {
      const end = Math.min(sent + CHUNK, total)
      const chunk = await readChunk(path, sent, end - 1)
      const response = await fetch(session, {
        method: 'PUT',
        headers: {
          'content-length': String(chunk.byteLength),
          'content-range': `bytes ${sent}-${end - 1}/${total}`
        },
        body: chunk
      })

      // 308 is "chunk accepted, send the next one" — the expected answer for every
      // chunk but the last, and not an error however much it looks like one.
      if (response.status === 308) {
        sent = end
        onProgress(sent, total)
        continue
      }
      if (response.ok) {
        const file = (await response.json()) as { id: string }
        currentId = file.id
        onProgress(total, total)
        return
      }
      await fail(response)
    }
  }

  return {
    label: () => folderName(),

    /*
      Whatever is actually up there. A backup written before compression existed has a
      name without the suffix, and must still restore — so this is read off the file,
      not assumed from the current version's habits.
    */
    isCompressed: () => currentIsCompressed,


    stat: async (): Promise<RemoteSnapshot | null> => {
      const current = await findCurrent()
      if (!current) return null
      return {
        bytes: Number(current.size ?? 0),
        manifest: fromProperties(current.appProperties)
      }
    },

    put: async (path, manifest, onProgress) => {
      // The outgoing snapshot replaces the current file, so what is there now is
      // copied aside first — under the timestamp of the snapshot it actually is,
      // not of the moment it was demoted.
      const current = await findCurrent()
      if (current) {
        const previous = fromProperties(current.appProperties)
        const suffix = (previous?.snapshotAt ?? current.modifiedTime ?? '')
          .replace(/[-:]/g, '')
          .replace(/\.\d+Z$/, 'Z')
        const parent = await ensureFolder()
        const copied = await authorized(`${API}/files/${current.id}/copy?fields=id`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: `matomeru-${suffix || 'previous'}.db.gz`,
            parents: [parent],
            appProperties: current.appProperties ?? {}
          })
        })
        if (!copied.ok) await fail(copied)
      }
      await upload(path, manifest, onProgress)
    },

    get: async (target, onProgress) => {
      const current = await findCurrent()
      if (!current) throw new Error(tr('err.backupNothingRemote'))
      const total = Number(current.size ?? 0)
      const response = await authorized(`${API}/files/${current.id}?alt=media`)
      if (!response.ok) await fail(response)
      if (!response.body) throw new Error(tr('err.backupDriveStatus', { status: 200, message: 'no body' }))

      let read = 0
      const counted = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          read += chunk.byteLength
          onProgress(read, total)
          controller.enqueue(chunk)
        }
      })
      // Straight to disk. Buffering 33 MB in memory first would work and would also
      // mean a failed download had already cost the memory of a successful one.
      await pipeline(
        Readable.fromWeb(response.body.pipeThrough(counted) as Parameters<typeof Readable.fromWeb>[0]),
        createWriteStream(target)
      )
    },

    rotate: async (keep) => {
      const files = await listFolder()
      const history = files
        .filter((file) => file.name.startsWith('matomeru-') && file.name.includes('.db'))
        .sort((a, b) => b.name.localeCompare(a.name))
      const doomed = history.slice(keep)
      for (const file of doomed) {
        const response = await authorized(`${API}/files/${file.id}`, { method: 'DELETE' })
        if (!response.ok && response.status !== 404) await fail(response)
      }
      return doomed.length
    }
  }
}

/** One slice of a file, as bytes, without holding the whole file in memory. */
function readChunk(path: string, start: number, end: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = []
    const stream = createReadStream(path, { start, end })
    stream.on('data', (part) => parts.push(part as Buffer))
    stream.on('error', reject)
    stream.on('end', () => resolve(new Uint8Array(Buffer.concat(parts))))
  })
}
