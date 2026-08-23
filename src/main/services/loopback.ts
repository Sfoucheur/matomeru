/**
 * A loopback server that serves a page or two and then goes away.
 *
 * Two flows need one: the OAuth redirect has to come back somewhere, and Google's
 * Picker refuses to run on a `file://` origin, so its page has to be served over
 * http even though it is entirely local. They were the same twenty lines twice, and
 * the half that is easy to get wrong is the lifetime — a listener left behind when
 * the user closes the browser tab, or a second request arriving after the first was
 * answered and resolving the promise again.
 *
 * Transport only. What counts as success, and what the pages say, belongs to the
 * caller: this module has no idea what OAuth or the Picker are, which is what makes
 * it testable without either.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface Loopback {
  /** Where the browser should go: `http://127.0.0.1:<port>`. */
  origin: string
  /** The query of the first request to `callbackPath`. Rejects on timeout. */
  landed: Promise<URLSearchParams>
  /** Shuts the server down early. Safe to call twice, and after it has landed. */
  stop: () => void
}

export function loopbackOnce(options: {
  /** The one path that ends the wait. Everything else is served by `serve`. */
  callbackPath: string
  timeoutMs: number
  /** The error to reject with when nobody ever arrives. */
  onTimeout: () => Error
  /** HTML for any other path. Null means 204, which is the right answer to a favicon. */
  serve: (path: string) => string | null
  /** HTML for the callback request itself, given its query. */
  done: (query: URLSearchParams) => string
}): Loopback {
  let server: Server
  let settled = false
  let timer: NodeJS.Timeout

  const stop = (): void => {
    clearTimeout(timer)
    // `close` on an already-closed server throws ERR_SERVER_NOT_RUNNING, and this is
    // deliberately safe to call from a caller that does not track whether it landed.
    try {
      server.close()
    } catch {
      /* already closed */
    }
  }

  const landed = new Promise<URLSearchParams>((resolve, reject) => {
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      stop()
      fn()
    }

    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== options.callbackPath) {
        const page = options.serve(url.pathname)
        if (page === null) {
          res.writeHead(204).end()
          return
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(page)
        return
      }

      /*
        The callback. Answered before the promise resolves, so the browser always
        gets its page: resolving first lets the caller close the window, and the
        request would then be cut off mid-response.
      */
      const query = url.searchParams
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(options.done(query))
      finish(() => resolve(query))
    })

    server.on('error', (err) => finish(() => reject(err)))
    timer = setTimeout(() => finish(() => reject(options.onTimeout())), options.timeoutMs)
    server.listen(0, '127.0.0.1')
  })

  // `listen` is asynchronous, so the port is not known yet. Every caller opens a
  // browser rather than connecting itself, and that cannot happen until the address
  // is up — so the origin is read lazily, once, off the live server.
  return {
    get origin(): string {
      const address = server.address() as AddressInfo | null
      if (!address) throw new Error('loopback server is not listening yet')
      return `http://127.0.0.1:${address.port}`
    },
    landed,
    stop
  }
}

/** Resolves once the server is listening, so `origin` can be read. */
export function whenListening(loopback: Loopback): Promise<string> {
  return new Promise((resolve, reject) => {
    const attempt = (left: number): void => {
      try {
        resolve(loopback.origin)
      } catch (err) {
        if (left === 0) {
          reject(err as Error)
          return
        }
        setImmediate(() => attempt(left - 1))
      }
    }
    attempt(50)
  })
}
