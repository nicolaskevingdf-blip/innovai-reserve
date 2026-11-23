import { useEffect, useState } from 'react'
import { FEATURES, LIMITS, useAdminMutations, useAllPlans } from '@/api/saas'
import { Button, Card, Field, Input, PageLoader, Switch, Textarea } from '@/components/ui/ui'
import { useToast } from '@/components/ui/Toast'
import { errorMessage } from '@/lib/errors'
import type { Plan } from '@/types/db'

export default function AdminPlans() {
  const { data: plans = [], isLoading } = useAllPlans()
  if (isLoading) return <PageLoader />
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold md:text-3xl">Planos</h1>
        <p className="mt-1 text-sm text-ink-400">Preço, limites e funcionalidades. Alterações valem imediatamente para todos os clientes do plano (o banco aplica os limites).</p>
      </div>
      <div className="grid gap-4 xl:grid-cols-3">{plans.map((p) => <PlanEditor key={p.id} plan={p} />)}</div>
    </div>
  )
}

function PlanEditor({ plan }: { plan: Plan & { is_active: boolean } }) {
  const toast = useToast()
  const { savePlan } = useAdminMutations()
  const [p, setP] = useState(plan)
  const [price, setPrice] = useState(String(plan.price_cents / 100))
  useEffect(() => { setP(plan); setPrice(String(plan.price_cents / 100)) }, [plan])
  const save = async () => {
    try {
      await savePlan.mutateAsync({ id: p.id, name: p.name, description: p.description, price_cents: Math.round(Number(price.replace(',', '.')) * 100), limits: p.limits, features: p.features, is_active: p.is_active })
      toast('success', `Plano ${p.name} salvo`)
    } catch (e) { toast('error', 'Erro', errorMessage(e)) }
  }
  return (
    <Card className="space-y-4 p-5">
      <div className="flex items-center justify-between"><p className="font-mono text-xs text-ink-500">{p.code}</p><Switch checked={p.is_active} onChange={(v) => setP({ ...p, is_active: v })} label="À venda" /></div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Nome"><Input value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} /></Field>
        <Field label="Preço (R$/mês)"><Input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" /></Field>
      </div>
      <Field label="Descrição"><Textarea value={p.description ?? ''} onChange={(e) => setP({ ...p, description: e.target.value })} className="min-h-[60px]" /></Field>
      <div className="grid grid-cols-3 gap-2">
        {Object.entries(LIMITS).map(([k, label]) => (
          <Field key={k} label={label} hint="∞ = vazio">
            <Input type="number" min={0} value={p.limits[k] ?? ''} onChange={(e) => setP({ ...p, limits: { ...p.limits, [k]: e.target.value === '' ? null : Number(e.target.value) } })} />
          </Field>
        ))}
      </div>
      <div className="space-y-1">
        {Object.entries(FEATURES).map(([k, label]) => (
          <Switch key={k} checked={!!p.features[k]} onChange={(v) => setP({ ...p, features: { ...p.features, [k]: v } })} label={<span className="text-xs">{label}</span>} />
        ))}
      </div>
      <Button className="w-full" onClick={save} loading={savePlan.isPending}>Salvar plano</Button>
    </Card>
  )
}
