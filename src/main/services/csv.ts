import { readFile, writeFile } from 'node:fs/promises'
import Papa from 'papaparse'
import type {
  CollectionFilters,
  Condition,
  Currency,
  CsvColumnMap,
  CsvDryRun,
  CsvPreset,
  CsvPreview,
  CsvResolvedRow,
  Finish,
  ProgressEvent
} from '@shared/types'
import { FOIL_TREATMENTS } from '@shared/types'
import { addToCollection, exportRows, updateItem } from '../db/repos/collection.js'
import { findLocalPrintings, getPrinting, upsertPrinting } from '../db/repos/printings.js'
import { cardsByNames, printingBySetNumberLang, cardById } from '../scryfall/client.js'
import { toPrinting } from '../scryfall/mappers.js'
import { t } from '@shared/i18n/index'
import type { TranslationKey } from '@shared/types'
import { getLocale } from '../db/repos/settings.js'

/** Localised message, resolved at throw time from the stored locale. */
function tr(key: TranslationKey, vars?: Record<string, string | number>): string {
  return t(getLocale(), key, vars)
}

export type ProgressSink = (event: ProgressEvent) => void

/**
 * Header maps for the exports people actually have lying around. Keys are
 * lowercase so matching is case-insensitive.
 */
const PRESETS: Record<Exclude<CsvPreset, 'auto' | 'manual'>, CsvColumnMap> = {
  manabox: {
    quantity: 'Quantity',
    name: 'Name',
    set: 'Set code',
    collectorNumber: 'Collector number',
    lang: 'Language',
    finish: 'Foil',
    condition: 'Condition',
    scryfallId: 'Scryfall ID',
    purchasePrice: 'Purchase price'
  },
  moxfield: {
    quantity: 'Count',
    name: 'Name',
    set: 'Edition',
    collectorNumber: 'Collector Number',
    lang: 'Language',
    finish: 'Foil',
    condition: 'Condition',
    purchasePrice: 'Purchase Price'
  },
  deckbox: {
    quantity: 'Count',
    name: 'Name',
    set: 'Edition',
    collectorNumber: 'Card Number',
    lang: 'Language',
    finish: 'Foil',
    condition: 'Condition'
  },
  matomeru: {
    quantity: 'quantity',
    name: 'name',
    set: 'set',
    collectorNumber: 'collector_number',
    lang: 'lang',
    finish: 'finish',
    condition: 'condition',
    scryfallId: 'scryfall_id',
    purchasePrice: 'purchase_price'
  }
}

function findHeader(headers: string[], candidates: string[]): string | undefined {
  const lower = new Map(headers.map((h) => [h.toLowerCase().trim(), h]))
  for (const candidate of candidates) {
    const hit = lower.get(candidate.toLowerCase())
    if (hit) return hit
  }
  return undefined
}

/** Picks the preset whose headers overlap the file most. */
function detectPreset(headers: string[]): { preset: CsvPreset; map: CsvColumnMap } {
  let best: { preset: CsvPreset; map: CsvColumnMap; score: number } = {
    preset: 'manual',
    map: {},
    score: 0
  }

  for (const [name, template] of Object.entries(PRESETS)) {
    const map: CsvColumnMap = {}
    let score = 0
    for (const [field, header] of Object.entries(template)) {
      const hit = findHeader(headers, [header])
      if (hit) {
        map[field as keyof CsvColumnMap] = hit
        score += 1
      }
    }
    if (score > best.score) best = { preset: name as CsvPreset, map, score }
  }

  // Fall back to a generic guess so an unknown export is still usable.
  if (best.score < 2) {
    const map: CsvColumnMap = {
      quantity: findHeader(headers, ['quantity', 'count', 'qty', 'amount']),
      name: findHeader(headers, ['name', 'card name', 'card']),
      set: findHeader(headers, ['set code', 'set', 'edition', 'set_code', 'expansion']),
      collectorNumber: findHeader(headers, [
        'collector number',
        'collector_number',
        'card number',
        'number',
        'cn'
      ]),
      lang: findHeader(headers, ['language', 'lang']),
      finish: findHeader(headers, ['foil', 'finish', 'printing']),
      condition: findHeader(headers, ['condition', 'cond']),
      scryfallId: findHeader(headers, ['scryfall id', 'scryfall_id', 'scryfallid', 'id']),
      purchasePrice: findHeader(headers, ['purchase price', 'purchase_price', 'price paid'])
    }
    const score = Object.values(map).filter(Boolean).length
    if (score > best.score) best = { preset: 'manual', map, score }
  }

  return { preset: best.preset, map: best.map }
}

