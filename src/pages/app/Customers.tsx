import { useEffect, useState } from 'react'
import { CalendarPlus, MessageCircle, Repeat2, Search, Trash2, UserMinus, UserPlus, Users, AlertTriangle, Plus, X } from 'lucide-react'
import { useCurrentTenant } from '@/hooks/useTenant'
import { useCustomerHistory, useCustomerInsights, useCustomerMutations, useCustomers, type CustomerSegment } from '@/api/customers'
import { useShell } from '@/components/layout/AppShell'
import { Avatar, Button, Card, EmptyState, Field, Input, Segmented, Select, Switch, Textarea } from '@/components/ui/ui'
import { ConfirmDialog, Sheet } from '@/components/ui/Sheet'
import { useToast } from '@/components/ui/Toast'
import { StatusBadge } from '@/components/reservations/ReservationDetail'
import { fmt } from '@/lib/datetime'
import { errorMessage } from '@/lib/errors'
import { formatPhone, isValidEmail, isValidPhone, whatsappLink } from '@/lib/utils'
import type { CustomerStats } from '@/types/db'

export default function Customers() {
  const { tenant } = useCurrentTenant()
  const tz = tenant.timezone
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [segment, setSegment] = useState<CustomerSegment>('all')
  const [sort, setSort] = useState<'name' | 'recent' | 'visits'>('recent')
  const [selected, setSelected] = useState<CustomerStats | null>(null)
  const [creating, setCreating] = useState(false)
  useEffect(() => { const t = setTimeout(() => setDebounced(search), 250); return () => clearTimeout(t) }, [search])

  const { data: customers = [], isLoading } = useCustomers(tenant.id, debounced, segment, sort)
  const { data: ins } = useCustomerInsights(tenant.id)

  const tiles = [
    { label: 'Clientes', value: ins?.total, icon: Users },
    { label: 'Recorrentes (2+ visitas)', value: ins?.recurring, icon: Repeat2 },
    { label: 'Novos · 30 dias', value: ins?.new_30d, icon: UserPlus },
    { label: 'Sem retorno · 60 dias', value: ins?.inactive_60d, icon: UserMinus },
    { label: 'Faltas registradas', value: ins?.total_no_shows, icon: AlertTriangle },
  ]

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-2xl font-bold md:text-3xl">Clientes</h1>
          <p className="mt-1 text-sm text-ink-400">
            Seu CRM é alimentado automaticamente a cada reserva.
            {ins?.avg_days_between_visits ? ` Frequência média: a cada ${Math.round(ins.avg_days_between_visits)} dias.` : ''}
          </p>
        </div>
        <Button size="sm" className="h-9" onClick={() => setCreating(true)}><Plus className="h-3.5 w-3.5" /> Novo cliente</Button>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {tiles.map((t) => (
          <Card key={t.label} className="p-4">
            <t.icon className="h-4 w-4 text-ink-400" />
            <p className="mt-3 font-display text-2xl font-bold tabular-nums">{t.value ?? '—'}</p>
            <p className="text-xs text-ink-400">{t.label}</p>
          </Card>
        ))}
      </div>

      <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
        <div className="-mx-4 overflow-x-auto px-4 lg:mx-0 lg:px-0">
          <Segmented value={segment} onChange={setSegment} options={[
            { value: 'all', label: 'Todos' }, { value: 'recurring', label: 'Recorrentes' }, { value: 'new', label: 'Novos' },
            { value: 'inactive', label: 'Sem retorno' }, { value: 'no_show', label: 'Com faltas' },
          ]} />
        </div>
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar por nome, telefone ou e-mail" className="pl-10" />
        </div>
        <Select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} className="lg:w-48">
          <option value="recent">Mais recentes</option>
          <option value="visits">Mais visitas</option>
          <option value="name">Nome (A–Z)</option>
        </Select>
      </div>

      {isLoading ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="skeleton h-[92px] rounded-2xl" />)}</div>
      ) : customers.length === 0 ? (
        <Card><EmptyState icon={<Users className="h-6 w-6" />} title="Nenhum cliente encontrado" description="Clientes são criados automaticamente quando alguém reserva." /></Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {customers.map((c) => (
            <button key={c.id} onClick={() => setSelected(c)} className="card flex items-center gap-3.5 p-4 text-left transition hover:border-ink-600">
              <Avatar name={c.name} size={44} />
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold">{c.name}</p>
                <p className="text-xs text-ink-400">{formatPhone(c.phone)}</p>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {c.visits >= 2 && <span className="chip border-lime/30 bg-lime/10 text-lime">Recorrente</span>}
                  {c.no_shows > 0 && <span className="chip border-orange-400/30 bg-orange-400/10 text-orange-300">{c.no_shows} falta(s)</span>}
                  {c.next_reservation_at && <span className="chip border-sky-400/30 bg-sky-400/10 text-sky-300">Próx. {fmt(c.next_reservation_at, tz, 'dd/MM')}</span>}
                  {c.tags.slice(0, 2).map((t) => <span key={t} className="chip border-ink-600 text-ink-300">{t}</span>)}
                </div>
              </div>
              <div className="text-right">
                <p className="font-display text-xl font-bold tabular-nums">{c.visits}</p>
                <p className="text-[10px] uppercase tracking-wide text-ink-500">visitas</p>
              </div>
            </button>
          ))}
        </div>
      )}

      <CustomerSheet customer={selected} open={!!selected || creating} onClose={() => { setSelected(null); setCreating(false) }} />
    </div>
  )
}

