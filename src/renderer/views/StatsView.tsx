import { useEffect, useState } from 'react'
import { motion } from 'motion/react'
import { BarChart3, Coins, RefreshCw } from 'lucide-react'
import type { Stats } from '@shared/types'
import { guard, useApp } from '../store/app'
import type { ViewProps } from '../App'
import { Button, EmptyState, LangChip } from '../components/primitives'
import { bigMoney, count, languageName, money, rarityName, relativeTime } from '../lib/format'
import { useT } from '../hooks/useT'
import SetIcon from '../components/SetIcon'

export default function StatsView({ active }: ViewProps): React.ReactElement {
  const t = useT()
  const dataVersion = useApp((s) => s.dataVersion)
  const invalidate = useApp((s) => s.invalidate)
  const toast = useApp((s) => s.toast)
  const setFilters = useApp((s) => s.setFilters)
  const setView = useApp((s) => s.setView)

  const [stats, setStats] = useState<Stats | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [filling, setFilling] = useState(false)

  // A hidden view must not query: with every visited view kept mounted, one
  // invalidate() would otherwise fan out into a request from each screen. The
  // effect still re-runs on becoming active, picking up anything missed.
  useEffect(() => {
    if (!active) return
    window.api.stats
      .get()
      .then(setStats)
      .catch((err) => toast('error', (err as Error).message))
  }, [active, dataVersion, toast])

  const refreshPrices = async (): Promise<void> => {
    setSyncing(true)
    const result = await guard(() => window.api.prices.refresh())
    setSyncing(false)
    if (result) {
      toast(
        result.unpriced ? 'warn' : 'success',
        `${t('stats.refreshed', {
          updated: count(result.updated),
          requested: count(result.requested)
        })}${
          result.unpriced
            ? t('stats.refreshedUnpriced', { count: count(result.unpriced) })
            : ''
        }`
      )
      invalidate()
    }
  }

  /*
    Filling in the prices Scryfall only publishes in English.

    The once-per-version run does this on its own; the button is for a first launch that was
    offline, and for anyone who would rather not wait for it.
  */
  const fillPrices = async (): Promise<void> => {
    setFilling(true)
    const result = await guard(() => window.api.prices.fill())
    setFilling(false)
    if (result) {
      toast(
        'success',
        result.requested === 0
          ? t('stats.filledNone')
          : t.p('stats.filled', result.requested, {
              filled: count(result.filled),
              requested: count(result.requested)
            })
      )
      invalidate()
    }
  }

  if (!stats) {
    return (
      <div className="flex-1 space-y-3 p-5">
        {Array.from({ length: 5 }).map((_, index) => (
          <div key={index} className="skeleton h-20 rounded-xl" />
        ))}
      </div>
    )
  }

  if (stats.totalCards === 0) {
    return (
      <EmptyState
        icon={<BarChart3 size={30} />}
        title={t('stats.emptyTitle')}
        hint={t('stats.emptyHint')}
      />
    )
  }

  const jumpToLang = (lang: string): void => {
    setFilters({ langs: [lang] })
    setView('collection')
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-3 px-5 pb-3 pt-4">
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold tracking-tight text-ink-50">{t('stats.title')}</h1>
          <p className="mt-0.5 text-xs text-ink-400">
            {t('stats.lastRefreshed', { when: relativeTime(stats.lastPriceSync) })}
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          icon={<Coins size={13} className={filling ? 'animate-pulse' : ''} />}
          onClick={() => void fillPrices()}
          disabled={filling || syncing}
        >
          {filling ? t('stats.filling') : t('stats.fillPrices')}
        </Button>
        <Button
          size="sm"
          icon={<RefreshCw size={13} className={syncing ? 'animate-spin' : ''} />}
          onClick={() => void refreshPrices()}
          disabled={syncing || filling}
        >
          {syncing ? t('stats.refreshing') : t('stats.refreshPrices')}
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Tile
            label={t('stats.totalCards')}
            value={count(stats.totalCards)}
            hint={
              stats.deckCards > 0
                ? t('stats.splitCards', {
                    bulk: count(stats.bulkCards),
                    deck: count(stats.deckCards)
                  })
                : undefined
            }
          />
          <Tile label={t('stats.distinctRows')} value={count(stats.distinctPrintings)} />
          <Tile
            label={t('stats.collectionValue')}
            value={bigMoney(stats.totalValue, stats.currency)}
            hint={
              stats.deckCards > 0
                ? t('stats.splitValue', {
                    bulk: bigMoney(stats.bulkValue, stats.currency),
                    deck: bigMoney(stats.deckValue, stats.currency)
                  })
                : undefined
            }
            accent
          />
          <Tile
            label={t('stats.looseVsDecks')}
            value={`${count(stats.notInDecks)} / ${count(stats.inDecks)}`}
            hint={t('stats.looseVsDecksHint')}
          />
        </div>

        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <Panel title={t('stats.byLanguage')} hint={t('stats.byLanguageHint')}>
            {stats.byLanguage.map((entry, index) => (
              <Bar
                key={entry.key}
                index={index}
                label={
                  <span className="flex items-center gap-2">
                    <LangChip lang={entry.key} />
                    <span className="text-ink-300">{languageName(entry.key)}</span>
                  </span>
                }
                count={entry.count}
                value={entry.value}
                max={Math.max(...stats.byLanguage.map((e) => e.count))}
                currency={stats.currency}
                onClick={() => jumpToLang(entry.key)}
              />
            ))}
          </Panel>

          <Panel title={t('stats.byRarity')}>
            {stats.byRarity.map((entry, index) => (
              <Bar
                key={entry.key}
                index={index}
                label={<span className="text-ink-300">{rarityName(entry.key)}</span>}
                count={entry.count}
                value={entry.value}
                max={Math.max(...stats.byRarity.map((e) => e.count))}
                currency={stats.currency}
                onClick={() => {
                  setFilters({ rarities: [entry.key as never] })
                  setView('collection')
                }}
              />
            ))}
          </Panel>

          <Panel title={t('stats.topSets')}>
            {stats.bySet.slice(0, 12).map((entry, index) => (
              <Bar
                key={entry.key}
                index={index}
                label={
                  <span
                    className="flex items-center gap-1.5 truncate text-ink-300"
                    title={entry.label}
                  >
                    <SetIcon code={entry.key} />
                    <span className="uppercase text-ink-200">{entry.key}</span> · {entry.label}
                  </span>
                }
                count={entry.count}
                value={entry.value}
                max={Math.max(...stats.bySet.map((e) => e.value))}
                useValueForBar
                currency={stats.currency}
                onClick={() => {
                  setFilters({ sets: [entry.key] })
                  setView('collection')
                }}
              />
            ))}
          </Panel>

          <Panel title={t('stats.topCards')}>
            <div className="space-y-1">
              {stats.topCards.map((card, index) => (
                <motion.div
                  key={card.scryfall_id}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.22, delay: index * 0.02 }}
                  className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-xs transition-colors hover:bg-ink-800"
                >
                  <span className="numeric w-6 shrink-0 text-ink-600">{index + 1}</span>
                  <LangChip lang={card.lang} />
                  <span className="min-w-0 flex-1 truncate text-ink-200">
                    {card.printed_name ?? card.name}
                  </span>
                  <span className="numeric shrink-0 text-ink-500">×{card.quantity}</span>
                  <span className="numeric w-16 shrink-0 text-right text-ink-400">
                    {money(card.unit_value, stats.currency)}
                  </span>
                  <span className="numeric w-18 shrink-0 text-right font-medium text-gold-400">
                    {money(card.total_value, stats.currency)}
                  </span>
                </motion.div>
              ))}
            </div>
          </Panel>
        </div>
      </div>
    </div>
  )
}