function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: 'greedy',
    // Let Papa work out comma vs semicolon vs tab.
    delimiter: '',
    transformHeader: (h) => h.trim()
  })
  const rows = (parsed.data ?? []).filter((row) =>
    Object.values(row).some((v) => (v ?? '').toString().trim() !== '')
  )
  return { headers: parsed.meta.fields ?? [], rows }
}

export async function previewCsv(filePath: string): Promise<CsvPreview> {
  const text = await readFile(filePath, 'utf8')
  const { headers, rows } = parseCsv(text)
  const { preset, map } = detectPreset(headers)
  return {
    headers,
    detectedPreset: preset,
    map,
    sampleRows: rows.slice(0, 8),
    totalRows: rows.length
  }
}

function normalizeFinish(raw: string | undefined): Finish {
  const value = (raw ?? '').trim().toLowerCase()
  if (!value || value === 'false' || value === 'no' || value === 'normal' || value === '0') {
    return 'nonfoil'
  }
  if (value.includes('etch')) return 'etched'
  if (value.includes('foil') || value === 'true' || value === 'yes' || value === '1') return 'foil'
  return 'nonfoil'
}

/**
 * The foil treatment named in a Foil column, if any.
 *
 * Other trackers write the treatment into the same column as the finish —
 * ManaBox and Moxfield export "Surge Foil", "Galaxy Foil", "Etched" — and
 * `normalizeFinish` collapses all of it to plain `foil`. Reading the tag out of
 * the same value keeps information an import used to throw away.
 */
function normalizeTreatment(raw: string | undefined): string | null {
  const value = (raw ?? '').trim().toLowerCase().replace(/[\s_-]/g, '')
  if (!value) return null
  for (const { tag } of FOIL_TREATMENTS) {
    if (value === tag || value.includes(tag)) return tag
  }
  // "surge foil" arrives as "surgefoil" after stripping, but "surge" alone does
  // not, so also try the tag with its trailing "foil" removed.
  for (const { tag } of FOIL_TREATMENTS) {
    const stem = tag.replace(/foil$/, '')
    if (stem.length >= 4 && value.includes(stem)) return tag
  }
  return null
}

function normalizeCondition(raw: string | undefined): Condition {
  const value = (raw ?? '').trim().toLowerCase().replace(/[\s_-]/g, '')
  const table: Record<string, Condition> = {
    nm: 'NM', mint: 'NM', nearmint: 'NM', m: 'NM', nearmintfoil: 'NM',
    lp: 'LP', lightlyplayed: 'LP', slightlyplayed: 'LP', excellent: 'LP', ex: 'LP', good: 'LP',
    mp: 'MP', moderatelyplayed: 'MP', played: 'MP', vg: 'MP',
    hp: 'HP', heavilyplayed: 'HP', poor: 'HP',
    dmg: 'DMG', damaged: 'DMG'
  }
  return table[value] ?? 'NM'
}

function normalizeLang(raw: string | undefined): string {
  const value = (raw ?? '').trim().toLowerCase()
  if (!value) return 'en'
  const table: Record<string, string> = {
    english: 'en', en: 'en',
    french: 'fr', fr: 'fr', français: 'fr', francais: 'fr',
    german: 'de', de: 'de', deutsch: 'de',
    italian: 'it', it: 'it', italiano: 'it',
    spanish: 'es', es: 'es', español: 'es', espanol: 'es',
    portuguese: 'pt', pt: 'pt', português: 'pt',
    japanese: 'ja', ja: 'ja', jp: 'ja', 日本語: 'ja',
    korean: 'ko', ko: 'ko',
    russian: 'ru', ru: 'ru',
    'chinese simplified': 'zhs', zhs: 'zhs', cs: 'zhs',
    'chinese traditional': 'zht', zht: 'zht', ct: 'zht',
    phyrexian: 'ph', ph: 'ph'
  }
  return table[value] ?? value
}

function pick(row: Record<string, string>, header: string | undefined): string | undefined {
  if (!header) return undefined
  const value = row[header]
  return value === undefined || value === null ? undefined : String(value).trim()
}

