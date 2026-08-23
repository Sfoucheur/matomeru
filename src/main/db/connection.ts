import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
// node-sqlite3-wasm is CommonJS; the default import is the only form that works.
import sqlite3 from 'node-sqlite3-wasm'
import { MIGRATIONS } from './schema.js'

const { Database } = sqlite3

export type SqlValue = string | number | bigint | null | Uint8Array
export type SqlParams = SqlValue[]

/**
 * Thin typed facade over node-sqlite3-wasm.
 *
 * The driver's own result types are opaque unions, which makes every call site
 * need a double cast. Returning `unknown` here instead lets repos state the row
 * shape they expect with a single, readable `as` — the cast is doing real work
 * (declaring the SQL's result shape), not silencing the compiler.
 */
export interface Sql {
  run(sql: string, params?: SqlParams): void
  all(sql: string, params?: SqlParams): unknown[]
  get(sql: string, params?: SqlParams): unknown
  exec(sql: string): void
}

let handle: InstanceType<typeof Database> | null = null
let facade: Sql | null = null
let dataDir = ''

function wrap(raw: InstanceType<typeof Database>): Sql {
  return {
    run: (sql, params) => {
      raw.run(sql, params as never)
    },
    all: (sql, params) => raw.all(sql, params as never) as unknown[],
    /*
      Nothing found is `undefined`, not `null`.

      The driver returns null for an empty result, while every caller annotates the
      row as `| undefined` and tests it with `if (!row)` — which works for both, so
      the mismatch never showed. It is still a lie in the type, and it bites the
      moment anyone compares strictly; that is exactly the bug this normalisation
      was written after. One `??` here makes every one of those annotations true.
    */
    get: (sql, params) => (raw.get(sql, params as never) ?? undefined) as unknown,
    exec: (sql) => {
      raw.exec(sql)
    }
  }
}

/**
 * Sets where the database and image cache live. Called once at startup with
 * Electron's userData path, which resolves to the user's app-data folder and is
 * deliberately outside the application directory — so reinstalling or updating
 * the app never touches the collection.
 *
 * Injecting the path rather than importing `electron` here keeps the entire data
 * layer Electron-free, which is what lets it be exercised in a plain Node harness.
 */
export function setDataDir(dir: string): void {
  dataDir = dir
  mkdirSync(dataDir, { recursive: true })
}

export function getDataDir(): string {
  if (!dataDir) {
    throw new Error('Data directory not configured — call setDataDir() at startup.')
  }
  return dataDir
}

export function getImagesDir(): string {
  const dir = join(getDataDir(), 'images')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function getDb(): Sql {
  if (facade) return facade

  const file = join(getDataDir(), 'matomeru.db')
  handle = new Database(file)
  facade = wrap(handle)
  facade.run('PRAGMA journal_mode = WAL')
  facade.run('PRAGMA foreign_keys = ON')
  facade.run('PRAGMA synchronous = NORMAL')
  migrate(facade)
  return facade
}

function migrate(db: Sql): void {
  db.run(`CREATE TABLE IF NOT EXISTS schema_version (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`)

  const applied = new Set(
    (db.all('SELECT version FROM schema_version') as { version: number }[]).map((r) => r.version)
  )

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue
    db.run('BEGIN')
    try {
      db.exec(migration.sql)
      db.run('INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)', [
        migration.version,
        migration.name,
        new Date().toISOString()
      ])
      db.run('COMMIT')
      console.log(`[db] applied migration ${migration.version} (${migration.name})`)
    } catch (err) {
      db.run('ROLLBACK')
      throw new Error(
        `Migration ${migration.version} (${migration.name}) failed: ${(err as Error).message}`
      )
    }
  }
}

/**
 * How deep we are in nested `transaction()` calls.
 *
 * SQLite has no nested BEGIN — a second one is an error, not a nesting — so the
 * outermost call owns the transaction and inner ones use savepoints. This used to
 * be documented as "not reentrant, never call from inside itself", which held
 * only as long as no two operations ever needed composing. They do now: an undo
 * step wraps whatever action it is recording, and that action already runs in a
 * transaction of its own, as does validating a pick list, which calls into the
 * collection.
 */
let depth = 0

/**
 * Runs `fn` in a transaction, rolling back on any throw.
 *
 * Reentrant. The outermost call issues BEGIN and COMMIT; a nested call issues a
 * SAVEPOINT and releases it, so an inner failure unwinds only the inner work and
 * the outer call is still free to commit — or to rethrow and roll everything
 * back, which is what the callers here all do.
 */
export function transaction<T>(fn: (db: Sql) => T): T {
  const db = getDb()
  const nested = depth > 0
  const name = `sp${depth}`
  db.run(nested ? `SAVEPOINT ${name}` : 'BEGIN')
  depth += 1
  try {
    const result = fn(db)
    db.run(nested ? `RELEASE ${name}` : 'COMMIT')
    depth -= 1
    return result
  } catch (err) {
    // Decrement before unwinding so a throw from the rollback itself cannot
    // leave the depth permanently wrong and every later write unwrapped.
    depth -= 1
    db.run(nested ? `ROLLBACK TO ${name}` : 'ROLLBACK')
    if (nested) db.run(`RELEASE ${name}`)
    throw err
  }
}

export function closeDb(): void {
  if (handle) {
    handle.close()
    handle = null
    facade = null
  }
  /*
    Reset the nesting counter too. A closed database is not inside a transaction by
    definition, so leaving `depth` where it was would have the next `transaction()`
    open a SAVEPOINT against a connection that has no transaction to save a point
    in. Nothing did that before — `closeDb` was only ever called on quit — but a
    restore closes the database mid-session, which is exactly the case where a
    stale depth would matter.
  */
  depth = 0
}

export function nowIso(): string {
  return new Date().toISOString()
}
