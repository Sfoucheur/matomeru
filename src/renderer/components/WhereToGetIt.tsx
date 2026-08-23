import { useEffect, useState } from 'react'
import { Package2, PackageOpen, RefreshCw } from 'lucide-react'
import type { BoosterChance, BoosterOdds } from '@shared/types'
import { guard, useApp } from '../store/app'
import { count, percent } from '../lib/format'
import { useT } from '../hooks/useT'

/**
 * The chance of pulling this card from each of its set's boosters.
 *
 * Computed from MTGJSON's actual booster recipes — weighted sheets and pack
 * configurations — rather than guessed from rarity, which is why a card can
 * legitimately read "not in this booster" for one type and 8% for another.
 *
 * Three states, because they are three different answers:
 *
 *  - the real per-booster figures, which always win.
 *  - in boosters, chance not computed — Scryfall's flag says it is a booster
 *    card; the set's recipes have never been downloaded. This used to be
 *    indistinguishable from the case below, which is why the panel seemed to know
 *    nothing about most of a collection.
 *  - not listed as a booster card. Deliberately phrased weakly, and the fetch
 *    stays on offer: Scryfall sets the flag on the *default* printing, so 14 of
 *    the 32 printings with real odds in this collection have it false — a
 *    showcase Jenova reads `booster: false` and is still 2.5% of a collector
 *    booster.
 *
 * The odds themselves resolve through the card's English printing, because that
 * is what MTGJSON's ids name; a French card matched nothing before that and read
 * "not in this booster", which was false.
 */
