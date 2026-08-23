import { useEffect, useRef, useState } from 'react'
import { Check, Globe, Languages, RefreshCw } from 'lucide-react'
import { LANGUAGES, type CardContext, type PrintingChoice } from '@shared/types'
import { guard, useApp } from '../store/app'
import { CardImage, LangChip, RarityPip } from './primitives'
import Popover from './Popover'
import PrintingFilterBar from './PrintingFilterBar'
import { matchesPrintingFilters } from '../lib/printingFilter'
import { languageName, money } from '../lib/format'
import { useT } from '../hooks/useT'

/**
 * Every printing of a card, so you can say which one you actually hold.
 *
 * The set/collector-number route Scryfall offers for languages only answers about
 * one exact printing, so a translation published under a different set is
 * invisible to it. This list comes from the all-printings search
 * (`include_multilingual`) — the same one the Add-cards picker uses — which is
 * where those printings turn up.
 *
 * When even this list has nothing in the language you hold, the forced-language
 * control below records what you are claiming without inventing a printing: the
 * row keeps a real one underneath for prices and rules text.
 */
export default function PrintingPicker({
  name,
  currentScryfallId,
  currency,
  context,
  forcedLang,
  onChanged
}: {
  /** English name — what the all-printings search is keyed on. */
  name: string
  currentScryfallId: string
  currency: 'usd' | 'eur'
  context: CardContext
  /** The language currently asserted for this card, if any. */
  forcedLang: string | null
  onChanged: (nextScryfallId?: string) => void
}): React.ReactElement {
  const toast = useApp((s) => s.toast)
  const t = useT()
  // The same filters as the Add-cards picker: a basic land returns hundreds of
  // printings here too, and a filter set in one screen should hold in the other.
  const printingFilters = useApp((s) => s.printingFilters)
  const setPrintingFilters = useApp((s) => s.setPrintingFilters)
  const resetPrintingFilters = useApp((s) => s.resetPrintingFilters)
  const [printings, setPrintings] = useState<PrintingChoice[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [forceOpen, setForceOpen] = useState(false)
  // Local, so the label updates the moment you declare a language rather than on
  // the next time the modal is opened.
  const [declared, setDeclared] = useState<string | null>(forcedLang)
  const [forcedName, setForcedName] = useState('')
  const forceRef = useRef<HTMLButtonElement>(null)

  const visible = (printings ?? []).filter((p) => matchesPrintingFilters(p, printingFilters))

  const load = async (): Promise<void> => {
    setLoading(true)
    const result = await guard(() => window.api.cards.printings(name))
    setPrintings(result ?? [])
    setLoading(false)
  }

  useEffect(() => {
    setPrintings(null)
  }, [name])

  const choose = async (printing: PrintingChoice): Promise<void> => {
    setBusy(true)
    if (context.kind === 'deck') {
      const ok = await guard(() =>
        window.api.decks.setCardPrinting(context.deckId, context.oracleId, printing.scryfall_id)
      )
      if (ok) {
        toast(
          'success',
          t('printing.deckUses', {
            deck: context.deckName,
            lang: printing.lang.toUpperCase()
          })
        )
        onChanged(printing.scryfall_id)
      }
    } else {
      const survivor = await guard(() =>
        window.api.collection.setPrinting(context.itemId, printing.scryfall_id)
      )
      if (survivor !== undefined) {
        toast('success', t('printing.copyIsNow', { lang: printing.lang.toUpperCase() }))
        onChanged(printing.scryfall_id)
      }
    }
    setBusy(false)
  }

  const force = async (lang: string | null): Promise<void> => {
    setForceOpen(false)
    setBusy(true)
    const ok =
      context.kind === 'deck'
        ? await guard(() =>
            window.api.decks.forceCardLanguage(
              context.deckId,
              context.oracleId,
              lang,
              forcedName || null
            )
          )
        : await guard(() =>
            window.api.collection.forceLanguage(context.itemId, lang, forcedName || null)
          )
    if (ok) {
      setDeclared(lang)
      toast(
        'success',
        lang
          ? t('printing.declaredToast', { language: languageName(lang) })
          : t('printing.backToArchidekt')
      )
      onChanged()
    }
    setBusy(false)
  }

  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2">
        <h4 className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-500">
          <Globe size={10} />
          {t('printing.printings')}
        </h4>
        <span className="text-[10px] text-ink-600">
          {context.kind === 'deck'
            ? t('printing.forDeck', { name: context.deckName })
            : t('printing.forYourCopy')}
        </span>

        <button
          ref={forceRef}
          onClick={() => setForceOpen((v) => !v)}
          disabled={busy}
          title={t('printing.declaredHint')}
          className="field ml-auto flex items-center gap-1.5 whitespace-nowrap text-[11px] text-ink-300"
        >
          <Languages size={12} className="text-ink-500" />
          {declared
            ? t('printing.declared', { lang: declared.toUpperCase() })
            : t('printing.notListed')}
        </button>
      </div>

      {printings === null ? (
        <button
          onClick={() => void load()}
          disabled={loading}
          className="field flex w-full items-center justify-center gap-2 text-xs text-ink-300"
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          {loading ? t('printing.looking') : t('printing.showAll')}
        </button>
      ) : printings.length === 0 ? (
        <p className="text-[11px] leading-relaxed text-ink-500">
          {t('printing.noneListed')}
        </p>
      ) : (
        <>
          <PrintingFilterBar
            printings={printings}
            filters={printingFilters}
            onChange={setPrintingFilters}
            onReset={resetPrintingFilters}
            shown={visible.length}
          />
          {visible.length === 0 ? (
            <p className="text-[11px] leading-relaxed text-ink-500">
              {t('printing.allFiltered', { count: printings.length })}
            </p>
          ) : (
            <div className="max-h-72 space-y-1 overflow-y-auto pr-1">
              {visible.map((printing) => {
                const current = printing.scryfall_id === currentScryfallId
                return (
                  <button
                    key={printing.scryfall_id}
                    onClick={() => void choose(printing)}
                    disabled={busy || current}
                    title={
                      current
                        ? t('printing.inUse')
                        : t('printing.usePrinting', {
                            set: printing.set_name,
                            lang: printing.lang.toUpperCase()
                          })
                    }
                    className={`flex w-full items-center gap-2 rounded-lg border px-2 py-1.5 text-left transition-colors ${
                      current
                        ? 'border-gold-500/60 bg-gold-500/[0.08]'
                        : 'border-ink-800 hover:border-ink-600 hover:bg-ink-850'
                    }`}
                  >
                    <CardImage
                      scryfallId={printing.scryfall_id}
                      className="h-8 w-6 shrink-0"
                      alt={printing.name}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[11px] text-ink-100">
                        {printing.printed_name ?? printing.name}
                      </span>
                      <span className="block truncate text-[10px] text-ink-500">
                        {printing.set_code.toUpperCase()} · #{printing.collector_number}
                      </span>
                    </span>
                    <LangChip lang={printing.lang} />
                    <RarityPip rarity={printing.rarity} />
                    {printing.owned > 0 && (
                      <span className="numeric rounded bg-good/15 px-1.5 py-0.5 text-[9px] text-good">
                        {t('printing.own', { count: printing.owned })}
                      </span>
                    )}
                    <span className="numeric w-14 shrink-0 text-right text-[10px] text-gold-300">
                      {money(
                        Number(
                          currency === 'eur'
                            ? (printing.prices?.eur ?? NaN)
                            : (printing.prices?.usd ?? NaN)
                        ),
                        currency
                      )}
                    </span>
                    {current && <Check size={12} className="shrink-0 text-gold-400" />}
                  </button>
                )
              })}
            </div>
          )}
        </>
      )}

      <Popover open={forceOpen} onClose={() => setForceOpen(false)} trigger={forceRef} width={228}>
        <p className="px-2 pb-1.5 pt-1.5 text-[10px] leading-relaxed text-ink-500">
          {t('printing.forceHint')}
        </p>
        <label className="block px-2 pb-1.5">
          <span className="text-[10px] text-ink-500">{t('printing.localizedName')}</span>
          <input
            value={forcedName}
            onChange={(e) => setForcedName(e.target.value)}
            placeholder={t('printing.nameExample')}
            className="field mt-1 w-full text-xs outline-none placeholder:text-ink-600"
          />
        </label>
        <div className="max-h-56 overflow-y-auto">
          {LANGUAGES.map((lang) => (
            <button
              key={lang}
              onClick={() => void force(lang)}
              className={`flex w-full items-center rounded px-2 py-1 text-left text-xs transition-colors
                hover:bg-ink-750 ${declared === lang ? 'text-gold-300' : 'text-ink-300'}`}
            >
              <span className="flex-1">{languageName(lang)}</span>
              <span className="text-[10px] uppercase text-ink-600">{lang}</span>
            </button>
          ))}
        </div>
        {declared && (
          <>
            <div className="my-1 border-t border-ink-700" />
            <button
              onClick={() => void force(null)}
              className="w-full rounded px-2 py-1 text-left text-xs text-ink-400 transition-colors hover:bg-ink-750"
            >
              {t('printing.stopDeclaring')}
            </button>
          </>
        )}
      </Popover>
    </div>
  )
}
