import { useEffect, useState } from 'react'
import { Clock, Plus, Scissors, Sparkles, Trash2, Users } from 'lucide-react'
import { useCurrentTenant } from '@/hooks/useTenant'
import { useServiceStaff, useServices, useStaff, useStaffMutations } from '@/api/staff'
import { Avatar, Button, Card, EmptyState, Field, Input, Switch, Textarea } from '@/components/ui/ui'
import { ConfirmDialog, Sheet } from '@/components/ui/Sheet'
import { useToast } from '@/components/ui/Toast'
import { StaffModeBanner } from './Staff'
import { errorMessage } from '@/lib/errors'
import { cn, formatMoney } from '@/lib/utils'
import type { Service } from '@/types/db'

const SUGGESTIONS = [
  { name: 'Corte', duration_min: 30, price: 50 }, { name: 'Barba', duration_min: 20, price: 35 },
  { name: 'Corte + barba', duration_min: 50, price: 80 }, { name: 'Sobrancelha', duration_min: 15, price: 20 },
]

export default function Services() {
  const { tenant, isManager } = useCurrentTenant()
  const { data: services = [], isLoading } = useServices(tenant.id)
  const { data: staff = [] } = useStaff(tenant.id)
  const { data: links = [] } = useServiceStaff(tenant.id)
  const [editing, setEditing] = useState<Service | null>(null)
  const [creating, setCreating] = useState<Partial<Service> | null>(null)

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-2xl font-bold md:text-3xl">Serviços</h1>
          <p className="mt-1 text-sm text-ink-400">Duração, intervalo de preparo, preço e quem realiza. A agenda calcula os horários a partir daqui.</p>
        </div>
        {isManager && <Button size="sm" className="h-9" onClick={() => setCreating({})}><Plus className="h-3.5 w-3.5" /> Novo serviço</Button>}
      </div>
      <StaffModeBanner />

      {isLoading ? <div className="skeleton h-40 rounded-2xl" /> : services.length === 0 ? (
        <Card>
          <EmptyState icon={<Scissors className="h-6 w-6" />} title="Cadastre seus serviços" description="Comece com uma sugestão e ajuste preço e duração."
            action={isManager ? (
              <div className="flex flex-wrap justify-center gap-2">
                {SUGGESTIONS.map((s) => (
                  <Button key={s.name} size="sm" variant="secondary" onClick={() => setCreating({ name: s.name, duration_min: s.duration_min, price_cents: s.price * 100 })}>
                    <Sparkles className="h-3.5 w-3.5" /> {s.name}
                  </Button>
                ))}
              </div>
            ) : undefined} />
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {services.map((s) => {
            const who = links.filter((l) => l.service_id === s.id).map((l) => staff.find((p) => p.id === l.staff_id)).filter(Boolean)
            return (
              <button key={s.id} onClick={() => isManager && setEditing(s)} className={cn('card p-5 text-left transition hover:border-ink-600', !s.is_active && 'opacity-50')}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-semibold">{s.name}</p>
                    {s.description && <p className="mt-0.5 line-clamp-2 text-xs text-ink-400">{s.description}</p>}
                  </div>
                  <p className="font-display text-lg font-bold">{s.price_cents != null ? formatMoney(s.price_cents) : '—'}</p>
                </div>
                <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-ink-300">
                  <span className="flex items-center gap-1"><Clock className="h-3.5 w-3.5 text-ink-500" /> {s.duration_min} min{s.buffer_min ? ` + ${s.buffer_min} preparo` : ''}</span>
                  <span className="flex items-center gap-1.5"><Users className="h-3.5 w-3.5 text-ink-500" />
                    {who.length ? (
                      <span className="flex -space-x-1.5">{who.slice(0, 5).map((p) => <Avatar key={p!.id} name={p!.name} src={p!.photo_url} size={20} className="ring-2 ring-ink-900" />)}</span>
                    ) : 'Todos os profissionais'}
                  </span>
                  {!s.is_active && <span className="chip border-ink-600 text-ink-400">Inativo</span>}
                </div>
              </button>
            )
          })}
        </div>
      )}
      <ServiceEditor open={!!editing || !!creating} service={editing} draft={creating} onClose={() => { setEditing(null); setCreating(null) }} />
    </div>
  )
}

