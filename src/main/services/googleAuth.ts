/**
 * Getting and keeping permission to write one file to the user's Drive.
 *
 * One click, from the user's side: Settings offers "Connect with Google Drive", the
 * browser opens Google's consent page, they approve, and that is the whole flow.
 * There is nothing to paste, because the OAuth client is compiled into the build from
 * a gitignored `.env` — see BUNDLED below for what that means and does not mean. The
 * two fields in Settings remain as an override for a build with no client baked in.
 *
 * The only scope requested is `drive.file`, which Google limits to files this app
 * itself created or the user explicitly picked: Matomeru cannot see the rest of the
 * Drive, and that is enforced on Google's side rather than promised on ours.
 *
 * At rest, the client secret and the refresh token are encrypted with Electron's
 * `safeStorage` — DPAPI on Windows, so the ciphertext is bound to the OS user
 * account and a copied database file gives up nothing. Access tokens are never
 * written down at all; they live in a module variable and expire on their own.
 */
import { safeStorage, shell } from 'electron'
import { getRawSetting, setRawSetting } from '../db/repos/settings.js'
import { getLocale } from '../db/repos/settings.js'
import { t } from '@shared/i18n/index.js'
import type { TranslationKey } from '@shared/types'
import {
  callbackPage,
  consentUrl,
  type Credentials,
  parseCallback,
  pkcePair,
  randomState,
  refreshBody,
  resolveCredentials,
  TOKEN_ENDPOINT,
  tokenExchangeBody
} from './oauth.js'
import { loopbackOnce, whenListening } from './loopback.js'

function tr(key: TranslationKey, vars?: Record<string, string | number>): string {
  return t(getLocale(), key, vars)
}

const KEY_CLIENT_ID = 'backup.clientId'
const KEY_CLIENT_SECRET = 'backup.clientSecret'
const KEY_REFRESH = 'backup.refreshToken'

/** How long to wait for the user to finish in their browser. */
const CONSENT_TIMEOUT_MS = 3 * 60 * 1000

/**
 * Encryption is best-effort by design.
 *
 * `safeStorage` can be unavailable — a Linux session with no keyring, and any
 * environment where the OS refuses. Refusing to store the credential at all would
 * make the feature unusable there, so the value is marked with the scheme that
 * wrote it and read back the same way. A `plain:` row is a readable secret and that
 * is worth knowing; it is never the default on Windows, where DPAPI always answers.
 */
function seal(value: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    return `enc:${safeStorage.encryptString(value).toString('base64')}`
  }
  return `plain:${Buffer.from(value, 'utf8').toString('base64')}`
}

function unseal(stored: string | null): string | null {
  if (!stored) return null
  if (stored.startsWith('enc:')) {
    try {
      return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'))
    } catch {
      // A ciphertext this machine cannot decrypt is a credential from another
      // machine or another OS account. Treat it as absent rather than throwing on
      // every status read.
      return null
    }
  }
  if (stored.startsWith('plain:')) return Buffer.from(stored.slice(6), 'utf8').toString('utf8')
  return stored
}

/**
 * The OAuth client compiled into this build, from a gitignored `.env`.
 *
 * electron-vite exposes `MAIN_VITE_*` to the main process and inlines it at build
 * time, so these are literals in the bundle by the time it runs — which is also why
 * they are read once here rather than through a function: there is no environment to
 * read at runtime.
 *
 * A packaged app's asar is trivially extractable, so this secret is readable by
 * anyone holding the installer. That is the documented shape of Google's installed-app
 * flow, not a corner cut: the client secret of a desktop client is not treated as
 * confidential, and PKCE is what actually protects the exchange. The verifier is
 * generated per attempt and never leaves this process, so an intercepted redirect is
 * not redeemable by whoever intercepted it.
 */
const BUNDLED = {
  clientId: import.meta.env.MAIN_VITE_GOOGLE_CLIENT_ID ?? '',
  clientSecret: import.meta.env.MAIN_VITE_GOOGLE_CLIENT_SECRET ?? '',
  apiKey: import.meta.env.MAIN_VITE_GOOGLE_API_KEY ?? '',
  appId: import.meta.env.MAIN_VITE_GOOGLE_PROJECT_NUMBER ?? ''
}

/** True when this build carries its own client, so Settings can ask for nothing. */
export function hasBundledClient(): boolean {
  return BUNDLED.clientId !== '' && BUNDLED.clientSecret !== ''
}

/** What the Picker needs beyond a token. Empty when this build has no client. */
export function pickerConfig(): { apiKey: string; appId: string } {
  return { apiKey: BUNDLED.apiKey, appId: BUNDLED.appId }
}

export function getCredentials(): Credentials | null {
  return resolveCredentials(BUNDLED, {
    clientId: getRawSetting(KEY_CLIENT_ID) ?? '',
    clientSecret: unseal(getRawSetting(KEY_CLIENT_SECRET)) ?? ''
  })
}

