import { useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import type { PickDestination, PickList } from '@shared/types'
import { useT } from '../hooks/useT'
import { Button, Modal, QuantityStepper } from './primitives'
import { count } from '../lib/format'
import CopyPicker from './CopyPicker'

/**
 * Asks everything a pull needs to know: what happens to the copies, and which list
 * they go on.
 *
 * Both questions in one dialog, opened by the action itself. They used to be a
 * dropdown parked in the selection header beside a separate button — two controls
 * for one decision, and a dropdown that sits there permanently reads as a setting
 * rather than as part of what you are about to do.
 *
 * The list is a radio group rather than click-to-pick because there are now two
 * answers to give and one confirm has to apply both. No list is preselected:
 * silently reusing whichever was open last is exactly the behaviour this control
 * was built to replace.
 *
 * A single card also gets asked how many, and which of your copies. Both questions only
 * make sense one card at a time -- twenty rows of steppers is a spreadsheet, not a
 * dialog -- so a multi-card selection stages one copy of each and is tuned afterwards
 * in the list itself, where the cards are visible side by side.
 */
export default function AddToListDialog({
  showDestination,
  subject,
  onCancel,
  onConfirm
}: {
  /**
   * Whether to offer the destination at all.
   *
   * Only meaningful when the selection contains deck cards. A collection row has
   * one possible answer — it leaves your possession, which is what a pick list is
   * for — so offering the choice there would be offering a decision that does not
   * exist.
   */
  showDestination: boolean
  /**
   * The one card being staged, when there is only one.
   *
   * Absent for a multi-card selection, which stages a copy of each: the quantity and
   * copy controls are hidden entirely rather than shown applying to everything at once,
   * which would mean "4 of each of these twenty cards".
   */
  subject?: {
    /** The printing on screen, so the copy list can span the card's other printings. */
    scryfallId: string
    /** The copy staged unless another is chosen. Null for a card coming out of a deck. */
    collectionItemId: number | null
    /** Most copies the current source can supply. */
    max: number
  }
  onCancel: () => void
  onConfirm: (
    target: number | 'new',
    destination: PickDestination,
    choice: { quantity: number; collectionItemId: number | null }
  ) => void
}): React.ReactElement {
  const t = useT()
  const [lists, setLists] = useState<PickList[] | null>(null)
  const [target, setTarget] = useState<number | 'new' | null>(null)
  /*
    Off by default, so confirming without touching anything does the harmless
    thing: the copies come out of the deck and stay yours. Ticking it is the option
    that loses the card.
  */
  const [alsoRemove, setAlsoRemove] = useState(false)
  const [quantity, setQuantity] = useState(1)
  /*
    Which copy, tracked separately from the subject so choosing one can raise the cap:
    a different row of yours may have more free than the one you started on.
  */
  const [copyId, setCopyId] = useState<number | null>(subject?.collectionItemId ?? null)
  const [copyMax, setCopyMax] = useState(subject?.max ?? 1)

  useEffect(() => {
    void window.api.pickLists
      .list()
      // Only open lists can receive cards — `addToPickList` refuses a confirmed or
      // cancelled one — so offering them would be offering an error.
      .then((all) => {
        const open = all.filter((list) => list.status === 'open')
        setLists(open)
        // 'new' when there is nothing to choose from, so the dialog is never a
        // dead end; still no *list* preselected when there are several.
        if (open.length === 0) setTarget('new')
      })
      .catch(() => {
        setLists([])
        setTarget('new')
      })
  }, [])

  const confirm = (): void => {
    if (target === null) return
    onConfirm(target, showDestination && alsoRemove ? 'gone' : 'collection', {
      // One of each when several cards are going on at once; see the docstring.
      quantity: subject ? Math.min(quantity, copyMax) : 1,
      collectionItemId: copyId
    })
  }

  return (
    <Modal open onClose={onCancel} title={t('coll.addToPickList')} width="max-w-md">
      <div className="px-5 py-4">
        {showDestination && (
          <label
            className="mb-4 flex items-start gap-2.5 rounded-lg border border-ink-700 bg-ink-800 p-3"
            data-field="alsoRemove"
          >
            <input
              type="checkbox"
              checked={alsoRemove}
              onChange={(e) => setAlsoRemove(e.target.checked)}
              className="mt-0.5 shrink-0 accent-gold-500"
            />
            <span className="text-sm text-ink-200">
              {t('coll.alsoRemove')}
              <span className="mt-0.5 block text-[11px] leading-relaxed text-ink-500">
                {t('coll.alsoRemoveHint')}
              </span>
            </span>
          </label>
        )}

        {subject && (
          <div className="mb-4 space-y-3">
            <label className="flex items-center gap-2.5 text-[11px] text-ink-400">
              {t('picks.quantityToStage')}
              <QuantityStepper
                value={quantity}
                min={1}
                max={Math.max(1, copyMax)}
                size="sm"
                onChange={setQuantity}
              />
            </label>

            {/*
              Only when the copies are yours to choose between. A card coming out of a
              deck is the printing that deck holds, and changing that is a deck edit,
              not a decision about this list.
            */}
            {subject.collectionItemId !== null ? (
              <div>
                <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-ink-500">
                  {t('copies.title')}
                </p>
                <CopyPicker
                  scryfallId={subject.scryfallId}
                  selected={copyId}
                  needed={quantity}
                  onChoose={(copy) => {
                    setCopyId(copy.collection_item_id)
                    const free = copy.quantity - copy.reserved
                    setCopyMax(free)
                    // Never leave the stepper above what the copy just chosen can give.
                    setQuantity((current) => Math.min(current, Math.max(1, free)))
                  }}
                />
              </div>
            ) : (
              <p className="text-[11px] text-ink-500">
                {t('picks.stagingFrom')}: {t('picks.fromDeck')}
              </p>
            )}
          </div>
        )}

        <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-ink-500">
          {t('coll.chooseList')}
        </p>

        {lists === null ? (
          <div className="space-y-1.5">
            {Array.from({ length: 2 }).map((_, index) => (
              <div key={index} className="skeleton h-9 rounded-lg" />
            ))}
          </div>
        ) : (
          <div className="flex flex-col gap-1.5" role="radiogroup">
            {/* Say why there is nothing to choose from, rather than showing a lone
                "New list" option and leaving it to be inferred. */}
            {lists.length === 0 && (
              <p className="text-[11px] leading-relaxed text-ink-500">
                {t('coll.noOpenLists')}
              </p>
            )}
            {lists.map((list) => (
              <label
                key={list.id}
                className={`flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2
                  transition-colors ${
                    target === list.id
                      ? 'border-gold-500 bg-ink-750'
                      : 'border-ink-700 hover:border-ink-600 hover:bg-ink-800'
                  }`}
              >
                <input
                  type="radio"
                  name="pick-list"
                  checked={target === list.id}
                  onChange={() => setTarget(list.id)}
                  className="shrink-0 accent-gold-500"
                />
                <span className="min-w-0 flex-1 truncate text-sm text-ink-100">{list.name}</span>
                <span className="numeric shrink-0 text-[10px] text-ink-500">
                  {t('coll.listCards', { count: count(list.cardCount) })}
                </span>
              </label>
            ))}

            <label
              className={`flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2
                transition-colors ${
                  target === 'new'
                    ? 'border-gold-500 bg-ink-750'
                    : 'border-ink-700 hover:border-ink-600 hover:bg-ink-800'
                }`}
            >
              <input
                type="radio"
                name="pick-list"
                checked={target === 'new'}
                onChange={() => setTarget('new')}
                className="shrink-0 accent-gold-500"
              />
              <Plus size={13} className="shrink-0 text-gold-300" />
              <span className="flex-1 text-sm text-gold-300">{t('coll.newList')}</span>
            </label>
          </div>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <Button size="sm" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={target === null}
            onClick={confirm}
            data-action="confirmAddToList"
          >
            {t('coll.addToPickList')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
