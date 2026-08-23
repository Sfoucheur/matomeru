/**
 * Snapshotting the database, and putting a snapshot back.
 *
 * Everything here is filesystem and SQLite. There is no Electron import and no
 * network call: the remote is injected as a `RemoteStore`, the same way `csv.ts`
 * takes a `ProgressSink` instead of reaching for `BrowserWindow`. That is what lets
 * `scripts/verify.ts` drive the whole save/restore path — including the refusals,
 * which are the part that can lose data — against an in-memory fake, in plain Node,
 * with no credentials and no Drive.
 */
import { createHash } from 'node:crypto'
import { createGzip, createGunzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { createWriteStream } from 'node:fs'
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync
} from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import sqlite3 from 'node-sqlite3-wasm'
import type {
  BackupManifest,
  BackupResult,
  ProgressEvent,
  RestoreResult,
  TranslationKey
} from '@shared/types'
import { closeDb, getDataDir, getDb, nowIso } from '../db/connection.js'
import { MIGRATIONS } from '../db/schema.js'
import { getLocale } from '../db/repos/settings.js'
import { t } from '@shared/i18n/index.js'

const { Database } = sqlite3

export type ProgressSink = (event: ProgressEvent) => void

/**
 * The app's version, injected at startup so this module needs no `app` import.
 *
 * Only used to stamp the manifest — a restore refuses on schema version, never on
 * this, because two builds can share a schema.
 */
let APP_VERSION = '0.0.0'
export function setAppVersion(version: string): void {
  APP_VERSION = version
}

/** How many previous snapshots the remote keeps. */
export const HISTORY_KEPT = 5

/** How many pre-restore copies of the local database are kept on this machine. */
const SAFETY_COPIES_KEPT = 3

/** Localised message, resolved at throw time from the stored locale. */
function tr(key: TranslationKey, vars?: Record<string, string | number>): string {
  return t(getLocale(), key, vars)
}

/** What the remote holds, without downloading it. */
export interface RemoteSnapshot {
  bytes: number
  /** Null when a snapshot is there but carries no manifest — written by something else. */
  manifest: BackupManifest | null
}

/**
 * The remote, reduced to what a backup needs.
 *
 * Four operations, all of them about one file. Keeping the interface this narrow is
 * what makes the Drive implementation swappable — and, more usefully today, what
 * makes a fake one small enough that the tests exercise the real logic rather than a
 * reimplementation of it.
 */
export interface RemoteStore {
  /** What is up there now, or null if nothing has ever been written. */
  stat(): Promise<RemoteSnapshot | null>
  /** Replaces the remote snapshot with the file at `path`, stamping `manifest` on it. */
  put(
    path: string,
    manifest: BackupManifest,
    onProgress: (sentBytes: number, totalBytes: number) => void
  ): Promise<void>
  /** Writes the remote snapshot to `target`. */
  get(target: string, onProgress: (readBytes: number, totalBytes: number) => void): Promise<void>
  /** Keeps the newest `keep` previous snapshots, deleting older ones. Returns how many went. */
  rotate(keep: number): Promise<number>
  /** Where the snapshot lives, for messages. Never a credential. */
  label(): string
  /**
   * Whether the file up there is gzipped.
   *
   * Asked rather than assumed, because a backup taken before compression existed is
   * still a valid backup and must still restore.
   */
  isCompressed(): boolean
}

export function schemaVersion(): number {
  return MIGRATIONS.reduce((highest, m) => Math.max(highest, m.version), 0)
}

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

