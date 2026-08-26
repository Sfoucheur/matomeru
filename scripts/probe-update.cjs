/**
 * The update flow, end to end, in the running app.
 *
 *   npm run build
 *   npx electron . --user-data-dir=/tmp/probe --remote-debugging-port=9334 --fake-update=9.9.9
 *   npm run probe:update            (or: node scripts/probe-update.cjs 9334)
 *
 * Why this exists as a live probe rather than a unit check: every part of the update flow
 * is packaged-only. `updateMode` reports `disabled` in a development build, the dialog
 * reads that and greys out its own Download button, and electron-updater refuses to fetch
 * anything without an installer to replace. So the flow that ships was, for a long time,
 * the one thing nothing could exercise — and it shipped broken twice: an interop bug that
 * made `checkForUpdates` undefined, then a first real release that showed raw HTML, left
 * the Download button looking inert, and installed itself on quit after "Later".
 *
 * `--fake-update=<version>` rehearses it: a fabricated notice, a transfer that takes two
 * seconds, and an install that stops just short of restarting. It cannot fire in a
 * packaged build — `parseFakeUpdate` refuses there, and `verify` asserts that.
 *
 * What this still cannot settle: the real transfer and the real restart. Only a release
 * does that, which is why the log of one is worth keeping.
 */
