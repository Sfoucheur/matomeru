import { transaction, type Sql, type SqlValue } from './connection.js'
import { t } from '@shared/i18n/index'
import { getLocale } from './repos/settings.js'
import type { TranslationKey, UndoState } from '@shared/types'

/**
 * Undo and redo for everything you change locally.
 *
 * The mechanism is a **row-level before/after journal**, not hand-written inverse
 * SQL. Each undoable action declares which rows it might touch; this captures
 * those rows before and after it runs, and undo restores the earlier image.
 * Insert, update and delete then collapse into one case — "make these rows look
 * like this again" — so there is no per-action inverse to keep in step with the
 * action, which is the usual way an undo feature rots.
 *
 * The cost of that generality is that a **scope has to be stated correctly**. It
 * must cover every row the action can touch, and it must be expressed on a key
 * that a freshly inserted row already satisfies — `collection_items` scoped on
 * its UNIQUE (scryfall_id, finish, condition), not on an id that does not exist
 * yet. A scope that is too narrow silently loses part of the change. That is the
 * failure mode the property test in scripts/verify.ts exists to catch: it runs
 * every action, undoes it, and compares a fingerprint of the whole database
 * against what it was before.
 *
 * The history is **session-only**, by choice: it lives here in memory and starts
 * empty on each launch, like an editor's undo stack, so nothing accumulates in
 * the database and no stale step can outlive the state it was recorded against.
 *
 * Syncs are deliberately **not** undoable. A deck sync rewrites every row of a
 * deck and a price refresh rewrites every price; both refetch from the network
 * and can simply be run again. A sync also *clears* the stack, because it can
 * move rows out from under a pending step's before-image.
 */

export interface UndoScope {
  /** Table the action touches. */
  table: string
  /** WHERE clause selecting every row it might touch, before or after. */
  where: string
  params: SqlValue[]
}

type RowImage = Record<string, SqlValue>

interface TableImage {
  rows: RowImage[]
}

interface Step {
  label: TranslationKey
  scopes: UndoScope[]
  /** Primary-key columns per scope, in the same order. */
  keys: string[][]
  before: TableImage[]
  after: TableImage[]
}

/**
 * How many steps back you can go.
 *
 * Deep enough that the limit is never what stops you in practice, shallow enough
 * that the images cannot grow without bound in a long session.
 */
const MAX_STEPS = 50

const undoStack: Step[] = []
const redoStack: Step[] = []

const keyCache = new Map<string, string[]>()

/**
 * The primary-key columns of a table, read from SQLite rather than hardcoded.
 *
 * Restoring needs to know what makes a row *that* row, and a table can have a
 * composite key — `deck_card_overrides` is (deck_id, oracle_id). Asking the
 * database means a schema change cannot leave a stale map behind.
 */
function keyColumns(db: Sql, table: string): string[] {
  const cached = keyCache.get(table)
  if (cached) return cached
  const columns = db.all(`PRAGMA table_info(${table})`) as { name: string; pk: number }[]
  const keys = columns
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name)
  if (keys.length === 0) {
    // Refuse rather than guess. Without a key, restoring could not tell an
    // updated row from a new one, and would quietly duplicate rows instead.
    throw new Error(`undo: ${table} has no primary key, so its rows cannot be restored`)
  }
  keyCache.set(table, keys)
  return keys
}

function snapshot(db: Sql, scopes: UndoScope[]): TableImage[] {
  return scopes.map((scope) => ({
    rows: db.all(`SELECT * FROM ${scope.table} WHERE ${scope.where}`, scope.params) as RowImage[]
  }))
}

const identity = (row: RowImage, keys: string[]): string =>
  JSON.stringify(keys.map((k) => row[k]))

/**
 * Makes the rows in scope look exactly like the given image again.
 *
 * Deletes run first and in reverse scope order, upserts second and in forward
 * order, so a child row is never left pointing at a parent that has gone and a
 * parent is always back before its children need it. Foreign keys are ON in this
 * database, so that ordering is load-bearing rather than tidiness.
 *
 * Rows are restored with `ON CONFLICT DO UPDATE`, never `INSERT OR REPLACE`:
 * REPLACE deletes the existing row first, which fires ON DELETE CASCADE and
 * would take a pick list's items with it while restoring the list.
 */
