import { CloudDownload, RefreshCw } from 'lucide-react'
import type { UpdateState } from '@shared/types'
import { useT } from '../hooks/useT'
import { guard, useApp } from '../store/app'
import { Button, Modal } from './primitives'

/**
 * What a waiting update looks like when nobody went looking for it.
 *
 * The check at launch used to write its result into main-process memory and stop, so an
 * update announced itself to nobody: the Settings panel only read the state when it
 * mounted, and nothing else in the app mentioned updates at all. This is the other half
 * of that fix — the state is pushed now, and this is what it gets pushed into.
 *
 * It reappears on every launch while an update is pending. Dismissing it is "not now",
 * not "stop telling me", and the dot on the Settings entry stays either way.
 */
export default function UpdateDialog({
  state,
  onClose
}: {
  state: UpdateState
  onClose: () => void
}): React.ReactElement | null {
  const t = useT()
  const available = state.available
  if (available === null) return null

  const download = async (): Promise<void> => {
    // Not closed on click: the progress bar reports the download, and the dialog is
    // where "Restart and install" will appear when it finishes.
    await guard(() => window.api.updates.download())
  }

  const install = async (): Promise<void> => {
    await guard(() => window.api.updates.install())
  }

  return (
    <Modal open onClose={onClose} title={t('updates.dialogTitle')} width="max-w-lg">
      <div className="px-5 py-4" data-dialog="update">
        <p className="text-sm text-ink-100">
          {t('updates.dialogBody', { version: available.version, current: state.current })}
        </p>

        {available.notes.trim().length > 0 && (
          <>
            <p className="mt-4 text-[10px] font-semibold uppercase tracking-wider text-ink-500">
              {t('updates.notes')}
            </p>
            {/*
              The notes come from a release body, which is Markdown we deliberately do not
              render: pulling in a Markdown parser to show a bullet list would be a
              dependency for decoration, and raw HTML from a release body is not something
              to inject. Pre-wrapped monospace is honest about what it is.
            */}
            <pre
              className="mt-1.5 max-h-56 overflow-y-auto whitespace-pre-wrap rounded-lg border
                border-ink-700 bg-ink-800 p-3 font-sans text-[11px] leading-relaxed text-ink-300"
              data-field="releaseNotes"
            >
              {available.notes.trim()}
            </pre>
          </>
        )}

        {state.error !== null && (
          <p className="mt-3 rounded-lg border border-bad/40 bg-bad/10 p-2.5 text-[11px]
            leading-relaxed text-bad">
            {state.error}
          </p>
        )}

        <div className="mt-4 flex items-center justify-end gap-2">
          <Button size="sm" onClick={onClose} data-action="updateLater">
            {t('updates.later')}
          </Button>

          {/* One action at a time: fetch it, then restart into it. */}
          {state.downloaded ? (
            <Button
              variant="primary"
              size="sm"
              icon={<RefreshCw size={13} />}
              onClick={() => void install()}
              data-action="updateInstall"
            >
              {t('updates.install')}
            </Button>
          ) : (
            <Button
              variant="primary"
              size="sm"
              icon={<CloudDownload size={13} />}
              disabled={state.downloading || state.mode !== 'auto'}
              onClick={() => void download()}
              data-action="updateDownload"
            >
              {state.downloading ? t('updates.downloading') : t('updates.download')}
            </Button>
          )}
        </div>

        {/* A portable build cannot replace itself, so the dialog says what it can do. */}
        {state.mode === 'notify' && (
          <p className="mt-3 text-[11px] leading-relaxed text-ink-500">
            {t('updates.portable')}{' '}
            <button
              onClick={() => void guard(() => window.api.updates.openRelease())}
              className="text-gold-400 underline decoration-gold-400/40 underline-offset-2"
              data-action="updateOpenRelease"
            >
              {t('updates.openPage')}
            </button>
          </p>
        )}
      </div>
    </Modal>
  )
}

/** The dot on the Settings entry. Small on purpose: present, not shouting. */
export function UpdateDot(): React.ReactElement | null {
  const update = useApp((s) => s.updateState)
  if (update?.available === null || update === null) return null
  return (
    <span
      className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-gold-400"
      data-field="updateDot"
      aria-hidden="true"
    />
  )
}
