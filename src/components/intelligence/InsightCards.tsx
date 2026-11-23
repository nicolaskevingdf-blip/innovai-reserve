import { Link } from 'react-router-dom'
import { AlertTriangle, Lightbulb, TrendingUp, ChevronRight } from 'lucide-react'
import { useInsights } from '@/api/intelligence'
import { cn } from '@/lib/utils'
import type { Insight } from '@/types/db'

const TONE: Record<Insight['tone'], { icon: typeof Lightbulb; cls: string }> = {
  positive: { icon: TrendingUp, cls: 'border-lime/30 bg-lime/[0.05] text-lime' },
  warning: { icon: AlertTriangle, cls: 'border-amber-400/30 bg-amber-400/[0.06] text-amber-300' },
  info: { icon: Lightbulb, cls: 'border-sky-400/25 bg-sky-400/[0.05] text-sky-300' },
}

/** Rule-based recommendations computed in the database from real data (no AI). */
export function InsightCards({ tenantId, limit, compact }: { tenantId: string; limit?: number; compact?: boolean }) {
  const { data = [], isLoading } = useInsights(tenantId)
  if (isLoading) return <div className="grid gap-3 md:grid-cols-3">{[0, 1, 2].map((i) => <div key={i} className="skeleton h-24 rounded-2xl" />)}</div>
  const list = data.slice(0, limit ?? data.length)
  if (!list.length) return null
  return (
    <div className={cn('grid gap-3', compact ? 'md:grid-cols-3' : 'md:grid-cols-2 xl:grid-cols-3')}>
      {list.map((i) => {
        const t = TONE[i.tone]
        return (
          <div key={i.key} className={cn('flex gap-3 rounded-2xl border p-4', t.cls)}>
            <t.icon className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-ink-50">{i.title}</p>
              <p className={cn('mt-1 text-xs leading-relaxed text-ink-300', compact && 'line-clamp-3')}>{i.detail}</p>
              {i.action && (
                <Link to={i.action.to} className="mt-2 inline-flex items-center gap-0.5 text-xs font-semibold hover:underline">
                  {i.action.label} <ChevronRight className="h-3 w-3" />
                </Link>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
