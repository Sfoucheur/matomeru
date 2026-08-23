/**
 * Rasterises resources/icon.svg to resources/icon.png.
 *
 * Runs in Electron because Chromium is the only rasteriser on this machine —
 * there is no PIL or sharp here, and a hand-rolled PNG encoder cannot draw a
 * glyph. electron-builder turns the PNG into the Windows .ico itself, so one
 * 1024x1024 file with transparency is all that is needed.
 *
 *   npx electron scripts/make-icon.cjs
 *   node scripts/check-icon.cjs      # verifies what came out
 */
const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const SIZE = 1024
const root = join(__dirname, '..')
const source = join(root, 'resources', 'icon.svg')
const target = join(root, 'resources', 'icon.png')

// Disable the GPU: transparent offscreen capture is unreliable with it on, and
// this is a one-shot build step where speed is irrelevant.
app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  const svg = readFileSync(source, 'utf8')
  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    useContentSize: true,
    webPreferences: { offscreen: false }
  })

  // The SVG is inlined into a page with no margin so the capture is exactly the
  // artwork, with nothing painted behind it.
  const page = `<!doctype html><meta charset="utf-8">
    <style>
      html, body { margin: 0; padding: 0; background: transparent; }
      svg { display: block; width: ${SIZE}px; height: ${SIZE}px; }
    </style>
    ${svg}`
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page))

  // Give the font a moment to load and paint before capturing.
  await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)')
  await new Promise((r) => setTimeout(r, 400))

  const image = await win.webContents.capturePage()
  const png = image.toPNG()
  writeFileSync(target, png)
  const { width, height } = image.getSize()
  console.log(`wrote ${target} — ${width}x${height}, ${png.length} bytes`)

  win.destroy()
  app.quit()
})