function ServiceEditor({ open, service, draft, onClose }: { open: boolean; service: Service | null; draft: Partial<Service> | null; onClose: () => void }) {
  const { tenant } = useCurrentTenant()
  const toast = useToast()
  const { data: staff = [] } = useStaff(tenant.id)
  const { data: links = [] } = useServiceStaff(tenant.id)
  const { saveService, deleteService } = useStaffMutations(tenant.id)
  const [f, setF] = useState({ name: '', description: '', price: '', duration_min: 30, buffer_min: 0, is_active: true })
  const [staffIds, setStaffIds] = useState<string[]>([])
  const [confirm, setConfirm] = useState(false)

  useEffect(() => {
    if (!open) return
    const src = service ?? draft ?? {}
    setF({
      name: src.name ?? '', description: src.description ?? '', price: src.price_cents != null ? String(src.price_cents / 100) : '',
      duration_min: src.duration_min ?? 30, buffer_min: src.buffer_min ?? 0, is_active: src.is_active ?? true,
    })
    setStaffIds(service ? links.filter((l) => l.service_id === service.id).map((l) => l.staff_id) : [])
  }, [open, service, draft, links])

  const save = async () => {
    if (f.name.trim().length < 2) return toast('error', 'Informe o nome do serviço')
    if (f.duration_min < 5) return toast('error', 'Duração mínima de 5 minutos')
    const price = f.price.trim() === '' ? null : Math.round(Number(f.price.replace(',', '.')) * 100)
    if (price != null && (Number.isNaN(price) || price < 0)) return toast('error', 'Preço inválido')
    try {
      await saveService.mutateAsync({ service: { id: service?.id, name: f.name, description: f.description, price_cents: price, duration_min: f.duration_min, buffer_min: f.buffer_min, is_active: f.is_active }, staffIds })
      toast('success', service ? 'Serviço atualizado' : 'Serviço criado')
      onClose()
    } catch (e) { toast('error', 'Erro ao salvar', errorMessage(e)) }
  }

  return (
    <>
      <Sheet open={open} onClose={onClose} title={service ? service.name : 'Novo serviço'}
        footer={<div className="flex gap-2">
          {service && <Button variant="ghost" className="text-rose-300" onClick={() => setConfirm(true)}><Trash2 className="h-4 w-4" /></Button>}
          <Button className="flex-1" onClick={save} loading={saveService.isPending}>Salvar</Button>
        </div>}>
        <div className="space-y-4">
          <Field label="Nome"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Ex.: Corte degradê" /></Field>
          <Field label="Descrição" hint="aparece na página pública"><Textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Preço (R$)"><Input value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} inputMode="decimal" placeholder="50,00" /></Field>
            <Field label="Duração" hint="min"><Input type="number" min={5} step={5} value={f.duration_min} onChange={(e) => setF({ ...f, duration_min: Number(e.target.value) })} /></Field>
            <Field label="Preparo" hint="min"><Input type="number" min={0} step={5} value={f.buffer_min} onChange={(e) => setF({ ...f, buffer_min: Number(e.target.value) })} /></Field>
          </div>
          <p className="-mt-1 text-xs text-ink-500">O preparo (limpeza, troca de material) bloqueia o profissional depois do serviço, mas não aparece para o cliente.</p>
          <div>
            <p className="label">Quem realiza</p>
            {staff.length === 0 ? <p className="text-sm text-ink-500">Cadastre profissionais para vinculá-los.</p> : (
              <div className="flex flex-wrap gap-2">
                {staff.map((p) => {
                  const on = staffIds.includes(p.id)
                  return (
                    <button key={p.id} type="button" onClick={() => setStaffIds((ids) => (on ? ids.filter((x) => x !== p.id) : [...ids, p.id]))}
                      className={cn('flex items-center gap-2 rounded-xl border py-1.5 pl-1.5 pr-3 text-sm transition', on ? 'border-lime/60 bg-lime/10 text-lime' : 'border-ink-700 text-ink-300')}>
                      <Avatar name={p.name} src={p.photo_url} size={24} /> {p.name}
                    </button>
                  )
                })}
              </div>
            )}
            <p className="mt-2 text-xs text-ink-500">Sem ninguém marcado, qualquer profissional pode realizar.</p>
          </div>
          <Switch checked={f.is_active} onChange={(v) => setF({ ...f, is_active: v })} label="Disponível para agendamento" />
        </div>
      </Sheet>
      <ConfirmDialog open={confirm} danger title="Excluir serviço?" confirmLabel="Excluir" loading={deleteService.isPending}
        description="Agendamentos existentes são mantidos, mas perdem o vínculo com o serviço. Prefira desativar."
        onClose={() => setConfirm(false)}
        onConfirm={async () => {
          try { await deleteService.mutateAsync(service!.id); toast('success', 'Serviço excluído'); setConfirm(false); onClose() }
          catch (e) { toast('error', 'Erro', errorMessage(e)) }
        }} />
    </>
  )
}