const PORT = process.argv[2] ?? '9334'
let passed = 0
let failed = 0
const check = (label, ok, detail) => {
  if (ok) {
    passed++
    console.log('  PASS  ' + label)
  } else {
    failed++
    console.log('  FAIL  ' + label + (detail ? ' — ' + detail : ''))
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json()
  const page = list.find((t) => t.type === 'page' && !String(t.url).startsWith('devtools://'))
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r) => (ws.onopen = r))
  let id = 0
  const ev = (expression) =>
    new Promise((res, rej) => {
      const mine = ++id
      const on = (m) => {
        const d = JSON.parse(m.data)
        if (d.id !== mine) return
        ws.removeEventListener('message', on)
        if (d.result && d.result.exceptionDetails) {
          rej(new Error(d.result.exceptionDetails.exception
            ? d.result.exceptionDetails.exception.description
            : 'threw'))
          return
        }
        res(d.result && d.result.result ? d.result.result.value : undefined)
      }
      ws.addEventListener('message', on)
      ws.send(JSON.stringify({
        id: mine,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: true }
      }))
    })

  const READ = `(() => {
    const dialog = document.querySelector('[data-dialog="update"]')
    const bar = document.querySelector('[data-field="progress"], [data-job="update"]')
    const out = {
      open: dialog !== null,
      dot: document.querySelector('[data-field="updateDot"]') !== null,
      // The badge used to be an unlabelled 6px dot, which reads as a stray artifact
      // rather than as news. What it says is the point of it, so it is read here.
      dotText: (document.querySelector('[data-field="updateDot"]')?.innerText ?? '').trim(),
      dotTitle: document.querySelector('[data-field="updateDot"]')?.title ?? '',
      progress: bar ? bar.innerText.replace(/\\s+/g, ' ').slice(0, 60) : null
    }
    if (dialog === null) return JSON.stringify(out)
    const notes = dialog.querySelector('[data-field="releaseNotes"]')
    const download = dialog.querySelector('[data-action="updateDownload"]')
    const install = dialog.querySelector('[data-action="updateInstall"]')
    return JSON.stringify(Object.assign(out, {
      title: (dialog.closest('[role="dialog"]') ?? dialog.parentElement).innerText
        .split('\\n')[0],
      notes: notes ? notes.innerText : null,
      html: notes ? notes.innerHTML : null,
      download: download ? { disabled: download.disabled, label: download.innerText } : null,
      install: install ? { label: install.innerText } : null,
      later: dialog.querySelector('[data-action="updateLater"]') !== null
    }))
  })()`

  // ---- 1. it is up, unasked. The launch check waits four seconds by design, so this
  // waits for it rather than racing it.
  let first = { open: false }
  for (let i = 0; i < 14; i++) {
    first = JSON.parse(await ev(READ))
    if (first.open) break
    await sleep(1000)
  }
  check('the dialog is up at launch while an update is pending', first.open === true,
    'nothing prompted')
  if (!first.open) {
    console.log('\n' + passed + ' passed, ' + failed + ' failed')
    process.exit(1)
  }
  console.log('        → ' + JSON.stringify(first).slice(0, 240))
  check('it offers a Download and a Later, and no Install yet',
    first.download !== null && first.later === true && first.install === null)
  check('the notes are text, with no markup left in them',
    !first.notes.includes('<') && !first.html.includes('&lt;'),
    String(first.html).slice(0, 120))
  check('the list is a list, and single-spaced',
    first.notes.split('\n').filter((l) => l.trim().startsWith('•')).length === 2 &&
      !first.notes.includes('\n\n•'),
    JSON.stringify(first.notes))
  check('and Download is clickable, because a rehearsal reports the packaged arrangement',
    first.download.disabled === false, JSON.stringify(first.download))

  // ---- 2. Later closes it, and leaves it findable
  await ev(`document.querySelector('[data-action="updateLater"]').click()`)
  await sleep(400)
  const dismissed = JSON.parse(await ev(READ))
  check('Later closes the dialog', dismissed.open === false)
  check('and the badge on Settings stays, so it is still findable', dismissed.dot === true,
    'the update became invisible')
  /*
    And it says which version, rather than only that there is one.

    A bare gold dot next to Settings was reported as "a weird badge like it has a
    notification" -- accurate, and unreadable. The version is the whole message, and the
    tooltip is what a pointer finds.
  */
  check('and it says which version is waiting', dismissed.dotText === '9.9.9',
    JSON.stringify({ text: dismissed.dotText }))
  check('and carries it as a tooltip too, for the shape that has no room for it',
    dismissed.dotTitle.includes('9.9.9'), JSON.stringify({ title: dismissed.dotTitle }))

  // ---- 3. a fresh renderer prompts again, dismissed or not
  await ev(`location.reload()`)
  await sleep(3000)
  check('a reload prompts again, which is what "until it is up to date" means',
    JSON.parse(await ev(READ)).open === true, 'dismissal was remembered')

  // ---- 4. Download gets the dialog out of the way, and keeps it out
  await ev(`document.querySelector('[data-action="updateDownload"]').click()`)
  await sleep(350)
  const clicked = JSON.parse(await ev(READ))
  check('Download closes the dialog rather than sitting on the transfer',
    clicked.open === false, JSON.stringify(clicked).slice(0, 200))
  console.log('        → mid-transfer: ' + JSON.stringify(clicked).slice(0, 200))
  check('the progress bar is what replaced it, so the transfer is still visible',
    clicked.progress !== null && /[0-9]/.test(String(clicked.progress)),
    'the dialog closed onto nothing')

  let reopened = 0
  for (let i = 0; i < 4; i++) {
    await sleep(300)
    if (JSON.parse(await ev(READ)).open === true) reopened++
  }
  check('and stays closed while the progress runs, rather than reopening over itself',
    reopened === 0, reopened + ' of 4 samples found it back on top of its own progress')

  // ---- 5. and comes back, once, as the install prompt
  let done = { open: false }
  for (let i = 0; i < 20; i++) {
    done = JSON.parse(await ev(READ))
    if (done.open && done.install !== null) break
    await sleep(400)
  }
  check('a finished download prompts to install',
    done.open === true && done.install !== null, JSON.stringify(done).slice(0, 200))
  if (done.open) {
    console.log('        → ' + JSON.stringify(done).slice(0, 240))
    check('the install prompt says it is ready rather than repeating the offer',
      done.download === null && /install|Install|Redémarrer|redémarr/.test(
        done.install.label + ' ' + done.title),
      JSON.stringify({ title: done.title, install: done.install }))
    check('and it can still be declined, which is what Later has to mean',
      done.later === true, 'the only way out was to install')
  }

  // ---- 6. and the install can be taken. The rehearsal stops short of restarting,
  // so what is observable is that nothing is left pending afterwards.
  if (done.open) {
    await ev(`document.querySelector('[data-action="updateInstall"]').click()`)
    await sleep(800)
    const after = JSON.parse(await ev(READ))
    check('taking the install clears the pending update',
      after.open === false && after.dot === false, JSON.stringify(after))
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed')
  ws.close()
  process.exit(failed === 0 ? 0 : 1)
})().catch((e) => {
  console.log('  probe failed: ' + e.message)
  process.exit(1)
})
