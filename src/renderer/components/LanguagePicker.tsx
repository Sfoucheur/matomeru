import { useRef, useState } from 'react'
import { Languages } from 'lucide-react'
import { LANGUAGES } from '@shared/types'
import { languageName } from '../lib/format'
import { useT } from '../hooks/useT'
import Popover from './Popover'

/**
 * "Set the language of these cards", for a selection.
 *
 * One control, on the bar that says which cards are selected — not one per row. A deck of
 * 250 cards used to mount 250 popovers to offer the same list, and the collection had no
 * way to do this at all despite the IPC for it existing.
 *
 * The trigger doubles as the busy indicator, because this is slow by nature: it is one
 * Scryfall lookup per card, paced by the client's own queue, and pretending otherwise
 * would invite a second click.
 */
export default function LanguagePicker({
  busy,
  lastLang,
  hint,
  onPick
}: {
  busy: boolean
  /** The language last applied here, used only to mark it in the list. */
  lastLang?: string | null
  /** What this will do, in a sentence — the deck and the collection differ. */
  hint: string
  onPick: (lang: string) => void
}): React.ReactElement {
  const t = useT()
  const trigger = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        ref={trigger}
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        title={t('bulk.setLanguageHint')}
        data-action="setLanguage"
        className="field flex items-center gap-1.5 whitespace-nowrap text-xs text-ink-200
          disabled:opacity-50"
      >
        <Languages size={13} className={busy ? 'animate-pulse text-gold-400' : 'text-ink-500'} />
        {busy ? t('bulk.working') : t('bulk.setLanguage')}
      </button>

      <Popover open={open} onClose={() => setOpen(false)} trigger={trigger} width={196}>
        <p className="px-2 pb-1 pt-1.5 text-[10px] leading-relaxed text-ink-500">{hint}</p>
        <div className="max-h-64 overflow-y-auto">
          {LANGUAGES.map((lang) => (
            <button
              key={lang}
              onClick={() => {
                setOpen(false)
                onPick(lang)
              }}
              className={`flex w-full items-center rounded px-2 py-1 text-left text-xs
                transition-colors hover:bg-ink-750 ${
                  lastLang === lang ? 'text-gold-300' : 'text-ink-300'
                }`}
            >
              <span className="flex-1">{languageName(lang)}</span>
              <span className="text-[10px] uppercase text-ink-600">{lang}</span>
            </button>
          ))}
        </div>
      </Popover>
    </>
  )
}
