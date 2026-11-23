import { Check, Crown, Minus } from 'lucide-react'
import { useCurrentTenant } from '@/hooks/useTenant'
import { usePlans, useSubscription } from '@/api/tenant'
import { Card, PageLoader } from '@/components/ui/ui'
import { fmt } from '@/lib/datetime'
import { cn, formatMoney } from '@/lib/utils'

const FEATURE_LABEL: Record<string, string> = {
  public_page: 'Página pública de reservas', crm: 'CRM de clientes', tables_map: 'Mapa de mesas / profissionais',
  whatsapp: 'Automação por WhatsApp', reports_advanced: 'Relatórios avançados', ai_insights: 'Insights com IA',
}
const SUB_STATUS: Record<string, string> = { trialing: 'Período de teste', active: 'Ativa', past_due: 'Pagamento pendente', cancelled: 'Cancelada', suspended: 'Suspensa' }

export default function Plan() {
  const { tenant } = useCurrentTenant()
  const { data: sub, isLoading } = useSubscription(tenant.id)
  const { data: plans = [] } = usePlans()
  if (isLoading) return <PageLoader />
  const currentId = sub?.plan_id ?? tenant.plan_id

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold md:text-3xl">Meu plano</h1>
        <p className="mt-1 text-sm text-ink-400">Assinatura gerenciada pela Innovai.</p>
      </div>
      {sub && (
        <Card className="relative overflow-hidden p-6">
          <div className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-lime/10 blur-3xl" />
          <div className="flex flex-wrap items-center gap-4">
            <div className="grid h-12 w-12 place-items-center rounded-2xl bg-lime text-ink-950"><Crown className="h-6 w-6" /></div>
            <div className="flex-1">
              <p className="text-sm text-ink-400">Plano atual</p>
              <p className="font-display text-2xl font-bold">{sub.plan?.name}</p>
            </div>
            <div className="text-right">
              <span className={cn('chip', sub.status === 'active' || sub.status === 'trialing' ? 'border-lime/30 bg-lime/10 text-lime' : 'border-rose-400/30 bg-rose-400/10 text-rose-300')}>{SUB_STATUS[sub.status]}</span>
              {sub.status === 'trialing' && sub.trial_ends_at && <p className="mt-1.5 text-xs text-ink-400">Teste até {fmt(sub.trial_ends_at, tenant.timezone, 'dd/MM/yyyy')}</p>}
              {sub.status === 'active' && sub.current_period_end && <p className="mt-1.5 text-xs text-ink-400">Renova em {fmt(sub.current_period_end, tenant.timezone, 'dd/MM/yyyy')}</p>}
            </div>
          </div>
        </Card>
      )}
      <div className="grid gap-4 lg:grid-cols-3">
        {plans.map((p) => {
          const current = p.id === currentId
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
                {Object.entries(FEATURE_LABEL).map(([k, label]) => (
                  <li key={k} className={cn('flex gap-2', p.features[k] ? 'text-ink-200' : 'text-ink-500')}>
                    {p.features[k] ? <Check className="h-4 w-4 text-lime" /> : <Minus className="h-4 w-4" />} {label}
                  </li>
                ))}
              </ul>
              {!current && <p className="mt-6 rounded-xl border border-ink-700 py-2.5 text-center text-xs text-ink-400">Para mudar de plano, fale com a Innovai</p>}
            </Card>
          )
        })}
      </div>
      <p className="text-xs text-ink-500">Cobrança recorrente automática (Stripe / Asaas / Pagar.me) é parte da Fase 4 e requer configuração do provedor de pagamentos.</p>
    </div>
  )
}