function tempDir(): string {
  const dir = join(getDataDir(), 'backup-tmp')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** ISO time flattened into something that sorts and is legal in a filename. */
function stamp(at: string): string {
  return at.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
}

/**
 * A consistent copy of the live database, taken while the app is running.
 *
 * `VACUUM INTO` rather than a file copy. Copying the file byte for byte is only
 * safe when nothing is mid-write, and nothing here can promise that — a background
 * price refresh is a write. VACUUM INTO asks SQLite for the copy, so it is the
 * committed state of the database by construction, whatever the journal mode
 * happens to be, and it arrives defragmented as a bonus.
 */
export async function snapshot(): Promise<{ path: string; manifest: BackupManifest; bytes: number }> {
  const db = getDb()
  const path = join(tempDir(), 'snapshot.db')
  // A leftover from a killed run would make VACUUM INTO fail: it refuses to write
  // over an existing file, deliberately, and that refusal is not ours to inherit.
  if (existsSync(path)) unlinkSync(path)

  db.run('VACUUM INTO ?', [path])

  const at = nowIso()
  const bytes = statSync(path).size
  const counts = countsOf(path)
  return {
    path,
    bytes,
    manifest: {
      snapshotAt: at,
      schemaVersion: schemaVersion(),
      appVersion: APP_VERSION,
      // Filled in by the caller once the file is compressed: the hash has to describe
      // the bytes that travel, or it cannot verify a download.
      sha256: '',
      bytes: 0,
      uncompressedBytes: bytes,
      machine: hostname(),
      ...counts
    }
  }
}

/**
 * gzip, into a sibling file.
 *
 * A card database is mostly repetitive text, so this is the difference between moving
 * tens of megabytes on every save and moving a handful. gzip rather than a zip
 * container because `zlib` is built into Node — no dependency for a project that has
 * two — and Windows unpacks `.gz` without help.
 */
export async function compress(path: string): Promise<{ path: string; bytes: number }> {
  const target = `${path}.gz`
  if (existsSync(target)) unlinkSync(target)
  await pipeline(createReadStream(path), createGzip(), createWriteStream(target))
  return { path: target, bytes: statSync(target).size }
}

/** The other direction, for a restore. */
export async function decompress(source: string, target: string): Promise<void> {
  if (existsSync(target)) unlinkSync(target)
  await pipeline(createReadStream(source), createGunzip(), createWriteStream(target))
}

/**
 * Opens a snapshot file on its own and asks SQLite whether it is intact.
 *
 * Run against every snapshot written and every snapshot downloaded. A hash proves
 * the bytes survived the trip; only SQLite can say the bytes are a database.
 */
export function verifySnapshot(path: string): { ok: true } | { ok: false; reason: string } {
  let probe: InstanceType<typeof Database> | null = null
  try {
    probe = new Database(path)
    const row = probe.get('PRAGMA integrity_check') as { integrity_check?: string } | null
    const verdict = row?.integrity_check ?? 'no answer'
    if (verdict !== 'ok') return { ok: false, reason: verdict }
    const applied = probe.get(
      'SELECT COALESCE(MAX(version), 0) AS version FROM schema_version'
    ) as { version: number } | null
    if (!applied) return { ok: false, reason: 'no schema_version table' }
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: (err as Error).message }
  } finally {
    probe?.close()
  }
}

function countsOf(path: string): { cards: number; decks: number; pickLists: number } {
  let probe: InstanceType<typeof Database> | null = null
  try {
    probe = new Database(path)
    const one = (sql: string): number =>
      ((probe as InstanceType<typeof Database>).get(sql) as { n: number } | null)?.n ?? 0
    return {
      cards: one('SELECT COALESCE(SUM(quantity), 0) AS n FROM collection_items'),
      decks: one('SELECT COUNT(*) AS n FROM decks'),
      pickLists: one('SELECT COUNT(*) AS n FROM pick_lists')
    }
  } catch {
    return { cards: 0, decks: 0, pickLists: 0 }
  } finally {
    probe?.close()
  }
}

function schemaVersionOf(path: string): number {
  let probe: InstanceType<typeof Database> | null = null
  try {
    probe = new Database(path)
    const row = probe.get('SELECT COALESCE(MAX(version), 0) AS version FROM schema_version') as
      | { version: number }
      | null
    return row?.version ?? 0
  } catch {
    return 0
  } finally {
    probe?.close()
  }
}

