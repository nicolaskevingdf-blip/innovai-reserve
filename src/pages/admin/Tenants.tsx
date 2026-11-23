import { useEffect, useState } from 'react'
import { ExternalLink, Plus, Search } from 'lucide-react'
import { FEATURES, LIMITS, SUB_STATUS, useAdminMutations, useAdminTenants, useAllPlans } from '@/api/saas'
import { Avatar, Button, Card, EmptyState, Field, Input, Select, Textarea } from '@/components/ui/ui'
import { Sheet } from '@/components/ui/Sheet'
import { useToast } from '@/components/ui/Toast'
import { SEGMENT } from '@/lib/constants'
import { PUBLIC_BASE_URL } from '@/lib/supabase'
import { errorMessage } from '@/lib/errors'
import { cn, slugify } from '@/lib/utils'
import type { AdminTenantRow, Segment, SubscriptionStatus, TenantStatus } from '@/types/db'

const d = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('pt-BR') : '—')

export default function AdminTenants() {
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [status, setStatus] = useState('')
  const [selected, setSelected] = useState<AdminTenantRow | null>(null)
  const [creating, setCreating] = useState(false)
  useEffect(() => { const t = setTimeout(() => setDebounced(search), 250); return () => clearTimeout(t) }, [search])
  const { data: rows = [], isLoading } = useAdminTenants(debounced, status)

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-2xl font-bold md:text-3xl">Empresas</h1>
          <p className="mt-1 text-sm text-ink-400">{rows.length} estabelecimento(s)</p>
        </div>
        <Button size="sm" className="h-9" onClick={() => setCreating(true)}><Plus className="h-3.5 w-3.5" /> Nova empresa</Button>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar por nome ou link" className="pl-10" />
        </div>
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="sm:w-56">
          <option value="">Todos</option>
          <option value="active">Estabelecimento ativo</option>
          <option value="suspended">Suspenso</option>
          <option value="trialing">Em teste</option>
          <option value="past_due">Pagamento pendente</option>
          <option value="cancelled">Cancelado</option>
        </Select>
      </div>
      {isLoading ? <div className="skeleton h-40 rounded-2xl" /> : rows.length === 0 ? <Card><EmptyState title="Nenhuma empresa encontrada" /></Card> : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-sm">
            <thead>
              <tr className="border-b border-ink-800 text-left text-[11px] uppercase tracking-wider text-ink-500">
                <th className="px-5 py-3">Empresa</th><th className="px-3 py-3">Plano</th><th className="px-3 py-3">Assinatura</th>
                <th className="px-3 py-3">Reservas 30d</th><th className="px-3 py-3">Usuários</th><th className="px-3 py-3">Última reserva</th><th className="px-5 py-3">Desde</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-800/80">
              {rows.map((t) => (
                <tr key={t.id} onClick={() => setSelected(t)} className="cursor-pointer hover:bg-ink-850">
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-3">
                      <Avatar name={t.name} size={32} className="rounded-lg" />
                      <div className="min-w-0">
                        <p className="truncate font-medium">{t.name} {t.status !== 'active' && <span className="chip ml-1 border-rose-400/30 bg-rose-400/10 text-rose-300">Suspenso</span>}</p>
                        <p className="truncate text-xs text-ink-400">{SEGMENT[t.segment].label} · {t.owner_email ?? 'sem proprietário'}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-3">{t.plan_name ?? '—'}</td>
                  <td className="px-3 py-3">
                    {t.subscription_status && <span className={cn('chip', SUB_STATUS[t.subscription_status].chip)}>{SUB_STATUS[t.subscription_status].label}</span>}
                    {t.subscription_status === 'trialing' && <p className="mt-0.5 text-[11px] text-ink-500">até {d(t.trial_ends_at)}</p>}
                  </td>
                  <td className="px-3 py-3 tabular-nums">{t.reservations_30d}</td>
                  <td className="px-3 py-3 tabular-nums">{t.members}</td>
                  <td className="px-3 py-3 text-ink-300">{d(t.last_reservation_at)}</td>
                  <td className="px-5 py-3 text-ink-400">{d(t.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      <TenantSheet tenant={selected} onClose={() => setSelected(null)} />
      <CreateTenant open={creating} onClose={() => setCreating(false)} />
    </div>
  )
}

function TenantSheet({ tenant, onClose }: { tenant: AdminTenantRow | null; onClose: () => void }) {
  const toast = useToast()
  const { data: plans = [] } = useAllPlans()
  const { updateTenant } = useAdminMutations()
  const [f, setF] = useState({ status: 'active' as TenantStatus, plan: '', sub: 'active' as SubscriptionStatus, trial: '', period: '', domain: '', notes: '' })
  const [features, setFeatures] = useState<Record<string, boolean | undefined>>({})
  const [limits, setLimits] = useState<Record<string, string>>({})
  useEffect(() => {
    if (!tenant) return
    setF({ status: tenant.status, plan: tenant.plan_code ?? '', sub: tenant.subscription_status ?? 'active',
      trial: tenant.trial_ends_at?.slice(0, 10) ?? '', period: tenant.current_period_end?.slice(0, 10) ?? '',
      domain: tenant.custom_domain ?? '', notes: tenant.internal_notes ?? '' })
    setFeatures(tenant.feature_overrides?.features ?? {})
    setLimits(Object.fromEntries(Object.entries(tenant.feature_overrides?.limits ?? {}).map(([k, v]) => [k, v == null ? '' : String(v)])))
  }, [tenant])
  if (!tenant) return null

  const save = async () => {
    const lim = Object.fromEntries(Object.entries(limits).filter(([, v]) => v !== '').map(([k, v]) => [k, Number(v)]))
    const feat = Object.fromEntries(Object.entries(features).filter(([, v]) => v !== undefined))
    try {
      await updateTenant.mutateAsync({ id: tenant.id, patch: {
        status: f.status !== tenant.status ? f.status : null,
        plan_code: f.plan && f.plan !== tenant.plan_code ? f.plan : null,
        subscription_status: f.sub !== tenant.subscription_status ? f.sub : null,
        trial_ends_at: f.trial ? new Date(`${f.trial}T23:59:00`).toISOString() : null,
        period_end: f.period ? new Date(`${f.period}T23:59:00`).toISOString() : null,
        feature_overrides: { features: feat, limits: lim },
        custom_domain: f.domain, internal_notes: f.notes,
      } })
      toast('success', 'Empresa atualizada')
      onClose()
    } catch (e) { toast('error', 'Erro', errorMessage(e)) }
  }

  return (
    <Sheet open onClose={onClose} wide title={tenant.name}
      subtitle={<a href={`${PUBLIC_BASE_URL}/${SEGMENT[tenant.segment].path}/${tenant.slug}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-lime hover:underline">/{tenant.slug} <ExternalLink className="h-3 w-3" /></a>}
      footer={<Button className="w-full" onClick={save} loading={updateTenant.isPending}>Salvar alterações</Button>}>
      <div className="space-y-6">
        <div className="grid grid-cols-3 gap-2 text-center">
          {[['Reservas 30d', tenant.reservations_30d], ['Usuários', tenant.members], ['Chamados abertos', tenant.open_tickets]].map(([l, v]) => (
            <div key={l} className="rounded-xl border border-ink-700 bg-ink-850 p-3"><p className="font-display text-xl font-bold">{v}</p><p className="text-[11px] text-ink-400">{l}</p></div>
          ))}
        </div>
        <p className="text-sm text-ink-400">Proprietário: <b className="text-ink-100">{tenant.owner_email ?? 'convite pendente'}</b></p>

        <section className="grid gap-3 sm:grid-cols-2">
          <Field label="Plano">
            <Select value={f.plan} onChange={(e) => setF({ ...f, plan: e.target.value })}>
              {plans.map((p) => <option key={p.id} value={p.code}>{p.name}</option>)}
            </Select>
          </Field>
          <Field label="Assinatura">
            <Select value={f.sub} onChange={(e) => setF({ ...f, sub: e.target.value as SubscriptionStatus })}>
              {(Object.keys(SUB_STATUS) as SubscriptionStatus[]).map((s) => <option key={s} value={s}>{SUB_STATUS[s].label}</option>)}
            </Select>
          </Field>
          <Field label="Fim do teste"><Input type="date" value={f.trial} onChange={(e) => setF({ ...f, trial: e.target.value })} /></Field>
          <Field label="Período pago até"><Input type="date" value={f.period} onChange={(e) => setF({ ...f, period: e.target.value })} /></Field>
          <Field label="Estabelecimento">
            <Select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as TenantStatus })}>
              <option value="active">Ativo</option><option value="suspended">Suspenso (somente leitura)</option><option value="cancelled">Cancelado</option>
            </Select>
          </Field>
          <Field label="Domínio próprio" hint="opcional"><Input value={f.domain} onChange={(e) => setF({ ...f, domain: e.target.value })} placeholder="reservas.cliente.com.br" /></Field>
        </section>

        <section>
          <p className="label">Exceções de funcionalidades (sobrepõem o plano)</p>
          <div className="space-y-1.5">
            {Object.entries(FEATURES).map(([k, label]) => (
              <div key={k} className="flex items-center justify-between gap-3 rounded-xl border border-ink-700 bg-ink-850 px-3 py-2">
                <span className="text-sm">{label}</span>
                <Select value={features[k] === undefined ? '' : features[k] ? 'on' : 'off'} className="h-8 w-40 text-xs"
                  onChange={(e) => setFeatures((x) => ({ ...x, [k]: e.target.value === '' ? undefined : e.target.value === 'on' }))}>
                  <option value="">Conforme plano</option><option value="on">Liberado</option><option value="off">Bloqueado</option>
                </Select>
              </div>
            ))}
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            {Object.entries(LIMITS).map(([k, label]) => (
              <Field key={k} label={label} hint="vazio = plano"><Input type="number" min={0} value={limits[k] ?? ''} onChange={(e) => setLimits((x) => ({ ...x, [k]: e.target.value }))} /></Field>
            ))}
          </div>
        </section>
        <Field label="Notas internas Innovai" hint="o cliente não vê"><Textarea value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
      </div>
    </Sheet>
  )
}

function CreateTenant({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast()
  const { data: plans = [] } = useAllPlans()
  const { createTenant } = useAdminMutations()
  const [f, setF] = useState({ name: '', slug: '', segment: 'restaurant' as Segment, owner_email: '', plan_code: 'pro', trial_days: 14 })
  const save = async () => {
    try {
      await createTenant.mutateAsync({ ...f, slug: f.slug || slugify(f.name) })
      toast('success', 'Empresa criada', `O proprietário entra com ${f.owner_email} e já cai no painel.`)
      setF({ ...f, name: '', slug: '', owner_email: '' }); onClose()
    } catch (e) { toast('error', 'Erro', errorMessage(e)) }
  }
  return (
    <Sheet open={open} onClose={onClose} title="Nova empresa" subtitle="Venda feita pela Innovai: o cliente recebe acesso como proprietário."
      footer={<Button className="w-full" onClick={save} loading={createTenant.isPending}>Criar empresa</Button>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Nome comercial" className="sm:col-span-2"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value, slug: slugify(e.target.value) })} /></Field>
        <Field label="Link (slug)"><Input value={f.slug} onChange={(e) => setF({ ...f, slug: slugify(e.target.value) })} /></Field>
        <Field label="Segmento">
          <Select value={f.segment} onChange={(e) => setF({ ...f, segment: e.target.value as Segment })}>
            {(Object.keys(SEGMENT) as Segment[]).map((s) => <option key={s} value={s}>{SEGMENT[s].label}</option>)}
          </Select>
        </Field>
        <Field label="E-mail do proprietário" className="sm:col-span-2"><Input type="email" value={f.owner_email} onChange={(e) => setF({ ...f, owner_email: e.target.value })} /></Field>
        <Field label="Plano">
          <Select value={f.plan_code} onChange={(e) => setF({ ...f, plan_code: e.target.value })}>
            {plans.map((p) => <option key={p.id} value={p.code}>{p.name}</option>)}
          </Select>
        </Field>
        <Field label="Dias de teste" hint="0 = já ativa"><Input type="number" min={0} value={f.trial_days} onChange={(e) => setF({ ...f, trial_days: Number(e.target.value) })} /></Field>
      </div>
    </Sheet>
  )
}