export function setCredentials(clientId: string, clientSecret: string): void {
  setRawSetting(KEY_CLIENT_ID, clientId.trim() || null)
  setRawSetting(KEY_CLIENT_SECRET, clientSecret.trim() ? seal(clientSecret.trim()) : null)
}

export function isConfigured(): boolean {
  return getCredentials() !== null
}

export function hasRefreshToken(): boolean {
  return unseal(getRawSetting(KEY_REFRESH)) !== null
}

/** Forgets the token but keeps the credentials, so reconnecting is one click. */
export function disconnect(): void {
  setRawSetting(KEY_REFRESH, null)
  cached = null
}

let cached: { token: string; expiresAt: number } | null = null

/**
 * Walks the user through Google's consent screen and stores the refresh token.
 *
 * The redirect comes back to a loopback server on an ephemeral port. Google's
 * desktop-app clients accept any `127.0.0.1` port without it being registered in
 * advance, which is what lets this work with a client the user created minutes ago.
 * The out-of-band flow that used to serve this purpose was retired in 2022 and is
 * deliberately not used.
 */
export async function connect(): Promise<void> {
  const creds = getCredentials()
  if (!creds) throw new Error(tr('err.backupNotConfigured'))

  const { verifier, challenge } = pkcePair()
  const state = randomState()

  const loopback = loopbackOnce({
    callbackPath: '/',
    timeoutMs: CONSENT_TIMEOUT_MS,
    onTimeout: () => new Error(tr('err.backupAuthTimeout')),
    // Nothing else is served: a favicon request must not be mistaken for the reply.
    serve: () => null,
    done: (query) => {
      if (query.get('state') !== state) return callbackPage('Matomeru', tr('err.backupAuthState'))
      const error = query.get('error')
      if (error) return callbackPage('Matomeru', error)
      return callbackPage(tr('backup.browserDone'), tr('backup.browserDoneHint'))
    }
  })

  const redirectUri = await whenListening(loopback)
  void shell.openExternal(
    consentUrl({ clientId: creds.clientId, redirectUri, challenge, state })
  )

  const reply = parseCallback(`/?${(await loopback.landed).toString()}`)
  /*
    The state is checked here as well as in the page above, and it has to be: the page
    is what the user sees, this is what decides. A reply carrying someone else's state
    is not ours, whatever it looks like.
  */
  if (reply.state !== state) throw new Error(tr('err.backupAuthState'))
  if (reply.error || !reply.code) {
    throw new Error(tr('err.backupAuthDenied', { reason: reply.error ?? 'no code' }))
  }
  const code = reply.code

  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: tokenExchangeBody({
      code,
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      redirectUri,
      verifier
    })
  })
  const payload = (await response.json().catch(() => null)) as {
    refresh_token?: string
    access_token?: string
    expires_in?: number
    error?: string
    error_description?: string
  } | null

  if (!response.ok || !payload?.refresh_token) {
    throw new Error(
      tr('err.backupAuthDenied', {
        reason: payload?.error_description ?? payload?.error ?? String(response.status)
      })
    )
  }

  setRawSetting(KEY_REFRESH, seal(payload.refresh_token))
  if (payload.access_token && payload.expires_in) {
    cached = { token: payload.access_token, expiresAt: Date.now() + payload.expires_in * 1000 }
  }
}

/**
 * A usable access token, refreshed if the cached one is spent.
 *
 * Renewed a minute early, because a token that expires between this check and the
 * request that uses it produces a 401 in the middle of a 33 MB upload.
 */
export async function accessToken(): Promise<string> {
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token

  const creds = getCredentials()
  if (!creds) throw new Error(tr('err.backupNotConfigured'))
  const refreshToken = unseal(getRawSetting(KEY_REFRESH))
  if (!refreshToken) throw new Error(tr('err.backupNotConnected'))

  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: refreshBody({
      refreshToken,
      clientId: creds.clientId,
      clientSecret: creds.clientSecret
    })
  })
  const payload = (await response.json().catch(() => null)) as {
    access_token?: string
    expires_in?: number
    error?: string
  } | null

  if (!response.ok || !payload?.access_token) {
    /*
      `invalid_grant` means the token is gone for good — revoked in the Google
      account, or expired because the OAuth client is still in Testing, where
      refresh tokens last seven days. Clearing it is the honest response: the next
      status read then says "not connected" instead of failing forever against a
      credential that will never work again.
    */
    if (payload?.error === 'invalid_grant') {
      disconnect()
      throw new Error(tr('err.backupTokenRevoked'))
    }
    throw new Error(
      tr('err.backupDriveStatus', {
        status: response.status,
        message: payload?.error ?? 'token refresh failed'
      })
    )
  }

  cached = {
    token: payload.access_token,
    expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000
  }
  return cached.token
}
