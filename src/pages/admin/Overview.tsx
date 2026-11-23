import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Building2, CalendarCheck2, CreditCard, LifeBuoy, Timer, TrendingUp } from 'lucide-react'
import { SUB_STATUS, useAdminOverview } from '@/api/saas'
import { Card, CardHeader, PageLoader } from '@/components/ui/ui'
import { SEGMENT } from '@/lib/constants'
import { cn, formatMoney } from '@/lib/utils'
import type { Segment, SubscriptionStatus } from '@/types/db'

export default function AdminOverviewPage() {
  const { data: o, isLoading } = useAdminOverview()
  if (isLoading || !o) return <PageLoader />
  const kpis = [
    { label: 'MRR (assinaturas ativas)', value: formatMoney(o.mrr_cents), icon: TrendingUp, accent: true },
    { label: 'Estabelecimentos', value: o.tenants, sub: `${o.tenants_active} ativos · ${o.tenants_suspended} suspensos`, icon: Building2 },
    { label: 'Novos (30 dias)', value: o.new_tenants_30d, icon: CreditCard },
    { label: 'Testes terminando (7 dias)', value: o.trials_ending_7d, icon: Timer },
    { label: 'Reservas (30 dias)', value: o.reservations_30d, sub: o.online_share_30d != null ? `${o.online_share_30d}% online` : undefined, icon: CalendarCheck2 },
    { label: 'Chamados abertos', value: o.open_tickets, icon: LifeBuoy },
  ]
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold md:text-3xl">Visão geral da plataforma</h1>
        <p className="mt-1 text-sm text-ink-400">Métricas de todos os clientes Innovai Reserve.</p>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 2xl:grid-cols-6">
        {kpis.map((k) => (
          <Card key={k.label} className={cn('p-4', k.accent && 'border-lime/30 bg-gradient-to-br from-lime/[0.12] to-ink-900')}>
            <k.icon className={cn('h-4 w-4', k.accent ? 'text-lime' : 'text-ink-400')} />
            <p className={cn('mt-3 font-display text-2xl font-bold tabular-nums', k.accent && 'text-lime')}>{k.value}</p>
            <p className="mt-0.5 text-xs text-ink-400">{k.label}</p>
            {k.sub && <p className="text-[11px] text-ink-500">{k.sub}</p>}
          </Card>
        ))}
      </div>
      <div className="grid gap-6 xl:grid-cols-[1.4fr_1fr]">
        <Card>
          <CardHeader title="Novos estabelecimentos por mês" subtitle="Últimos 12 meses" />
          <div className="h-[240px] px-2 pb-3 pt-4">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={o.signups_by_month} margin={{ left: -24, right: 8 }}>
                <CartesianGrid stroke="#1E1E22" vertical={false} />
                <XAxis dataKey="month" tick={{ fill: '#6C6C76', fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis allowDecimals={false} tick={{ fill: '#6C6C76', fontSize: 11 }} axisLine={false} tickLine={false} />
                <Tooltip cursor={{ fill: 'rgba(255,255,255,0.03)' }} contentStyle={{ background: '#151519', border: '1px solid #2C2C33', borderRadius: 12 }} />
                <Bar dataKey="count" name="Novos" fill="#C6F432" radius={[6, 6, 2, 2]} maxBarSize={32} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
        <div className="space-y-6">
          <Card>
            <CardHeader title="Assinaturas" />
            <div className="flex flex-wrap gap-2 p-5">
              {Object.entries(o.by_status).map(([s, c]) => (
                <span key={s} className={cn('chip px-3 py-1', SUB_STATUS[s as SubscriptionStatus]?.chip)}>{SUB_STATUS[s as SubscriptionStatus]?.label ?? s} <b>{c}</b></span>
              ))}
            </div>
          </Card>
          <Card>
            <CardHeader title="Por plano e segmento" />
            <div className="grid grid-cols-2 gap-4 p-5 text-sm">
              <ul className="space-y-1.5">{o.by_plan.map((p) => <li key={p.plan} className="flex justify-between"><span className="text-ink-300">{p.plan}</span><b>{p.count}</b></li>)}</ul>
              <ul className="space-y-1.5">{Object.entries(o.by_segment).map(([s, c]) => <li key={s} className="flex justify-between"><span className="text-ink-300">{SEGMENT[s as Segment]?.label ?? s}</span><b>{c}</b></li>)}</ul>
            </div>
          </Card>
        </div>
      </div>
    </div>
  )
}
