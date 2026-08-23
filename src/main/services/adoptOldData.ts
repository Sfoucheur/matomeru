import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Carries the collection over from the app's former name.
 *
 * Electron derives `userData` from the package name, so renaming BulkOS to
 * Matomeru moved the data folder from `%APPDATA%\bulkos` to `%APPDATA%\matomeru`
 * — which would have silently orphaned a real collection: the database plus a
 * card-image cache several times its size.
 *
 * Runs once, before the database is opened, and is a no-op every time after. The
 * guard is the point: it only ever moves *into* an empty destination, so it can
 * never overwrite a database that already exists. If the move fails — a locked
 * file, a different volume — it gives up quietly and the app starts fresh rather
 * than refusing to launch, because a failed migration of a cache is not worth a
 * dead app.
 *
 * Deliberately not a database migration: at this point there is no database to
 * migrate, and the thing being moved is a file on disk.
 */
export function adoptOldData(newDir: string, log: (message: string) => void = () => {}): void {
  const oldDir = join(dirname(newDir), 'bulkos')
  if (oldDir === newDir) return

  const newDb = join(newDir, 'matomeru.db')
  const oldDb = join(oldDir, 'bulkos.db')

  // Anything already here wins, always.
  if (existsSync(newDb) || !existsSync(oldDb)) return

  try {
    mkdirSync(newDir, { recursive: true })
    renameSync(oldDb, newDb)
    log(`adopted the collection from ${oldDir}`)
  } catch (err) {
    log(`could not adopt ${oldDb}: ${(err as Error).message}`)
    return
  }

  // The image cache is worth far more bytes than the database and costs nothing
  // to bring along, but losing it only means re-downloading art — so a failure
  // here must not undo the database move above.
  const oldImages = join(oldDir, 'images')
  const newImages = join(newDir, 'images')
  if (existsSync(oldImages) && !existsSync(newImages)) {
    try {
      renameSync(oldImages, newImages)
      log('adopted the card-image cache too')
    } catch (err) {
      log(`left the image cache behind: ${(err as Error).message}`)
    }
  }
}
