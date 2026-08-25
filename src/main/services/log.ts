/**
 * Somewhere for errors to go.
 *
 * Until this existed the app recorded nothing. Every failure the UI ever showed was
 * caught by the IPC wrapper, turned into a message, and forgotten — which is why the
 * updater's `TypeError` had to be retyped out of a screenshot before anyone could look
 * at it. A packaged Electron app on Windows has no console to print to, so "add a
 * console.log" was never going to be the answer.
 *
 * No logging dependency. `fs` is enough for one line at a time, and this project keeps
 * three runtime dependencies on purpose.
 *
 * Errors and a few key events are always written; `--debug` adds volume. A switch you
 * have to remember does not help, because by the time you know you want logs the thing
 * you wanted them for has already happened.
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { getDataDir } from '../db/connection.js'

export type LogLevel = 'error' | 'warn' | 'info' | 'debug'

/**
 * One megabyte, then a single rollover.
 *
 * Two files is the whole footprint. A log that grows without bound on someone's machine
 * is a bug of its own, and a rotation scheme with more than one generation is more
 * machinery than a desktop app needs to explain a crash.
 */
const MAX_BYTES = 1024 * 1024

let verbose = false

/**
 * Flag names that must never be used for this, because something else claims them.
 *
 * `--debug` was the obvious choice and it is unusable: Node intercepts it before any of
 * this app's code runs and Electron refuses to start at all —
 * `[DEP0062]: node --debug and node --debug-brk are invalid`. A debug switch that
 * prevents the app from launching is worse than none, and the mistake is invisible until
 * you actually try it, so the name is pinned here with a check to match.
 */
export const RESERVED_FLAGS = ['--debug', '--debug-brk', '--inspect', '--inspect-brk']

/** What turns verbose logging on. `--debug-mode` is accepted because it is what people type. */
export const DEBUG_FLAGS = ['--verbose', '--debug-mode']

export function parseDebugFlag(argv: readonly string[]): boolean {
  return argv.some((arg) => DEBUG_FLAGS.includes(arg))
}

/** Turned on by `--verbose`. Read at startup, before anything worth logging happens. */
export function setVerboseLogging(on: boolean): void {
  verbose = on
}

export function isVerboseLogging(): boolean {
  return verbose
}

export function logDir(): string {
  return join(getDataDir(), 'logs')
}

export function logFile(): string {
  return join(logDir(), 'main.log')
}

/**
 * Strips anything that must not survive into a file someone will paste into an issue.
 *
 * The whole point of these logs is to be shared, which makes a leaked token the failure
 * mode that matters most — so this is part of the writer rather than a rule to remember
 * at each call site. The patterns cover what this app actually holds: sealed settings
 * values, a Google client secret, Google's own token shapes, and any Authorization
 * header that finds its way into an error message.
 */
export function redact(text: string): string {
  return text
    .replace(/\b(enc|plain):[A-Za-z0-9+/=]{8,}/g, '$1:[redacted]')
    .replace(/GOCSPX-[A-Za-z0-9_-]+/g, '[redacted client secret]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
    .replace(/\bya29\.[A-Za-z0-9._-]+/g, '[redacted access token]')
    .replace(/\b1\/\/[A-Za-z0-9._-]{10,}/g, '[redacted refresh token]')
}

function rollIfNeeded(file: string): void {
  try {
    if (!existsSync(file) || statSync(file).size < MAX_BYTES) return
    const old = `${file}.old`
    if (existsSync(old)) rmSync(old, { force: true })
    renameSync(file, old)
  } catch {
    /* a log that cannot rotate must not stop the app */
  }
}

function write(level: LogLevel, scope: string, message: string): void {
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${redact(message)}`

  // The console too, because `npm run dev` has a terminal watching it and that is the
  // fastest way to see something while working.
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)

  try {
    /*
      `getDataDir()` throws until startup has configured it, and something may want to
      log before then. Console-only is the right fallback: losing one early line is
      better than a logger that can crash the app it is meant to explain.
    */
    const dir = logDir()
    mkdirSync(dir, { recursive: true })
    const file = logFile()
    rollIfNeeded(file)
    appendFileSync(file, `${line}\n`, 'utf8')
  } catch {
    /* no data directory yet, or a read-only disk — the console line already went out */
  }
}

/** Detail from a thrown value, without assuming it is an Error. */
function describe(detail: unknown): string {
  if (detail === undefined) return ''
  if (detail instanceof Error) {
    return ` :: ${detail.message}${detail.stack ? `\n${detail.stack}` : ''}`
  }
  if (typeof detail === 'string') return ` :: ${detail}`
  try {
    return ` :: ${JSON.stringify(detail)}`
  } catch {
    return ' :: [unserialisable]'
  }
}

export function logError(scope: string, message: string, detail?: unknown): void {
  write('error', scope, `${message}${describe(detail)}`)
}

export function logWarn(scope: string, message: string, detail?: unknown): void {
  write('warn', scope, `${message}${describe(detail)}`)
}

export function logInfo(scope: string, message: string, detail?: unknown): void {
  write('info', scope, `${message}${describe(detail)}`)
}

/** Only written under `--debug`, so an ordinary run stays quiet. */
export function logDebug(scope: string, message: string, detail?: unknown): void {
  if (!verbose) return
  write('debug', scope, `${message}${describe(detail)}`)
}
