import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, CloudUpload, Download, Settings } from 'lucide-react'
import type { BackupStatus } from '@shared/types'
import { useT } from '../hooks/useT'
import { guard, useApp } from '../store/app'
import { Button, Modal } from './primitives'
import { count, megabytes, relativeTime } from '../lib/format'

/**
 * What Ctrl+S opens: this machine beside Drive, and a confirm.
 *
 * Nothing is sent by pressing the shortcut. The dialog exists because a backup is
 * two facts the user needs before deciding — what is here, and what is already up
 * there — and because the one case that can lose data, a remote written by another
 * machine, is only visible once both are on screen together.
 *
 * Restore lives here too rather than on its own shortcut. It is the same pair of
 * facts read in the other direction, and putting it behind its own key would make a
 * destructive action as reachable as a safe one.
 */
export default function BackupDialog({
  initialMode,
  onClose
}: {
  /** Which side to open on: Ctrl+S arrives on 'save', Settings' Restore on 'restore'. */
  initialMode: 'save' | 'restore'
  onClose: () => void
}): React.ReactElement {
  const t = useT()
  const toast = useApp((s) => s.toast)
  const setView = useApp((s) => s.setView)

  const [status, setStatus] = useState<BackupStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [mode, setMode] = useState<'save' | 'restore'>(initialMode)
  /*
    Two separate acknowledgements, because they are two different admissions: one
    that a restore discards what is here, one that a save discards what is there.
    Sharing a single checkbox would let a tick meant for one authorise the other.
  */
  const [ackRestore, setAckRestore] = useState(false)
  const [ackClobber, setAckClobber] = useState(false)

  const read = useCallback(async () => {
    const next = await guard(() => window.api.backup.status())
    if (next) setStatus(next)
  }, [])

  useEffect(() => {
    void read()
  }, [read])

  const save = async (): Promise<void> => {
    setBusy(true)
    const result = await guard(() => window.api.backup.save(ackClobber))
    setBusy(false)
    if (!result) return
    if (result.uploaded) {
      toast('success', t('backup.saved', {
        size: megabytes(result.bytes),
        label: status?.label ?? 'Drive'
      }))
    } else {
      toast('info', t('backup.nothingSent'))
    }
    onClose()
  }

  const restore = async (): Promise<void> => {
    setBusy(true)
    const result = await guard(() => window.api.backup.restore())
    setBusy(false)
    if (!result) return
    // The app is restarting, so this is the last thing said. It names the count from
    // the manifest rather than a bare "done", because the number is how the user
    // recognises which backup they just took.
    toast('success', t('backup.restored', { cards: count(result.manifest.cards) }))
  }

  const remote = status?.remote ?? null
  const ready = status?.connected === true

  return (
    <Modal
      open
      onClose={onClose}
      title={mode === 'save' ? t('backup.title') : t('backup.restoreTitle')}
      width="max-w-md"
    >
      <div className="px-5 py-4" data-dialog="backup">
        {status === null ? (
          <div className="space-y-2">
            <p className="text-[11px] text-ink-500">{t('backup.checking')}</p>
            <div className="skeleton h-14 rounded-lg" />
            <div className="skeleton h-14 rounded-lg" />
          </div>
        ) : !status.configured ? (
          <Unavailable
            title={t('backup.notConfigured')}
            hint={t('backup.notConfiguredHint')}
            action={t('backup.openSettings')}
            onAction={() => {
              setView('settings')
              onClose()
            }}
          />
        ) : !status.connected ? (
          <Unavailable
            title={t('backup.notConnected')}
            hint={t('backup.notConnectedHint')}
            action={t('backup.openSettings')}
            onAction={() => {
              setView('settings')
              onClose()
            }}
          />
        ) : (
          <>
            {/* The two sides, in the order the action reads: from here, to there. */}
            <div className="mb-3 grid gap-2">
              <Side
                label={t('backup.local')}
                when={
                  status.lastBackupAt
                    ? relativeTime(status.lastBackupAt)
                    : t('backup.never')
                }
                detail={null}
              />
              <Side
                label={t('backup.remote')}
                when={
                  remote
                    ? t('backup.written', {
                        when: relativeTime(remote.snapshotAt),
                        machine: remote.machine
                      })
                    : t('backup.never')
                }
                detail={
                  remote
                    ? `${megabytes(remote.bytes)} · ${t('backup.counts', {
                        cards: count(remote.cards),
                        decks: count(remote.decks),
                        lists: count(remote.pickLists)
                      })}`
                    : null
                }
              />
            </div>

            {status.error !== null && (
              <p className="mb-3 rounded-lg border border-bad/40 bg-bad/10 p-2.5 text-[11px]
                leading-relaxed text-bad">
                {status.error}
              </p>
            )}

            {mode === 'save' && status.upToDate && (
              <p
                className="mb-3 rounded-lg border border-ink-700 bg-ink-800 p-2.5 text-[11px]
                  leading-relaxed text-ink-400"
                data-field="upToDate"
              >
                <span className="font-semibold text-ink-200">{t('backup.upToDate')}</span>{' '}
                {t('backup.upToDateHint')}
              </p>
            )}

            {mode === 'save' && status.remoteIsNewer && remote && (
              <label
                className="mb-3 flex items-start gap-2.5 rounded-lg border border-warn/40
                  bg-warn/10 p-3"
                data-field="ackClobber"
              >
                <input
                  type="checkbox"
                  checked={ackClobber}
                  onChange={(e) => setAckClobber(e.target.checked)}
                  className="mt-0.5 shrink-0 accent-gold-500"
                />
                <span className="text-sm text-ink-100">
                  <span className="flex items-center gap-1.5 font-semibold">
                    <AlertTriangle size={12} className="text-warn" />
                    {t('backup.conflict')}
                  </span>
                  <span className="mt-1 block text-[11px] leading-relaxed text-ink-400">
                    {t('backup.conflictHint', {
                      machine: remote.machine,
                      when: relativeTime(remote.snapshotAt)
                    })}
                  </span>
                  <span className="mt-1.5 block text-[11px] text-ink-200">
                    {t('backup.conflictAck')}
                  </span>
                </span>
              </label>
            )}

            {mode === 'restore' && (
              <>
                <p className="mb-3 text-[11px] leading-relaxed text-ink-400">
                  {t('backup.restoreHint')}
                </p>
                <label
                  className="mb-4 flex items-start gap-2.5 rounded-lg border border-bad/40
                    bg-bad/10 p-3"
                  data-field="ackRestore"
                >
                  <input
                    type="checkbox"
                    checked={ackRestore}
                    onChange={(e) => setAckRestore(e.target.checked)}
                    className="mt-0.5 shrink-0 accent-gold-500"
                  />
                  <span className="text-sm text-ink-100">{t('backup.restoreAck')}</span>
                </label>
              </>
            )}

            <div className="flex items-center justify-between gap-2">
              {/* The other direction, as a quiet link rather than a second button:
                  it is reached deliberately, not by aiming slightly wrong. */}
              <button
                onClick={() => setMode(mode === 'save' ? 'restore' : 'save')}
                className="text-[11px] text-ink-400 underline decoration-ink-600
                  underline-offset-2 transition-colors hover:text-ink-200"
                data-action="toggleBackupMode"
              >
                {mode === 'save' ? t('backup.restoreInstead') : t('backup.title')}
              </button>

              <div className="flex gap-2">
                <Button size="sm" onClick={onClose} disabled={busy}>
                  {t('common.cancel')}
                </Button>
                {mode === 'save' ? (
                  <Button
                    variant="primary"
                    size="sm"
                    icon={<CloudUpload size={13} />}
                    disabled={!ready || busy || (status.remoteIsNewer && !ackClobber)}
                    onClick={() => void save()}
                    data-action="confirmBackup"
                  >
                    {t('backup.save')}
                  </Button>
                ) : (
                  <Button
                    variant="danger"
                    size="sm"
                    icon={<Download size={13} />}
                    disabled={!ready || busy || !ackRestore || remote === null}
                    onClick={() => void restore()}
                    data-action="confirmRestore"
                  >
                    {t('backup.restoreConfirm')}
                  </Button>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}

function Side({
  label,
  when,
  detail
}: {
  label: string
  when: string
  detail: string | null
}): React.ReactElement {
  return (
    <div className="rounded-lg border border-ink-700 bg-ink-800 px-3 py-2.5">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-500">{label}</p>
      <p className="mt-0.5 text-sm text-ink-100">{when}</p>
      {detail !== null && <p className="numeric mt-0.5 text-[11px] text-ink-500">{detail}</p>}
    </div>
  )
}

/** Shown when there is nothing to confirm yet, with the way to fix that. */
function Unavailable({
  title,
  hint,
  action,
  onAction
}: {
  title: string
  hint: string
  action: string
  onAction: () => void
}): React.ReactElement {
  return (
    <div data-field="unavailable">
      <p className="text-sm font-semibold text-ink-100">{title}</p>
      <p className="mt-1 text-[11px] leading-relaxed text-ink-400">{hint}</p>
      <div className="mt-4 flex justify-end">
        <Button
          variant="primary"
          size="sm"
          icon={<Settings size={13} />}
          onClick={onAction}
          data-action="backupOpenSettings"
        >
          {action}
        </Button>
      </div>
    </div>
  )
}
