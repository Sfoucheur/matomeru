import type { ProgressEvent } from '@shared/types'

export type ProgressSink = (event: ProgressEvent) => void

/**
 * Coalesces a burst of progress events down to roughly one send per interval.
 *
 * A job that reports per card used to mean one IPC message per card — 135 of them
 * for a single language apply, each waking the renderer to redraw a progress bar
 * nobody can read that fast. The first event of a job and its terminal
 * `finished` event always go through immediately, so the bar appears at once and
 * always ends on the true final counts; everything between is thinned.
 *
 * Keyed per job, so a slow job cannot starve another job's first or last event.
 * Electron-free by design, which is what lets `verify` exercise it in plain Node.
 */
export function createThrottledBroadcaster(send: ProgressSink, intervalMs = 120): ProgressSink {
  interface JobState {
    timer: ReturnType<typeof setTimeout> | null
    pending: ProgressEvent | null
    lastSentAt: number
  }
  const jobs = new Map<string, JobState>()

  return (event: ProgressEvent): void => {
    let state = jobs.get(event.job)
    if (!state) {
      state = { timer: null, pending: null, lastSentAt: 0 }
      jobs.set(event.job, state)
    }

    const flush = (next: ProgressEvent): void => {
      state!.pending = null
      state!.lastSentAt = Date.now()
      send(next)
    }

    // Never delay the first event of a job, nor the one carrying final counts.
    if (state.lastSentAt === 0 || event.finished) {
      if (state.timer) {
        clearTimeout(state.timer)
        state.timer = null
      }
      flush(event)
      if (event.finished) jobs.delete(event.job)
      return
    }

    // Otherwise keep only the newest event and let the timer release it.
    state.pending = event
    if (state.timer) return
    const wait = Math.max(0, intervalMs - (Date.now() - state.lastSentAt))
    state.timer = setTimeout(() => {
      const current = jobs.get(event.job)
      if (!current) return
      current.timer = null
      if (current.pending) flush(current.pending)
    }, wait)
  }
}
