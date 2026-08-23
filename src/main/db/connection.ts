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
    get: (sql, params) => raw.get(sql, params as never) as unknown,
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
 * Runs `fn` inside a transaction, rolling back on any throw. Not reentrant —
 * SQLite has no nested transactions, so never call this from inside itself.
 */
export function transaction<T>(fn: (db: Sql) => T): T {
  const db = getDb()
  db.run('BEGIN')
  try {
    const result = fn(db)
    db.run('COMMIT')
    return result
  } catch (err) {
    db.run('ROLLBACK')
    throw err
  }
}

export function closeDb(): void {
  if (handle) {
    handle.close()
    handle = null
    facade = null
  }
}

export function nowIso(): string {
  return new Date().toISOString()
}
