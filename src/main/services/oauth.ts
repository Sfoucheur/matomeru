/**
 * The parts of the OAuth dance that are pure functions.
 *
 * Split out from `googleAuth.ts` on purpose: that module needs Electron for
 * `safeStorage` and `shell`, which makes it unreachable from `scripts/verify.ts`.
 * The pieces most worth testing — that a PKCE challenge really is the hash of its
 * verifier, that the consent URL asks for offline access and nothing broader than
 * `drive.file` — are exactly the pieces that need no Electron at all.
 */
import { createHash, randomBytes } from 'node:crypto'

/** The one scope this app asks for: files it created itself, and nothing else. */
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'

export const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
export const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'

/** Base64url, as every OAuth spec means it: no padding, URL-safe alphabet. */
function base64url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export interface Credentials {
  clientId: string
  clientSecret: string
}

export interface Pkce {
  verifier: string
  challenge: string
}

/**
 * A verifier and its S256 challenge.
 *
 * PKCE matters here even though the flow also sends a client secret: a desktop
 * client's secret is in the binary or, in this app's case, pasted into settings, so
 * it is not a secret in the sense the word usually carries. The verifier never
 * leaves this process until the code is exchanged, which is what actually stops an
 * intercepted redirect being redeemable.
 */
export function pkcePair(): Pkce {
  const verifier = base64url(randomBytes(32))
  return {
    verifier,
    challenge: base64url(createHash('sha256').update(verifier).digest())
  }
}

export function randomState(): string {
  return base64url(randomBytes(16))
}

export function consentUrl(params: {
  clientId: string
  redirectUri: string
  challenge: string
  state: string
}): string {
  const query = new URLSearchParams({
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    response_type: 'code',
    scope: DRIVE_SCOPE,
    /*
      `offline` is what returns a refresh token, and `consent` is what makes Google
      return one *again* on a repeat authorisation. Without the second, a user who
      reconnects gets an access token only, and the connection dies in an hour with
      nothing to renew it.
    */
    access_type: 'offline',
    prompt: 'consent',
    code_challenge: params.challenge,
    code_challenge_method: 'S256',
    state: params.state
  })
  return `${AUTH_ENDPOINT}?${query.toString()}`
}

export interface CallbackResult {
  code: string | null
  state: string | null
  error: string | null
}

/** Reads the query Google appends to the loopback redirect. */
export function parseCallback(url: string): CallbackResult {
  // The request URL arrives path-relative, so it needs a base to parse against.
  const parsed = new URL(url, 'http://127.0.0.1')
  return {
    code: parsed.searchParams.get('code'),
    state: parsed.searchParams.get('state'),
    error: parsed.searchParams.get('error')
  }
}

export function tokenExchangeBody(params: {
  code: string
  clientId: string
  clientSecret: string
  redirectUri: string
  verifier: string
}): string {
  return new URLSearchParams({
    code: params.code,
    client_id: params.clientId,
    client_secret: params.clientSecret,
    redirect_uri: params.redirectUri,
    grant_type: 'authorization_code',
    code_verifier: params.verifier
  }).toString()
}

export function refreshBody(params: {
  refreshToken: string
  clientId: string
  clientSecret: string
}): string {
  return new URLSearchParams({
    refresh_token: params.refreshToken,
    client_id: params.clientId,
    client_secret: params.clientSecret,
    grant_type: 'refresh_token'
  }).toString()
}

/**
 * What the browser shows once Google has redirected back.
 *
 * Deliberately a dead end with no styling to load and no script: the loopback
 * server closes moments later, so anything it referenced would 404 in front of the
 * user.
 */
export function callbackPage(heading: string, body: string): string {
  const escape = (text: string): string =>
    text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Matomeru</title></head>
<body style="font-family: system-ui, sans-serif; background:#0b0d12; color:#e8e8ea;
             display:grid; place-items:center; height:100vh; margin:0">
  <div style="text-align:center; max-width:28rem; padding:2rem">
    <h1 style="font-size:1.1rem; margin:0 0 .5rem">${escape(heading)}</h1>
    <p style="font-size:.85rem; color:#9b9ba3; margin:0">${escape(body)}</p>
  </div>
</body></html>`
}