/**
 * Resolves a CSV row to one printing, cheapest lookup first.
 *
 * Note the deliberate absence of a batch call for the set/number/language path:
 * `POST /cards/collection` ignores a `lang` identifier and returns English, so
 * anything with a language has to be resolved one request at a time.
 */
async function resolveRow(
  row: Record<string, string>,
  map: CsvColumnMap,
  index: number
): Promise<CsvResolvedRow> {
  const quantityRaw = pick(row, map.quantity)
  const quantity = Math.max(1, Number.parseInt(quantityRaw ?? '1', 10) || 1)
  const finishRaw = pick(row, map.finish)
  const finish = normalizeFinish(finishRaw)
  // A treatment only means anything on a foil copy, matching how it is derived
  // and displayed everywhere else.
  const treatment = finish === 'nonfoil' ? null : normalizeTreatment(finishRaw)
  const condition = normalizeCondition(pick(row, map.condition))
  const lang = normalizeLang(pick(row, map.lang))
  const name = pick(row, map.name)
  const set = pick(row, map.set)
  const collectorNumber = pick(row, map.collectorNumber)
  const scryfallId = pick(row, map.scryfallId)

  const base = { rowIndex: index, raw: row, quantity, finish, treatment, condition }

  // A row this app exported as a derived deck copy is not yours to re-import:
  // the card is already accounted for by its deck label, and creating a real
  // collection row for it would count the same physical card twice.
  if ((row.source ?? '').trim().toLowerCase() === 'deck') {
    return {
      ...base,
      status: 'unmatched',
      reason: tr('csv.reasonDeckRow')
    }
  }

  // 1. An explicit Scryfall id is unambiguous.
  if (scryfallId && /^[0-9a-f-]{30,}$/i.test(scryfallId)) {
    const cached = getPrinting(scryfallId)
    if (cached) return { ...base, status: 'matched', printing: cached }
    const card = await cardById(scryfallId)
    if (card) {
      const printing = toPrinting(card)
      upsertPrinting(printing, card)
      return { ...base, status: 'matched', printing }
    }
  }

  // 2. Set + collector number + language: the only route that honours language.
  if (set && collectorNumber) {
    const cachedList = findLocalPrintings({ set, collectorNumber, lang })
    if (cachedList.length === 1) {
      return { ...base, status: 'matched', printing: cachedList[0] }
    }
    const card = await printingBySetNumberLang(set, collectorNumber, lang)
    if (card) {
      const printing = toPrinting(card)
      upsertPrinting(printing, card)
      return { ...base, status: 'matched', printing }
    }
  }

  // 3. Name (+ set) — may legitimately be ambiguous across printings.
  if (name) {
    const candidates = findLocalPrintings({ name, ...(set ? { set } : {}), lang })
    if (candidates.length === 1) return { ...base, status: 'matched', printing: candidates[0] }
    if (candidates.length > 1) {
      return { ...base, status: 'ambiguous', candidates: candidates.slice(0, 25) }
    }
    return {
      ...base,
      status: 'unmatched',
      reason: set
        ? `No printing found for "${name}" in set ${set}.`
        : `Could not resolve "${name}" — add a set and collector number.`
    }
  }

  return { ...base, status: 'unmatched', reason: tr('csv.reasonNoIdentity') }
}

/**
 * Resolves every row without writing anything. The commit step reuses these
 * results, so a dry run is a real preview rather than a separate estimate.
 */
export async function dryRunCsv(
  filePath: string,
  map: CsvColumnMap,
  onProgress: ProgressSink
): Promise<CsvDryRun> {
  const text = await readFile(filePath, 'utf8')
  const { rows } = parseCsv(text)

  onProgress({ job: 'csv-import', phase: 'Resolving cards', done: 0, total: rows.length })

  // Warm the local cache with a batch name lookup so the per-row resolution
  // mostly hits SQLite instead of the network.
  const names = [...new Set(rows.map((r) => pick(r, map.name)).filter((n): n is string => !!n))]
  if (names.length && names.length <= 1500) {
    try {
      const { found } = await cardsByNames(names)
      for (const card of found) upsertPrinting(toPrinting(card), card)
    } catch {
      // A failed warm-up is not fatal; per-row resolution still works.
    }
  }

  const resolved: CsvResolvedRow[] = []
  for (let i = 0; i < rows.length; i += 1) {
    resolved.push(await resolveRow(rows[i], map, i))
    if (i % 10 === 0 || i === rows.length - 1) {
      onProgress({
        job: 'csv-import',
        phase: 'Resolving cards',
        done: i + 1,
        total: rows.length
      })
    }
  }

  onProgress({
    job: 'csv-import',
    phase: 'Preview ready',
    done: rows.length,
    total: rows.length,
    finished: true
  })

  return {
    rows: resolved,
    matched: resolved.filter((r) => r.status === 'matched').length,
    ambiguous: resolved.filter((r) => r.status === 'ambiguous').length,
    unmatched: resolved.filter((r) => r.status === 'unmatched').length
  }
}

