import { useState } from 'react'
import { Check, Crown, Minus, AlertTriangle } from 'lucide-react'
import { useCurrentTenant } from '@/hooks/useTenant'
import { usePlans } from '@/api/tenant'
import { FEATURES, LIMITS, SUB_STATUS, usePlanUsage } from '@/api/saas'
import { Button, Card, PageLoader } from '@/components/ui/ui'
import { fmt } from '@/lib/datetime'
import { cn, formatMoney } from '@/lib/utils'
import { NewTicket } from './Support'

export default function Plan() {
  const { tenant, isManager } = useCurrentTenant()
  const { data: u, isLoading } = usePlanUsage(tenant.id)
  const { data: plans = [] } = usePlans()
  const [upgrade, setUpgrade] = useState<string | null>(null)
  if (isLoading || !u) return <PageLoader />
  const sub = u.subscription
  const tz = tenant.timezone
  const trialDays = sub?.status === 'trialing' && sub.trial_ends_at ? Math.ceil((+new Date(sub.trial_ends_at) - Date.now()) / 864e5) : null

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold md:text-3xl">Meu plano</h1>
        <p className="mt-1 text-sm text-ink-400">Assinatura gerenciada pela Innovai.</p>
      </div>

      {!u.subscription_ok && (
        <div className="flex items-start gap-3 rounded-2xl border border-rose-400/30 bg-rose-400/10 px-4 py-3 text-sm text-rose-100">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          Reservas online pausadas: {sub?.status === 'trialing' ? 'o período de teste terminou' : 'há uma pendência na assinatura'}. Fale com a Innovai para reativar.
        </div>
      )}

      <Card className="relative overflow-hidden p-6">
        <div className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-lime/10 blur-3xl" />
        <div className="flex flex-wrap items-center gap-4">
          <div className="grid h-12 w-12 place-items-center rounded-2xl bg-lime text-ink-950"><Crown className="h-6 w-6" /></div>
          <div className="flex-1">
            <p className="text-sm text-ink-400">Plano atual</p>
            <p className="font-display text-2xl font-bold">{u.plan?.name ?? '—'}</p>
          </div>
          {sub && (
            <div className="text-right">
              <span className={cn('chip', SUB_STATUS[sub.status].chip)}>{SUB_STATUS[sub.status].label}</span>
              {trialDays != null && <p className="mt-1.5 text-xs text-ink-400">{trialDays > 0 ? `${trialDays} dia(s) restantes de teste` : 'Teste encerrado'} · até {fmt(sub.trial_ends_at!, tz, 'dd/MM/yyyy')}</p>}
              {sub.status === 'active' && sub.current_period_end && <p className="mt-1.5 text-xs text-ink-400">Renova em {fmt(sub.current_period_end, tz, 'dd/MM/yyyy')}</p>}
            </div>
          )}
        </div>
        <div className="mt-6 grid gap-4 sm:grid-cols-3">
          {Object.entries(LIMITS).map(([k, label]) => {
            const used = k === 'max_members' ? u.usage.members : k === 'max_reservations_month' ? u.usage.reservations_month : u.usage.resources
            const limit = u.limits[k]
            const pctUsed = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0
            return (
              <div key={k} className="rounded-xl border border-ink-700 bg-ink-850 p-4">
                <p className="text-xs text-ink-400">{label}{k === 'max_reservations_month' ? ' (este mês)' : ''}</p>
                <p className="mt-1 font-display text-xl font-bold tabular-nums">{used}<span className="text-sm font-normal text-ink-500"> / {limit ?? '∞'}</span></p>
                {limit != null && (
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-ink-700">
                    <div className={cn('h-full rounded-full', pctUsed >= 90 ? 'bg-rose-400' : pctUsed >= 70 ? 'bg-amber-400' : 'bg-lime')} style={{ width: `${pctUsed}%` }} />
                  </div>
                )}
              </div>
            )
          })}
        </div>
        <div className="mt-5 flex flex-wrap gap-2">
          {Object.entries(FEATURES).map(([k, label]) => (
            <span key={k} className={cn('chip', u.features[k] ? 'border-lime/30 bg-lime/10 text-lime' : 'border-ink-700 text-ink-500')}>
              {u.features[k] ? <Check className="h-3 w-3" /> : <Minus className="h-3 w-3" />} {label}
            </span>
          ))}
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        {plans.map((p) => {
          const current = p.id === u.plan?.id
          return (
            <Card key={p.id} className={cn('flex flex-col p-6', current && 'border-lime/50 shadow-glow')}>
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-bold">{p.name}</h3>
                {current && <span className="chip border-lime/30 bg-lime/10 text-lime">Atual</span>}
              </div>
              <p className="mt-1 text-sm text-ink-400">{p.description}</p>
              <p className="mt-5 font-display text-3xl font-extrabold">{formatMoney(p.price_cents)}<span className="text-sm font-medium text-ink-400">/mês</span></p>
              <ul className="mt-5 flex-1 space-y-2.5 text-sm">
                <li className="flex gap-2 text-ink-200"><Check className="h-4 w-4 text-lime" /> Até {p.limits.max_members ?? '∞'} usuários</li>
                <li className="flex gap-2 text-ink-200"><Check className="h-4 w-4 text-lime" /> {p.limits.max_reservations_month ? `${p.limits.max_reservations_month} reservas/mês` : 'Reservas ilimitadas'}</li>
                <li className="flex gap-2 text-ink-200"><Check className="h-4 w-4 text-lime" /> Até {p.limits.max_resources ?? '∞'} mesas/profissionais</li>
                {Object.entries(FEATURES).map(([k, label]) => (
                  <li key={k} className={cn('flex gap-2', p.features[k] ? 'text-ink-200' : 'text-ink-500')}>
                    {p.features[k] ? <Check className="h-4 w-4 text-lime" /> : <Minus className="h-4 w-4" />} {label}
                  </li>
                ))}
              </ul>
              {!current && isManager && (
                <Button variant="secondary" className="mt-6" onClick={() => setUpgrade(p.name)}>Solicitar {p.price_cents > (u.plan?.price_cents ?? 0) ? 'upgrade' : 'mudança'}</Button>
              )}
            </Card>
          )
        })}
      </div>
      <p className="text-xs text-ink-500">Mudanças de plano são feitas pela equipe Innovai. A cobrança automática depende da configuração do provedor de pagamentos.</p>
      {upgrade && (
        <NewTicket open onClose={() => setUpgrade(null)} defaults={{
          subject: `Mudança para o plano ${upgrade}`, category: 'upgrade',
          body: `Olá! Gostaria de mudar o plano do ${tenant.name} para o ${upgrade}.`,
        }} />
      )}
    </div>
  )
}
