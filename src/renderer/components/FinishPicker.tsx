import { useRef, useState } from 'react'
import { Check, ChevronDown, Sparkles } from 'lucide-react'
import {
  FINISHES,
  FOIL_TREATMENTS,
  foilTreatmentLabel,
  foilTreatmentOf,
  type Finish,
  type Printing
} from '@shared/types'
import { FINISH_LABEL } from '../lib/format'
import { useT } from '../hooks/useT'
import Popover from './Popover'

/**
 * Sets the finish, and which kind of foil, of copies you physically hold.
 *
 * `printing.finishes` says what the printing was *sold* as; this says what is in
 * your box. They usually agree, so the finishes the printing offers are listed
 * first and anything else sits under "declare anyway" — a card can be a genuine
 * misprint, a proxy, or simply missing from Scryfall's record, and refusing the
 * click would leave no way to record the truth.
 *
 * The treatment is normally read off the printing's promo tags, so it is shown as
 * the default rather than as an empty field, and only stored when you change it.
 * That keeps a re-tagged printing correcting itself instead of freezing whatever
 * was true the day you added the card.
 */
export default function FinishPicker({
  printing,
  finish,
  treatment,
  forced,
  onApply
}: {
  printing: Printing
  finish: Finish
  /** Your stored override, or null when the printing's own tag applies. */
  treatment: string | null
  /** True when the finish itself is one you declared. */
  forced?: boolean
  onApply: (finish: Finish, treatment: string | null) => void
}): React.ReactElement {
  const t = useT()
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const derived = foilTreatmentOf(printing, finish)
  // A nonfoil copy shows no foil type even if one is stored against it — the
  // label read "Normal Surge Foil★" before this, which is a contradiction.
  const shown = finish === 'nonfoil' ? null : (treatment ?? derived)
  const offered = printing.finishes
  const others = FINISHES.filter((f) => !offered.includes(f))

  const apply = (nextFinish: Finish, nextTreatment: string | null): void => {
    setOpen(false)
    onApply(nextFinish, nextTreatment)
  }

  return (
    <>
      <button
        ref={triggerRef}
        onClick={() => setOpen((v) => !v)}
        title={t('finishPicker.title')}
        className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-left text-[11px]
          transition-colors hover:bg-ink-750 ${
            finish === 'nonfoil' ? 'text-ink-300' : 'text-gold-300'
          }`}
      >
        <span>{FINISH_LABEL[finish]}</span>
        {shown && (
          <span className="inline-flex items-center gap-0.5 text-gold-400">
            <Sparkles size={9} />
            {foilTreatmentLabel(shown)}
            {/* Marks a value you asserted, exactly as a declared language is marked. */}
            {treatment && <span title={t('finishPicker.yours')}>★</span>}
          </span>
        )}
        {forced && <span title={t('finishPicker.yours')}>★</span>}
        <ChevronDown size={11} className="text-ink-500" />
      </button>

      <Popover open={open} onClose={() => setOpen(false)} trigger={triggerRef} width={210}>
        <p className="px-2 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wider text-ink-500">
          {t('finishPicker.finish')}
        </p>
        {offered.map((f) => (
          <Option key={f} selected={f === finish} onClick={() => apply(f, null)}>
            {FINISH_LABEL[f]}
          </Option>
        ))}

        {others.length > 0 && (
          <>
            <p className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-ink-500">
              {t('finishPicker.declareAnyway')}
            </p>
            {others.map((f) => (
              <Option key={f} selected={f === finish} onClick={() => apply(f, null)}>
                {FINISH_LABEL[f]}
              </Option>
            ))}
          </>
        )}

        {/* A nonfoil card has no foil type, so offering one would be a value no
            screen could ever show. */}
        {finish !== 'nonfoil' && (
          <>
            <p className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-ink-500">
              {t('filters.treatment')}
            </p>
            <Option selected={treatment === null} onClick={() => apply(finish, null)}>
              {derived ? (
                <>
                  {foilTreatmentLabel(derived)}{' '}
                  <span className="text-ink-500">{t('finishPicker.fromPrinting')}</span>
                </>
              ) : (
                t('finishPicker.plainFoil')
              )}
            </Option>
            {FOIL_TREATMENTS.map((tr) => (
              <Option
                key={tr.tag}
                selected={treatment === tr.tag}
                onClick={() => apply(finish, tr.tag)}
              >
                {tr.label}
              </Option>
            ))}
          </>
        )}
      </Popover>
    </>
  )
}

function Option({
  selected,
  onClick,
  children
}: {
  selected: boolean
  onClick: () => void
  children: React.ReactNode
}): React.ReactElement {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs
        transition-colors hover:bg-ink-750"
    >
      <span className="w-3 shrink-0 text-gold-400">
        {selected && <Check size={11} strokeWidth={3} />}
      </span>
      <span className="flex-1 truncate">{children}</span>
    </button>
  )
}
