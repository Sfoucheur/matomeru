import { useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { AlertTriangle, Check, Download, FileUp, HelpCircle, Upload } from 'lucide-react'
import type { CsvColumnMap, CsvDryRun, CsvPreview, TranslationKey } from '@shared/types'
import { guard, useApp } from '../store/app'
import type { ViewProps } from '../App'
import { Button, EmptyState, LangChip, Select } from '../components/primitives'
import { count } from '../lib/format'
import { useT } from '../hooks/useT'

const FIELD_LABELS: {
  key: keyof CsvColumnMap
  label: TranslationKey
  hint?: TranslationKey
}[] = [
  { key: 'quantity', label: 'csv.field.quantity' },
  { key: 'name', label: 'csv.field.name' },
  { key: 'set', label: 'csv.field.set' },
  { key: 'collectorNumber', label: 'csv.field.collectorNumber' },
  { key: 'lang', label: 'csv.field.lang', hint: 'csv.field.langHint' },
  { key: 'finish', label: 'csv.field.finish' },
  { key: 'condition', label: 'csv.field.condition' },
  { key: 'scryfallId', label: 'csv.field.scryfallId', hint: 'csv.field.scryfallIdHint' },
  { key: 'purchasePrice', label: 'csv.field.purchasePrice' }
]

export default function ImportExportView(_props: ViewProps): React.ReactElement {
  const t = useT()
  const invalidate = useApp((s) => s.invalidate)
  const toast = useApp((s) => s.toast)
  const filters = useApp((s) => s.filters)

  const [filePath, setFilePath] = useState<string | null>(null)
  const [preview, setPreview] = useState<CsvPreview | null>(null)
  const [map, setMap] = useState<CsvColumnMap>({})
  const [dryRun, setDryRun] = useState<CsvDryRun | null>(null)
  const [busy, setBusy] = useState(false)

  const chooseFile = async (): Promise<void> => {
    const path = await guard(() => window.api.csv.pickImportFile())
    if (!path) return
    setFilePath(path)
    setDryRun(null)
    const next = await guard(() => window.api.csv.preview(path))
    if (next) {
      setPreview(next)
      setMap(next.map)
    }
  }

  const runDryRun = async (): Promise<void> => {
    if (!filePath) return
    setBusy(true)
    const result = await guard(() => window.api.csv.dryRun(filePath, map))
    setBusy(false)
    if (result) setDryRun(result)
  }

  const commit = async (): Promise<void> => {
    if (!dryRun) return
    setBusy(true)
    const result = await guard(() => window.api.csv.commit(dryRun.rows))
    setBusy(false)
    if (result) {
      toast(
        'success',
        `${t('csv.imported', {
          cards: count(result.cards),
          rows: count(result.imported)
        })}${result.skipped ? t('csv.importedSkipped', { count: result.skipped }) : '.'}`
      )
      setDryRun(null)
      setPreview(null)
      setFilePath(null)
      invalidate()
    }
  }

  const saveRejects = async (): Promise<void> => {
    if (!dryRun) return
    const result = await guard(() => window.api.csv.writeRejects(dryRun.rows))
    if (result && !result.canceled) {
      toast('success', t('csv.wroteRejects', { count: result.count, path: result.path ?? '' }))
    }
  }

  const exportCsv = async (): Promise<void> => {
    const result = await guard(() => window.api.csv.exportCollection(filters))
    if (result && !result.canceled) {
      toast('success', t('csv.exported', { count: count(result.count), path: result.path ?? '' }))
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="shrink-0 px-5 pb-3 pt-4">
        <h1 className="text-lg font-semibold tracking-tight text-ink-50">{t('csv.title')}</h1>
        <p className="mt-0.5 text-xs text-ink-400">{t('csv.subtitle')}</p>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        <div className="grid gap-4 lg:grid-cols-[1fr_18rem]">
          <div className="space-y-4">
            <section className="panel p-4">
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-ink-400">
                {t('csv.step1')}
              </h2>
              <div className="flex flex-wrap items-center gap-3">
                <Button variant="primary" icon={<FileUp size={14} />} onClick={() => void chooseFile()}>
                  {t('csv.chooseFile')}
                </Button>
                {filePath && (
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-400">
                    {filePath}
                  </span>
                )}
              </div>
              {preview && (
                <p className="mt-2.5 text-[11px] text-ink-400">
                  {t('csv.detected', {
                    preset: preview.detectedPreset,
                    rows: count(preview.totalRows),
                    columns: preview.headers.length
                  })}
                </p>
              )}
            </section>

            {preview && (
              <motion.section
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                className="panel p-4"
              >
                <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-ink-400">
                  {t('csv.step2')}
                </h2>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {FIELD_LABELS.map((field) => (
                    <label key={field.key} className="flex flex-col gap-1 text-[11px] text-ink-400">
                      <span className="flex items-center gap-1">
                        {t(field.label)}
                        {field.hint && (
                          <span title={t(field.hint)}>
                            <HelpCircle size={10} className="text-ink-600" />
                          </span>
                        )}
                      </span>
                      <Select
                        value={map[field.key] ?? ''}
                        onChange={(value) =>
                          setMap((current) => ({ ...current, [field.key]: value || undefined }))
                        }
                        placeholder={t('csv.notMapped')}
                        options={preview.headers.map((header) => ({
                          value: header,
                          label: header
                        }))}
                      />
                    </label>
                  ))}
                </div>

                <div className="mt-4 flex items-center gap-3">
                  <Button
                    variant="primary"
                    icon={<Check size={14} />}
                    onClick={() => void runDryRun()}
                    disabled={busy}
                  >
                    {busy ? t('csv.resolving') : t('csv.previewImport')}
                  </Button>
                  <p className="text-[11px] leading-relaxed text-ink-500">
                    {t('csv.resolveHint')}
                  </p>
                </div>
              </motion.section>
            )}

            <AnimatePresence>
              {dryRun && (
                <motion.section
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  className="panel p-4"
                >
                  <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-ink-400">
                    {t('csv.step3')}
                  </h2>

                  <div className="mb-3 grid grid-cols-3 gap-2.5">
                    <Stat label={t('csv.matched')} value={dryRun.matched} tone="good" />
                    <Stat label={t('csv.ambiguous')} value={dryRun.ambiguous} tone="warn" />
                    <Stat label={t('csv.unmatched')} value={dryRun.unmatched} tone="bad" />
                  </div>

                  <div className="max-h-72 overflow-y-auto rounded-lg border border-ink-800">
                    <table className="w-full text-xs">
                      <tbody>
                        {dryRun.rows.slice(0, 300).map((row) => (
                          <tr
                            key={row.rowIndex}
                            className="border-b border-ink-850 last:border-0"
                          >
                            <td className="w-8 px-2 py-1.5">
                              <span
                                className={`inline-block h-1.5 w-1.5 rounded-full ${
                                  row.status === 'matched'
                                    ? 'bg-good'
                                    : row.status === 'ambiguous'
                                      ? 'bg-warn'
                                      : 'bg-bad'
                                }`}
                              />
                            </td>
                            <td className="numeric w-10 px-1 py-1.5 text-ink-500">
                              ×{row.quantity}
                            </td>
                            <td className="truncate px-1 py-1.5 text-ink-200">
                              {row.printing
                                ? (row.printing.printed_name ?? row.printing.name)
                                : (Object.values(row.raw)[1] ?? Object.values(row.raw)[0] ?? '—')}
                            </td>
                            <td className="w-14 px-1 py-1.5">
                              {row.printing && <LangChip lang={row.printing.lang} />}
                            </td>
                            <td className="w-24 px-1 py-1.5 uppercase text-ink-500">
                              {row.printing
                                ? `${row.printing.set_code} #${row.printing.collector_number}`
                                : ''}
                            </td>
                            <td className="px-2 py-1.5 text-[11px] text-ink-500">
                              {row.reason ??
                                (row.status === 'ambiguous'
                                  ? t('csv.candidates', { count: row.candidates?.length ?? 0 })
                                  : '')}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {dryRun.rows.length > 300 && (
                      <p className="border-t border-ink-800 px-3 py-2 text-center text-[11px] text-ink-500">
                        {t('csv.showingFirst', { count: count(dryRun.rows.length) })}
                      </p>
                    )}
                  </div>

                  <div className="mt-4 flex flex-wrap items-center gap-2.5">
                    <Button
                      variant="primary"
                      icon={<Upload size={14} />}
                      onClick={() => void commit()}
                      disabled={busy || dryRun.matched === 0}
                    >
                      {busy
                        ? t('csv.importing')
                        : t('csv.importMatched', { count: count(dryRun.matched) })}
                    </Button>
                    {dryRun.matched + dryRun.ambiguous + dryRun.unmatched > dryRun.matched && (
                      <Button icon={<Download size={13} />} onClick={() => void saveRejects()}>
                        {t('csv.saveUnresolved')}
                      </Button>
                    )}
                    {dryRun.unmatched > 0 && (
                      <p className="flex items-center gap-1.5 text-[11px] text-warn">
                        <AlertTriangle size={12} />
                        {t('csv.unresolvedSkipped')}
                      </p>
                    )}
                  </div>
                </motion.section>
              )}
            </AnimatePresence>

            {!preview && (
              <EmptyState
                icon={<FileUp size={28} />}
                title={t('csv.emptyTitle')}
                hint={t('csv.emptyHint')}
              />
            )}
          </div>

          <aside className="space-y-4">
            <section className="panel p-4">
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-400">
                {t('csv.export')}
              </h2>
              <p className="mb-3 text-[11px] leading-relaxed text-ink-400">{t('csv.exportHint')}</p>
              <Button className="w-full" icon={<Download size={14} />} onClick={() => void exportCsv()}>
                {t('csv.exportCollection')}
              </Button>
            </section>

            <section className="panel p-4 text-[11px] leading-relaxed text-ink-400">
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-400">
                {t('csv.howMatched')}
              </h2>
              <ol className="list-inside list-decimal space-y-1">
                <li>{t('csv.match1')}</li>
                <li>{t('csv.match2')}</li>
                <li>{t('csv.match3')}</li>
                <li>{t('csv.match4')}</li>
              </ol>
              <p className="mt-2.5 text-ink-500">{t('csv.matchNote')}</p>
            </section>
          </aside>
        </div>
      </div>
    </div>
  )
}

function Stat({
  label,
  value,
  tone
}: {
  label: string
  value: number
  tone: 'good' | 'warn' | 'bad'
}): React.ReactElement {
  const colors = {
    good: 'border-good/30 bg-good/[0.08] text-good',
    warn: 'border-warn/30 bg-warn/[0.08] text-warn',
    bad: 'border-bad/30 bg-bad/[0.08] text-bad'
  }
  return (
    <div className={`rounded-lg border px-3 py-2 ${colors[tone]}`}>
      <p className="numeric text-lg font-semibold leading-none">{count(value)}</p>
      <p className="mt-1 text-[10px] uppercase tracking-wider opacity-80">{label}</p>
    </div>
  )
}
