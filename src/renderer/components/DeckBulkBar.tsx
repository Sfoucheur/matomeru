import { useRef, useState } from 'react'
import { motion } from 'motion/react'
import { ArrowRightLeft, Copy, Eraser, ListChecks, Sparkles, X } from 'lucide-react'
import { FINISHES, FOIL_TREATMENTS, type Finish } from '@shared/types'
import { FINISH_LABEL } from '../lib/format'
import { useT } from '../hooks/useT'
import Popover from './Popover'
import LanguagePicker from './LanguagePicker'
import { Button } from './primitives'

/**
 * Actions for the cards you have selected on the Decks screen.
 *
 * The language menu lives here, once, rather than on every row: a deck of 250
 * cards used to mount 250 popovers to offer the same list. Setting a language is
 * a decision about specific cards, so the control belongs next to the selection
 * count that says which ones.
 */
export default function DeckBulkBar({
  count,
  busy,
  lastLang,
  onSetLanguage,
  onSetFinish,
  onSetProxied,
  allProxied,
  onClearOverrides,
  onAddToList,
  onMoveToCollection,
  onClear
}: {
  count: number
  busy: boolean
  /** The language last applied to this deck, used only to mark the menu. */
  lastLang: string | null
  onSetLanguage: (lang: string) => void
  /** Null finish returns the cards to whatever Archidekt reported. */
  onSetFinish: (finish: Finish | null, treatment: string | null) => void
  onSetProxied: (proxied: boolean) => void
  /** True when every selected entry is already a proxy — flips the label. */
  allProxied: boolean
  onClearOverrides: () => void
  /** Opens the dialog that asks which list, and what happens to the copies. */
  onAddToList: () => void
  /** Moves the selection into the collection at once, with no list involved. */
  onMoveToCollection: () => void
  onClear: () => void
}): React.ReactElement {
  const t = useT()
  const [finishOpen, setFinishOpen] = useState(false)
  const finishRef = useRef<HTMLButtonElement>(null)

  return (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ duration: 0.18, ease: [0.25, 1, 0.5, 1] }}
      className="shrink-0 overflow-hidden border-b border-gold-500/25 bg-gold-500/[0.07]"
    >
      <div className="flex flex-wrap items-center gap-2 px-5 py-2 text-xs">
        <span className="text-ink-300">
          {t('common.selected', { count })}
        </span>

        {/*
          Taking cards out of the deck comes first: everything else here corrects
          what the deck *says* about a card, while these two change where it is.

          The direct move and the pick list are both offered because they answer
          different questions. Moving is the job itself, done now. A list is a batch
          of jobs to do later — and then the destination matters, because pulling a
          card to your box and pulling it to sell are not the same errand.
        */}
        <Button
          size="sm"
          icon={<ArrowRightLeft size={13} />}
          onClick={onMoveToCollection}
          disabled={busy}
          title={t('decks.moveToCollectionHint')}
        >
          {t('decks.moveToCollection')}
        </Button>
        <Button
          variant="primary"
          size="sm"
          icon={<ListChecks size={13} />}
          onClick={onAddToList}
          disabled={busy}
          data-action="addToList"
        >
          {t('coll.addToPickList')}
        </Button>

        <LanguagePicker
          busy={busy}
          lastLang={lastLang}
          hint={t('bulk.languageHint')}
          onPick={onSetLanguage}
        />

        <button
          ref={finishRef}
          onClick={() => setFinishOpen((v) => !v)}
          disabled={busy}
          title={t('bulk.setFinishHint')}
          className="field flex items-center gap-1.5 whitespace-nowrap text-xs text-ink-200 disabled:opacity-50"
        >
          <Sparkles size={13} className="text-ink-500" />
          {t('bulk.setFinish')}
        </button>

        {/* One button, not a pair: a proxy is a yes/no fact, so the label follows
            the selection. A proxy fills the slot, which is how a deck reads
            complete without you owning the card. */}
        <Button
          size="sm"
          icon={<Copy size={13} />}
          onClick={() => onSetProxied(!allProxied)}
          disabled={busy}
          title={t('proxy.hint')}
        >
          {allProxied ? t('proxy.unmark') : t('proxy.mark')}
        </Button>

        <Button size="sm" icon={<Eraser size={13} />} onClick={onClearOverrides} disabled={busy}>
          {t('bulk.clearOverride')}
        </Button>

        <button
          onClick={onClear}
          className="ml-auto flex items-center gap-1 text-[11px] text-ink-400 transition-colors hover:text-ink-100"
        >
          <X size={12} />
          {t('common.clearSelection')}
        </button>
      </div>

      <Popover
        open={finishOpen}
        onClose={() => setFinishOpen(false)}
        trigger={finishRef}
        width={206}
      >
        <p className="px-2 pb-1 pt-1.5 text-[10px] leading-relaxed text-ink-500">
          {t('bulk.finishHint')}
        </p>
        {FINISHES.map((finish) => (
          <button
            key={finish}
            onClick={() => {
              setFinishOpen(false)
              onSetFinish(finish, null)
            }}
            className="flex w-full rounded px-2 py-1 text-left text-xs text-ink-300
              transition-colors hover:bg-ink-750"
          >
            {FINISH_LABEL[finish]}
          </button>
        ))}
        <p className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-ink-500">
          {t('filters.treatment')}
        </p>
        {/* A foil type implies the copies are foil, so it sets both at once —
            otherwise you would have to pick Foil first and come back. */}
        {FOIL_TREATMENTS.map((tr) => (
          <button
            key={tr.tag}
            onClick={() => {
              setFinishOpen(false)
              onSetFinish('foil', tr.tag)
            }}
            className="flex w-full rounded px-2 py-1 text-left text-xs text-ink-300
              transition-colors hover:bg-ink-750"
          >
            {tr.label}
          </button>
        ))}
        <button
          onClick={() => {
            setFinishOpen(false)
            onSetFinish(null, null)
          }}
          className="mt-1 w-full rounded px-2 py-1.5 text-left text-xs text-ink-400
            transition-colors hover:bg-ink-750 hover:text-ink-200"
        >
          {t('bulk.finishFromArchidekt')}
        </button>
      </Popover>

    </motion.div>
  )
}