export interface CommitResult {
  imported: number
  cards: number
  skipped: number
}

/** Writes the matched rows. Anything ambiguous or unmatched is left alone. */
export function commitCsv(rows: CsvResolvedRow[]): CommitResult {
  let imported = 0
  let cards = 0
  let skipped = 0

  for (const row of rows) {
    if (row.status !== 'matched' || !row.printing) {
      skipped += 1
      continue
    }
    const itemId = addToCollection({
      scryfall_id: row.printing.scryfall_id,
      finish: row.finish,
      condition: row.condition,
      quantity: row.quantity
    })
    // Only when the file actually named one: leaving it null lets the printing's
    // own tag apply, which is right far more often than a guess would be.
    if (row.treatment) updateItem(itemId, { foil_treatment: row.treatment })
    imported += 1
    cards += row.quantity
  }

  return { imported, cards, skipped }
}

/** Writes the rows a dry run could not resolve, so they can be fixed and retried. */
export async function writeRejects(filePath: string, rows: CsvResolvedRow[]): Promise<number> {
  const rejects = rows.filter((r) => r.status !== 'matched')
  if (!rejects.length) return 0
  const csv = Papa.unparse(
    rejects.map((r) => ({ ...r.raw, _matomeru_reason: r.reason ?? r.status }))
  )
  await writeFile(filePath, csv, 'utf8')
  return rejects.length
}

const EXPORT_HEADERS = [
  'source', 'quantity', 'name', 'printed_name', 'lang', 'set', 'set_name',
  'collector_number', 'rarity', 'finish', 'foil_type', 'condition', 'scryfall_id',
  'unit_value', 'total_value', 'purchase_price', 'notes'
]

/** Exports with a column set that round-trips back through the importer. */
export async function exportCollectionCsv(
  filePath: string,
  filters: CollectionFilters,
  currency: Currency
): Promise<number> {
  const rows = exportRows(filters, currency)
  const records = rows.map((row) => ({
    // `source` is what stops a re-import turning derived deck copies into real
    // collection rows, which would double every card under an "owned" label.
    source: row.source,
    quantity: row.quantity,
    name: row.printing.name,
    printed_name: row.printing.printed_name ?? '',
    lang: row.printing.lang,
    set: row.printing.set_code,
    set_name: row.printing.set_name,
    collector_number: row.printing.collector_number,
    rarity: row.printing.rarity,
    finish: row.finish,
    // Round-trips: the importer reads a treatment out of either column.
    foil_type: row.foil_treatment ?? '',
    condition: row.condition ?? '',
    scryfall_id: row.scryfall_id,
    unit_value: row.unit_value ?? '',
    total_value: row.total_value ?? '',
    purchase_price: row.purchase_price ?? '',
    notes: row.notes ?? ''
  }))
  await writeFile(filePath, Papa.unparse(records, { columns: EXPORT_HEADERS }), 'utf8')
  return records.length
}

export interface PickListExportRow {
  quantity: number
  name: string
  printed_name: string | null
  lang: string
  set_code: string
  collector_number: string
  finish: string
  condition: string
  unit_value: number | null
}

export async function exportPickListCsv(
  filePath: string,
  rows: PickListExportRow[]
): Promise<number> {
  const records = rows.map((row) => ({
    quantity: row.quantity,
    name: row.name,
    printed_name: row.printed_name ?? '',
    lang: row.lang,
    set: row.set_code,
    collector_number: row.collector_number,
    finish: row.finish,
    condition: row.condition,
    unit_value: row.unit_value ?? ''
  }))
  await writeFile(filePath, Papa.unparse(records), 'utf8')
  return records.length
}