export default function WhereToGetIt({
  scryfallId,
  setCode,
  setName
}: {
  scryfallId: string
  setCode: string
  setName: string
}): React.ReactElement {
  const t = useT()
  const toast = useApp((s) => s.toast)
  const [odds, setOdds] = useState<BoosterOdds | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let live = true
    window.api.boosters
      .forCard(scryfallId, setCode)
      .then((result) => {
        if (live) setOdds(result)
      })
      .catch(() => {
        if (live) setOdds(null)
      })
    return () => {
      live = false
    }
  }, [scryfallId, setCode])

  const load = async (): Promise<void> => {
    setLoading(true)
    const result = await guard(() => window.api.boosters.load(setCode))
    if (result) {
      toast(
        'success',
        t('boosters.loaded', {
          boosters: result.boosters,
          cards: count(result.cards),
          set: setCode.toUpperCase()
        })
      )
      setOdds(await window.api.boosters.forCard(scryfallId, setCode))
    }
    setLoading(false)
  }

  const header = (
    <h4 className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-500">
      <PackageOpen size={10} />
      {t('boosters.title')}
      <span className="font-normal normal-case tracking-normal text-ink-600">{setName}</span>
    </h4>
  )

  if (!odds?.fetched) {
    return (
      <div className="space-y-2">
        {header}
        {/*
          What can be said without any download. A true flag is trustworthy; a
          false one only means this printing is not the default booster version,
          so it never suppresses the button.
        */}
        {odds?.in_boosters === true ? (
          <p className="text-[11px] leading-relaxed text-gold-300/90">
            {t('boosters.isInBoosters')}
          </p>
        ) : (
          odds?.in_boosters === false && (
            <p className="text-[11px] leading-relaxed text-ink-500">{t('boosters.notListed')}</p>
          )
        )}
        <button
          onClick={() => void load()}
          disabled={loading}
          title={t('boosters.loadHint')}
          className="field flex w-full items-center justify-center gap-2 text-xs text-ink-300"
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          {loading
            ? t('boosters.loading', { set: setCode.toUpperCase() })
            : t('boosters.load', { set: setCode.toUpperCase() })}
        </button>
      </div>
    )
  }

  if (odds.boosters.length === 0) {
    return (
      <div className="space-y-2">
        {header}
        <p className="text-[11px] leading-relaxed text-ink-500">
          {t('boosters.noData', { set: setCode.toUpperCase() })}
        </p>
      </div>
    )
  }

  /** The best chance in either finish — used only to decide what to show. */
  const bestOf = (booster: BoosterOdds['boosters'][number]): number =>
    Math.max(booster.nonfoil?.probability ?? 0, booster.foil?.probability ?? 0)
  const inSomething = odds.boosters.some((booster) => bestOf(booster) > 0)

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        {header}
        <button
          onClick={() => void load()}
          disabled={loading}
          title={t('boosters.refresh')}
          className="ml-auto rounded p-1 text-ink-500 transition-colors hover:bg-ink-800 hover:text-ink-200"
        >
          <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      <div className="space-y-1">
        {odds.boosters.map((booster) => (
          <div
            key={booster.code}
            className="flex items-center gap-2 rounded-lg border border-ink-800 bg-ink-850 px-2.5 py-1.5"
          >
            <Package2 size={12} className="shrink-0 text-ink-500" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[11px] text-ink-100">{booster.name}</span>
              <span className="block text-[10px] text-ink-600">
                {t('boosters.cardsPerPack', { count: booster.cardsPerPack })}
                {booster.coverage > 0 && booster.coverage < 0.95 && (
                  <span title={t('boosters.partialHint')}> · {t('boosters.partial')}</span>
                )}
              </span>
            </span>
            {booster.coverage === 0 ? (
              // Every card on this booster's sheets belongs to another set, so we
              // have nothing to say about it. Printing 0% here would claim the
              // card cannot be pulled from it, which is not what the data shows.
              <span className="shrink-0 text-[10px] text-ink-600">
                {t('boosters.notCovered')}
              </span>
            ) : bestOf(booster) > 0 ? (
              <span className="shrink-0 space-y-0.5 text-right">
                {/*
                  One line per finish the printing is actually sold in. Split
                  because the sheets are: the same card is often an order of
                  magnitude rarer in foil, and a single blended figure told a
                  collector the opposite of the truth.
                */}
                <Chance label={t('finish.nonfoil')} chance={booster.nonfoil} />
                <Chance label={t('finish.foil')} chance={booster.foil} foil />
              </span>
            ) : (
              <span className="shrink-0 text-[10px] text-ink-600">
                {/*
                  No sheet lists this card. When Scryfall says it is a booster
                  card anyway, the honest reading is that this set's recipes do
                  not cover it — not that it cannot be pulled.
                */}
                {t('boosters.notInBooster')}
              </span>
            )}
          </div>
        ))}
      </div>

      {/* Sealed products, whose chance follows from the pack's: 1 − (1 − p)^packs. */}
      {inSomething && odds.products.length > 0 && (
        <div className="space-y-1">
          <h5 className="text-[10px] font-semibold uppercase tracking-wider text-ink-600">
            {t('boosters.products')}
          </h5>
          {odds.products.slice(0, 6).map((product) => {
            const booster = odds.boosters.find((b) => b.code === product.booster)
            // A sealed product's headline chance follows the nonfoil version when
            // there is one — it is the common case and the larger number — and
            // the foil version when that is all the printing comes in.
            const per = booster
              ? (booster.nonfoil?.probability ?? booster.foil?.probability ?? 0)
              : 0
            if (per <= 0) return null
            const chance = 1 - Math.pow(1 - per, product.boosterCount)
            return (
              <div
                key={product.name}
                className="flex items-center gap-2 px-1 text-[11px] text-ink-400"
              >
                <span className="min-w-0 flex-1 truncate">{product.name}</span>
                <span className="numeric shrink-0 text-gold-300">
                  {t('boosters.productChance', {
                    count: product.boosterCount,
                    percent: percent(chance)
                  })}
                </span>
              </div>
            )
          })}
        </div>
      )}

      <p className="text-[10px] leading-relaxed text-ink-600">
        {t('boosters.source')}
        {odds.via_english && ` ${t('boosters.viaEnglish')}`}
      </p>
    </div>
  )
}

/**
 * One finish's chance, or nothing when the printing does not come in it.
 *
 * A null chance is not 0%: a foil-only surge printing has no nonfoil version to
 * pull, and printing "nonfoil 0%" beside it would invent one.
 */
function Chance({
  label,
  chance,
  foil
}: {
  label: string
  chance: BoosterChance | null
  foil?: boolean
}): React.ReactElement | null {
  const t = useT()
  if (!chance) return null
  return (
    <span
      className="flex items-baseline justify-end gap-1.5 whitespace-nowrap"
      title={chance.approximate ? t('boosters.approximate') : undefined}
    >
      <span className="text-[9px] uppercase tracking-wide text-ink-600">{label}</span>
      {chance.probability > 0 ? (
        <>
          <span className={`numeric text-xs ${foil ? 'text-gold-200' : 'text-gold-300'}`}>
            {chance.approximate && '≈ '}
            {percent(chance.probability)}
          </span>
          <span className="numeric text-[10px] text-ink-500">
            {chance.probability < 0.5
              ? t('boosters.oneIn', { count: Math.round(1 / chance.probability) })
              : t('boosters.expected', {
                  count: (Math.round(chance.expected * 100) / 100).toString()
                })}
          </span>
        </>
      ) : (
        <span className="text-[10px] text-ink-700">—</span>
      )}
    </span>
  )
}