function restore(db: Sql, step: Step, images: TableImage[]): void {
  /*
    Foreign keys are checked at COMMIT rather than per statement, for the duration
    of this transaction only.

    Restoring a snapshot is inherently a sequence of intermediate states that do
    not satisfy the constraints on their own: `pick_list_items` references
    `collection_items`, so re-inserting a pick item names a row that has not been
    restored yet. Ordering parents before children fixes the common case and the
    scopes are ordered that way, but it cannot fix every case — `setPrinting`
    legitimately passes two scopes over the *same* table, and one of them can
    remove a row the other is about to restore. Deferring means the only state that
    has to be consistent is the finished one, which is exactly the state that was
    captured.

    Without this, every undo of a validated pick list failed outright with
    "FOREIGN KEY constraint failed".
  */
  db.run('PRAGMA defer_foreign_keys = ON')

  for (let index = step.scopes.length - 1; index >= 0; index -= 1) {
    const scope = step.scopes[index]
    const keys = step.keys[index]
    const wanted = new Set(images[index].rows.map((row) => identity(row, keys)))
    const present = db.all(
      `SELECT * FROM ${scope.table} WHERE ${scope.where}`,
      scope.params
    ) as RowImage[]
    for (const row of present) {
      if (wanted.has(identity(row, keys))) continue
      db.run(
        `DELETE FROM ${scope.table} WHERE ${keys.map((k) => `${k} = ?`).join(' AND ')}`,
        keys.map((k) => row[k])
      )
    }
  }

  for (let index = 0; index < step.scopes.length; index += 1) {
    const scope = step.scopes[index]
    const keys = step.keys[index]
    for (const row of images[index].rows) {
      const columns = Object.keys(row)
      const assignable = columns.filter((c) => !keys.includes(c))
      const setClause = assignable.length
        ? assignable.map((c) => `${c} = excluded.${c}`).join(', ')
        : // A table whose every column is part of the key has nothing to update;
          // the row either exists identically or does not exist.
          `${keys[0]} = excluded.${keys[0]}`
      db.run(
        `INSERT INTO ${scope.table} (${columns.join(', ')})
         VALUES (${columns.map(() => '?').join(', ')})
         ON CONFLICT(${keys.join(', ')}) DO UPDATE SET ${setClause}`,
        columns.map((c) => row[c])
      )
    }
  }
}

/**
 * Runs an action and records how to undo it.
 *
 * One call is one step on the stack, which is why this wraps at the IPC boundary
 * rather than inside the repositories: one thing the user did should be one
 * Ctrl+Z, and repository functions call each other (validating a pick list adds
 * to the collection), so wrapping them individually would record a step per
 * internal call.
 */
export function undoable<T>(label: TranslationKey, scopes: UndoScope[], fn: () => T): T {
  return transaction((db) => {
    const keys = scopes.map((scope) => keyColumns(db, scope.table))
    const before = snapshot(db, scopes)
    const result = fn()
    const after = snapshot(db, scopes)

    undoStack.push({ label, scopes, keys, before, after })
    if (undoStack.length > MAX_STEPS) undoStack.shift()
    // A new action makes any redo branch unreachable, exactly as in an editor.
    redoStack.length = 0
    return result
  })
}

/**
 * The same, for an action that has to await something.
 *
 * Two short transactions rather than one long one: several actions here do a
 * Scryfall lookup before writing, and holding a write transaction open across a
 * network round trip would block every other write for as long as the network
 * takes. The images are captured either side instead.
 *
 * The gap between them is safe because this is a single-process desktop app with
 * one writer — the renderer cannot reach the database except through these
 * handlers, and they run one at a time.
 */
export async function undoableAsync<T>(
  label: TranslationKey,
  scopes: UndoScope[],
  fn: () => Promise<T>
): Promise<T> {
  const keys = transaction((db) => scopes.map((scope) => keyColumns(db, scope.table)))
  const before = transaction((db) => snapshot(db, scopes))
  const result = await fn()
  const after = transaction((db) => snapshot(db, scopes))

  undoStack.push({ label, scopes, keys, before, after })
  if (undoStack.length > MAX_STEPS) undoStack.shift()
  redoStack.length = 0
  return result
}

/** Steps back one action. Returns what was undone, or null if there was nothing. */
export function undo(): { label: string } | null {
  const step = undoStack.pop()
  if (!step) return null
  transaction((db) => restore(db, step, step.before))
  redoStack.push(step)
  return { label: t(getLocale(), step.label) }
}

/** Steps forward again. */
export function redo(): { label: string } | null {
  const step = redoStack.pop()
  if (!step) return null
  transaction((db) => restore(db, step, step.after))
  undoStack.push(step)
  return { label: t(getLocale(), step.label) }
}

export function undoState(): UndoState {
  const locale = getLocale()
  const next = undoStack[undoStack.length - 1]
  const forward = redoStack[redoStack.length - 1]
  return {
    canUndo: !!next,
    canRedo: !!forward,
    undoLabel: next ? t(locale, next.label) : null,
    redoLabel: forward ? t(locale, forward.label) : null
  }
}

/**
 * Throws the history away.
 *
 * Called after a sync, which rewrites whole tables: a step recorded before it
 * describes rows that may no longer exist, and restoring that image could
 * resurrect deck rows the sync had removed. Losing the ability to undo edits
 * made before a sync is a small price for never applying a step to state it was
 * not recorded against.
 */
export function clearUndoHistory(): void {
  undoStack.length = 0
  redoStack.length = 0
}

/** Test seam: how deep the stacks are, so the property test can assert on them. */
export function undoDepth(): { undo: number; redo: number } {
  return { undo: undoStack.length, redo: redoStack.length }
}

/** Scope helper: the whole of one table, for actions that can touch any row. */
export function wholeTable(table: string): UndoScope {
  return { table, where: '1 = 1', params: [] }
}

/** Scope helper for a row addressed by its own id. */
export function byId(table: string, id: number): UndoScope {
  return { table, where: 'id = ?', params: [id] }
}

/** Scope helper for several rows addressed by id. */
export function byIds(table: string, ids: number[]): UndoScope {
  // An empty list must select nothing rather than everything.
  if (ids.length === 0) return { table, where: '1 = 0', params: [] }
  return { table, where: `id IN (${ids.map(() => '?').join(', ')})`, params: ids }
}