/**
 * Whether the database has been written since the given moment.
 *
 * The file's mtime, and deliberately not a hash of a fresh snapshot. Hashing looks
 * like the rigorous answer and is in fact the wrong one: `VACUUM INTO` writes a
 * different file every time it runs, even from a database whose contents have not
 * changed by a byte — three consecutive snapshots of one unchanged database produce
 * three different digests, because the header advances with each generation. A hash
 * comparison would therefore report "changed" almost always, and the skip it was
 * meant to enable would never happen.
 *
 * mtime answers the question actually being asked — has anything written to this
 * database — and when it is wrong it is wrong safely: a write that changed nothing
 * costs one unnecessary upload, never a skipped one.
 *
 * The manifest's sha256 keeps its real job, which is proving a *download* is the
 * same bytes that were uploaded. For that, identical file, identical hash, always.
 */
export function localTouchedSince(iso: string | null): boolean {
  if (!iso) return true
  const file = join(getDataDir(), 'matomeru.db')
  if (!existsSync(file)) return true
  return statSync(file).mtime.toISOString() > iso
}

/**
 * Snapshot and upload, unless nothing has been written since the last time.
 *
 * Reflexively hitting Ctrl+S is the normal case, and sending 33 MB to say nothing
 * changed is a cost with no benefit.
 */
export async function saveToRemote(
  store: RemoteStore,
  onProgress: ProgressSink,
  /** When this machine last uploaded, so an untouched database can be skipped. */
  lastBackupAt: string | null = null
): Promise<BackupResult> {
  const emit = (phase: string, done: number, total: number, extra?: Partial<ProgressEvent>): void =>
    onProgress({ job: 'backup', phase, done, total, ...extra })

  /*
    Checked before the snapshot is taken, not after. A snapshot is a full copy of the
    database; taking one only to discover it was not needed is the expensive half of
    the work done for nothing.
  */
  const existing = await store.stat()
  if (existing?.manifest && !localTouchedSince(lastBackupAt)) {
    emit('Done', 1, 1, { finished: true })
    return {
      uploaded: false,
      bytes: existing.bytes,
      uncompressedBytes: existing.manifest.uncompressedBytes,
      at: existing.manifest.snapshotAt,
      pruned: 0
    }
  }

  emit('Snapshotting', 0, 4)
  const { path, manifest, bytes } = await snapshot()
  let packed: string | null = null

  try {
    emit('Verifying', 1, 4)
    const intact = verifySnapshot(path)
    if (!intact.ok) throw new Error(tr('err.backupSnapshotBad', { reason: intact.reason }))

    emit('Compressing', 2, 4)
    const gz = await compress(path)
    packed = gz.path
    /*
      The hash describes the compressed file, because that is what gets uploaded and
      what a download has to be checked against. The database inside is verified
      separately, by SQLite, after a restore decompresses it — two checks with two
      different jobs.
    */
    const stamped: BackupManifest = {
      ...manifest,
      sha256: await sha256File(gz.path),
      bytes: gz.bytes
    }

    emit('Uploading', 3, 4, { message: `0 / ${Math.round(gz.bytes / 1_048_576)} MB` })
    await store.put(gz.path, stamped, (sent, total) => {
      emit('Uploading', 3, 4, {
        message: `${Math.round(sent / 1_048_576)} / ${Math.round(total / 1_048_576)} MB`
      })
    })

    const pruned = await store.rotate(HISTORY_KEPT)
    emit('Done', 4, 4, { finished: true })
    return {
      uploaded: true,
      bytes: gz.bytes,
      uncompressedBytes: bytes,
      at: stamped.snapshotAt,
      pruned
    }
  } catch (err) {
    emit('Failed', 4, 4, { finished: true, error: (err as Error).message })
    throw err
  } finally {
    if (existsSync(path)) unlinkSync(path)
    if (packed !== null && existsSync(packed)) unlinkSync(packed)
  }
}

/**
 * Brings the remote snapshot down and puts it in place of the local database.
 *
 * Order is the whole design: every check that can refuse runs before the local file
 * is touched. A restore that fails halfway is the one outcome worse than no backup
 * at all, so the download, the hash, the integrity check and the schema check all
 * happen against a temporary file, and the local database is only moved aside once
 * there is a verified replacement standing ready.
 *
 * The caller relaunches the app. This closes the database and leaves it closed —
 * reopening it here would race whatever the renderer does next.
 */