function Tile({
  label,
  value,
  hint,
  accent
}: {
  label: string
  value: string
  hint?: string
  accent?: boolean
}): React.ReactElement {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      className="panel px-4 py-3"
    >
      <p className={`numeric text-xl font-semibold ${accent ? 'text-gold-400' : 'text-ink-50'}`}>
        {value}
      </p>
      <p className="mt-1 text-[10px] uppercase tracking-wider text-ink-500">{label}</p>
      {hint && <p className="mt-0.5 text-[10px] leading-tight text-ink-600">{hint}</p>}
    </motion.div>
  )
}

function Panel({
  title,
  hint,
  children
}: {
  title: string
  hint?: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <section className="panel p-4">
      <h2 className="mb-3 flex items-baseline gap-2 text-xs font-semibold uppercase tracking-wider text-ink-400">
        {title}
        {hint && <span className="font-normal normal-case tracking-normal text-ink-600">{hint}</span>}
      </h2>
      <div className="space-y-0.5">{children}</div>
    </section>
  )
}

function Bar({
  label,
  count: quantity,
  value,
  max,
  currency,
  index,
  useValueForBar,
  onClick
}: {
  label: React.ReactNode
  count: number
  value: number
  max: number
  currency: 'usd' | 'eur'
  index: number
  useValueForBar?: boolean
  onClick?: () => void
}): React.ReactElement {
  const basis = useValueForBar ? value : quantity
  const pct = max > 0 ? (basis / max) * 100 : 0

  return (
    <button
      onClick={onClick}
      className="group relative block w-full overflow-hidden rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-ink-800"
    >
      <motion.span
        initial={{ width: 0 }}
        animate={{ width: `${pct}%` }}
        transition={{ duration: 0.55, delay: index * 0.03, ease: [0.25, 1, 0.5, 1] }}
        className="absolute inset-y-0 left-0 bg-gold-500/[0.09] group-hover:bg-gold-500/[0.16]"
      />
      <span className="relative flex items-center gap-2 text-xs">
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className="numeric shrink-0 text-ink-400">{count(quantity)}</span>
        <span className="numeric w-20 shrink-0 text-right text-gold-400">
          {bigMoney(value, currency)}
        </span>
      </span>
    </button>
  )
}