function CustomerSheet({ customer, open, onClose }: { customer: CustomerStats | null; open: boolean; onClose: () => void }) {
  const { tenant, isManager } = useCurrentTenant()
  const tz = tenant.timezone
  const toast = useToast()
  const { newReservation } = useShell()
  const { save, remove } = useCustomerMutations(tenant.id)
  const { data: history = [] } = useCustomerHistory(customer?.id)
  const [form, setForm] = useState({ name: '', phone: '', email: '', birthday: '', preferences: '', notes: '', tags: [] as string[], marketing_opt_in: false })
  const [tag, setTag] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => {
    if (!open) return
    setErr(null)
    setForm({
      name: customer?.name ?? '', phone: customer ? formatPhone(customer.phone) : '', email: customer?.email ?? '', birthday: customer?.birthday ?? '',
      preferences: customer?.preferences ?? '', notes: customer?.notes ?? '', tags: customer?.tags ?? [], marketing_opt_in: customer?.marketing_opt_in ?? false,
    })
  }, [open, customer])

  const submit = async () => {
    setErr(null)
    if (form.name.trim().length < 2) return setErr('Informe o nome.')
    if (!isValidPhone(form.phone)) return setErr('Telefone inválido.')
    if (form.email && !isValidEmail(form.email)) return setErr('E-mail inválido.')
    try {
      await save.mutateAsync({ ...form, id: customer?.id })
      toast('success', customer ? 'Cliente atualizado' : 'Cliente cadastrado')
      onClose()
    } catch (e) { setErr(errorMessage(e)) }
  }

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }))

  return (
    <>
      <Sheet open={open} onClose={onClose} wide title={customer ? customer.name : 'Novo cliente'}
        subtitle={customer ? `Cliente desde ${fmt(customer.created_at, tz, "MMMM 'de' yyyy")}` : 'Cadastro manual no CRM'}
        footer={
          <div className="flex gap-2">
            {customer && isManager && <Button variant="ghost" onClick={() => setConfirmDelete(true)} className="text-rose-300"><Trash2 className="h-4 w-4" /></Button>}
            {customer && (
              <Button variant="secondary" onClick={() => { onClose(); newReservation({ customer: { id: customer.id, name: customer.name, phone: customer.phone, email: customer.email } }) }}>
                <CalendarPlus className="h-4 w-4" /> Reservar
              </Button>
            )}
            <Button className="flex-1" onClick={submit} loading={save.isPending}>Salvar</Button>
          </div>
        }>
        <div className="space-y-6">
          {customer && (
            <div className="grid grid-cols-4 gap-2">
              {[
                ['Visitas', customer.visits], ['Reservas', customer.reservations_count], ['Cancel.', customer.cancellations], ['Faltas', customer.no_shows],
              ].map(([l, v]) => (
                <div key={l} className="rounded-2xl border border-ink-700 bg-ink-850 p-3 text-center">
                  <p className="font-display text-xl font-bold">{v}</p>
                  <p className="text-[11px] text-ink-400">{l}</p>
                </div>
              ))}
              <p className="col-span-4 text-xs text-ink-400">
                Última visita: <b className="text-ink-200">{customer.last_visit_at ? fmt(customer.last_visit_at, tz, 'dd/MM/yyyy') : '—'}</b>
                {customer.next_reservation_at && <> · Próxima: <b className="text-lime">{fmt(customer.next_reservation_at, tz, "dd/MM 'às' HH:mm")}</b></>}
              </p>
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Nome" className="sm:col-span-2"><Input value={form.name} onChange={(e) => set('name', e.target.value)} /></Field>
            <Field label="Telefone">
              <div className="flex gap-2">
                <Input value={form.phone} onChange={(e) => set('phone', formatPhone(e.target.value))} inputMode="tel" />
                {customer && <a href={whatsappLink(customer.phone)} target="_blank" rel="noreferrer" className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-ink-600 text-ink-300 hover:text-lime"><MessageCircle className="h-4 w-4" /></a>}
              </div>
            </Field>
            <Field label="E-mail"><Input value={form.email} onChange={(e) => set('email', e.target.value)} type="email" /></Field>
            <Field label="Aniversário"><Input type="date" value={form.birthday} onChange={(e) => set('birthday', e.target.value)} /></Field>
            <Field label="Etiquetas">
              <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-ink-600 bg-ink-850 p-1.5">
                {form.tags.map((t) => (
                  <span key={t} className="chip border-ink-600 text-ink-200">{t}<button onClick={() => set('tags', form.tags.filter((x) => x !== t))}><X className="h-3 w-3" /></button></span>
                ))}
                <input value={tag} onChange={(e) => setTag(e.target.value)} placeholder="VIP, alergia…" className="h-7 min-w-[80px] flex-1 bg-transparent px-1.5 text-sm outline-none"
                  onKeyDown={(e) => { if (e.key === 'Enter' && tag.trim()) { e.preventDefault(); set('tags', [...new Set([...form.tags, tag.trim()])]); setTag('') } }} />
              </div>
            </Field>
            <Field label="Preferências" className="sm:col-span-2"><Textarea value={form.preferences} onChange={(e) => set('preferences', e.target.value)} placeholder="Mesa na varanda, corte degradê, sem glúten…" /></Field>
            <Field label="Observações internas" className="sm:col-span-2"><Textarea value={form.notes} onChange={(e) => set('notes', e.target.value)} /></Field>
            <div className="sm:col-span-2">
              <Switch checked={form.marketing_opt_in} onChange={(v) => set('marketing_opt_in', v)} label="Aceita receber promoções"
                description="Consentimento (LGPD) para futuras campanhas e automações de relacionamento." />
            </div>
          </div>

          {err && <p className="rounded-xl border border-rose-400/30 bg-rose-400/10 px-3.5 py-3 text-sm text-rose-200">{err}</p>}

          {customer && (
            <div>
              <p className="label">Histórico de reservas</p>
              {history.length === 0 ? <p className="text-sm text-ink-500">Sem reservas.</p> : (
                <div className="divide-y divide-ink-800 rounded-2xl border border-ink-700">
                  {history.map((r) => (
                    <div key={r.id} className="flex items-center gap-3 px-4 py-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">{fmt(r.starts_at, tz, "dd/MM/yyyy 'às' HH:mm")}</p>
                        <p className="text-xs text-ink-400">{r.party_size} pessoa(s){r.notes ? ` · ${r.notes}` : ''}</p>
                      </div>
                      <StatusBadge status={r.status} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </Sheet>
      <ConfirmDialog open={confirmDelete} danger title="Excluir cliente?" confirmLabel="Excluir" loading={remove.isPending}
        description="O histórico de reservas é mantido, mas desvinculado deste cadastro. Use para atender pedidos de exclusão de dados (LGPD)."
        onClose={() => setConfirmDelete(false)}
        onConfirm={async () => {
          try { await remove.mutateAsync(customer!.id); toast('success', 'Cliente excluído'); setConfirmDelete(false); onClose() }
          catch (e) { toast('error', 'Erro', errorMessage(e)) }
        }} />
    </>
  )
}