export async function restoreFromRemote(
  store: RemoteStore,
  onProgress: ProgressSink
): Promise<RestoreResult> {
  const emit = (phase: string, done: number, total: number, extra?: Partial<ProgressEvent>): void =>
    onProgress({ job: 'backup', phase, done, total, ...extra })

  const remote = await store.stat()
  if (!remote) throw new Error(tr('err.backupNothingRemote'))
  const manifest = remote.manifest
  if (!manifest) throw new Error(tr('err.backupNoManifest'))

  // Refused before a single byte is downloaded: migrations only run forward, so a
  // snapshot from a newer build is one this app cannot read and must not adopt.
  const local = schemaVersion()
  if (manifest.schemaVersion > local) {
    throw new Error(
      tr('err.backupNewerSchema', { remote: manifest.schemaVersion, local })
    )
  }

  const compressed = store.isCompressed()
  const staged = join(tempDir(), compressed ? 'restore.db.gz' : 'restore.db')
  if (existsSync(staged)) unlinkSync(staged)

  try {
    emit('Downloading', 0, 3, { message: `0 / ${Math.round(remote.bytes / 1_048_576)} MB` })
    await store.get(staged, (read, total) => {
      emit('Downloading', 0, 3, {
        message: `${Math.round(read / 1_048_576)} / ${Math.round(total / 1_048_576)} MB`
      })
    })

    emit('Verifying', 1, 3)
    const digest = await sha256File(staged)
    if (digest !== manifest.sha256) {
      throw new Error(tr('err.backupHashMismatch'))
    }

    /*
      Unpacked only after the checksum passes, and into a second file.

      A backup written before compression existed has no `.gz` on its name, and is
      used as it is — an old backup should not become unreadable because the format
      moved on. `gunzip` on a plain database would fail with a stream error, which is
      why the branch exists rather than a try-and-see.
    */
    let usable = staged
    if (compressed) {
      usable = join(tempDir(), 'restore-unpacked.db')
      try {
        await decompress(staged, usable)
      } catch (err) {
        throw new Error(tr('err.backupCorrupt', { reason: (err as Error).message }))
      }
    }

    const intact = verifySnapshot(usable)
    if (!intact.ok) throw new Error(tr('err.backupCorrupt', { reason: intact.reason }))
    // Belt and braces: the manifest is metadata anyone could have written, so the
    // schema check is repeated against the file that actually arrived.
    const arrived = schemaVersionOf(usable)
    if (arrived > local) {
      throw new Error(tr('err.backupNewerSchema', { remote: arrived, local }))
    }

    emit('Replacing', 2, 3)
    const safetyCopy = keepSafetyCopy()

    // From here on the database must not be open. Closing also resets the
    // transaction depth, so nothing can believe it is still inside a savepoint.
    closeDb()
    const live = join(getDataDir(), 'matomeru.db')
    if (existsSync(live)) unlinkSync(live)
    renameSync(usable, live)
    if (usable !== staged && existsSync(staged)) unlinkSync(staged)

    emit('Done', 3, 3, { finished: true })
    return { bytes: remote.bytes, safetyCopy, manifest }
  } catch (err) {
    emit('Failed', 3, 3, { finished: true, error: (err as Error).message })
    if (existsSync(staged)) unlinkSync(staged)
    throw err
  }
}

/**
 * A copy of the local database, kept next to it, before anything replaces it.
 *
 * Restoring the wrong snapshot is an ordinary mistake and this is what makes it a
 * recoverable one. Copied rather than moved, so a failure between here and the
 * rename leaves the original exactly where it was.
 */
export function keepSafetyCopy(): string {
  const dir = getDataDir()
  const live = join(dir, 'matomeru.db')
  const target = join(dir, `before-restore-${stamp(nowIso())}.db`)
  copyFileSync(live, target)

  const older = readdirSync(dir)
    .filter((name) => name.startsWith('before-restore-') && name.endsWith('.db'))
    .sort()
    .reverse()
    .slice(SAFETY_COPIES_KEPT)
  for (const name of older) rmSync(join(dir, name), { force: true })

  return target
}
