/**
 * Checks resources/icon.png by decoding it, not by looking at it.
 *
 * The failure that matters is silent: if the Japanese font is missing or the
 * weight does not resolve, the glyph renders as an empty box or nothing at all
 * and the icon still *looks* like a valid roundel. So this measures the ink.
 *
 *   node scripts/check-icon.cjs
 */
const { inflateSync } = require('node:zlib')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const file = join(__dirname, '..', 'resources', 'icon.png')

/** Minimal PNG reader: enough for a truecolour-alpha image we produced ourselves. */
function decode(buf) {
  let pos = 8
  let idat = Buffer.alloc(0)
  let width = 0
  let height = 0
  let channels = 4
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const body = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      const colorType = body[9]
      channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType]
      if (body[8] !== 8) throw new Error(`unexpected bit depth ${body[8]}`)
      if (!channels) throw new Error(`unexpected colour type ${colorType}`)
    } else if (type === 'IDAT') {
      idat = Buffer.concat([idat, body])
    }
    pos += 12 + len
  }
  const raw = inflateSync(idat)
  const stride = width * channels
  const rows = []
  let prev = Buffer.alloc(stride)
  let i = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[i]
    i += 1
    const line = Buffer.from(raw.subarray(i, i + stride))
    i += stride
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? line[x - channels] : 0
      const b = prev[x]
      const c = x >= channels ? prev[x - channels] : 0
      if (filter === 1) line[x] = (line[x] + a) & 255
      else if (filter === 2) line[x] = (line[x] + b) & 255
      else if (filter === 3) line[x] = (line[x] + ((a + b) >> 1)) & 255
      else if (filter === 4) {
        const pa = Math.abs(b - c)
        const pb = Math.abs(a - c)
        const pc = Math.abs(a + b - 2 * c)
        line[x] = (line[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255
      }
    }
    rows.push(line)
    prev = line
  }
  return { width, height, channels, rows }
}

let passed = 0
let failed = 0
function check(label, ok, detail) {
  if (ok) {
    passed += 1
    console.log(`  PASS  ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const img = decode(readFileSync(file))
const { width: w, height: h, channels: ch, rows } = img
const px = (x, y) => {
  const o = x * ch
  const r = rows[y]
  return [r[o], r[o + 1], r[o + 2], ch === 4 ? r[o + 3] : 255]
}
const near = (got, want, tol = 12) =>
  Math.abs(got[0] - want[0]) <= tol &&
  Math.abs(got[1] - want[1]) <= tol &&
  Math.abs(got[2] - want[2]) <= tol

console.log(`icon: ${w}x${h}`)
check('it is 1024x1024', w === 1024 && h === 1024, `${w}x${h}`)
check('with an alpha channel', ch === 4, `${ch} channels`)

const cx = Math.floor(w / 2)
const cy = Math.floor(h / 2)
const at = (radius) => px(cx, cy - radius)

check('the corners are transparent', px(3, 3)[3] === 0 && px(w - 4, 3)[3] === 0, `${px(3, 3)}`)
check('the blue disc is Tadami blue', near(at(440), [46, 131, 190]), `${at(440)}`)
check('the red ring is where it should be', near(at(320), [204, 46, 46], 20), `${at(320)}`)
check('white inside the ring', near(at(270), [253, 253, 253]), `${at(270)}`)
check('and white still, further in', near(at(200), [253, 253, 253]), `${at(200)}`)

/*
  The glyph. Measuring its ink box is the whole point: a missing font paints
  either nothing (no dark pixels at all) or a hollow "tofu" rectangle, and both
  would sail past a colour-only check.
*/
let minX = w
let maxX = -1
let minY = h
let maxY = -1
let ink = 0
for (let y = 0; y < h; y += 1) {
  for (let x = 0; x < w; x += 1) {
    const p = px(x, y)
    if (p[3] > 128 && p[0] < 90 && p[1] < 90 && p[2] < 90) {
      ink += 1
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
}
const gw = maxX - minX + 1
const gh = maxY - minY + 1
console.log(`glyph ink: ${gw}x${gh} at (${minX},${minY}), ${ink} px`)
check('the glyph actually rendered', ink > 2000, `${ink} dark pixels`)
check(
  'at roughly the reference proportion (~26% of the canvas)',
  gh / h > 0.18 && gh / h < 0.36,
  `${(gh / h * 100).toFixed(1)}%`
)
check(
  'centred',
  Math.abs((minX + maxX) / 2 - cx) < 24 && Math.abs((minY + maxY) / 2 - cy) < 24,
  `centre (${((minX + maxX) / 2).toFixed(0)},${((minY + maxY) / 2).toFixed(0)}) vs (${cx},${cy})`
)
check(
  'and it fits inside the white disc',
  Math.hypot(gw / 2, gh / 2) < 288,
  `half-diagonal ${Math.hypot(gw / 2, gh / 2).toFixed(0)} vs r288`
)
check(
  'not a hollow tofu box',
  // A missing-glyph box is an outline: its ink would hug the bounding rectangle
  // and leave the middle empty. ま has strokes through the centre band.
  (() => {
    let middle = 0
    const y0 = Math.floor(minY + gh * 0.4)
    const y1 = Math.floor(minY + gh * 0.6)
    for (let y = y0; y <= y1; y += 1) {
      for (let x = Math.floor(minX + gw * 0.3); x <= Math.floor(minX + gw * 0.7); x += 1) {
        const p = px(x, y)
        if (p[0] < 90 && p[1] < 90 && p[2] < 90 && p[3] > 128) middle += 1
      }
    }
    return middle > 200
  })(),
  'the centre of the glyph box is empty, which is what tofu looks like'
)

console.log(`\n${'='.repeat(48)}\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
