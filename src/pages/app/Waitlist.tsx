import { useState } from 'react'
import { BellRing, CalendarPlus, Clock, ListPlus, MessageCircle, Plus, Users, XCircle } from 'lucide-react'
import { useCurrentTenant } from '@/hooks/useTenant'
import { useWaitlist, useWaitlistMutations } from '@/api/waitlist'
import { useAreas } from '@/api/floor'
import { useShell } from '@/components/layout/AppShell'
import { Button, Card, EmptyState, Field, Input, Select, Textarea } from '@/components/ui/ui'
import { Sheet } from '@/components/ui/Sheet'
import { useToast } from '@/components/ui/Toast'
import { fmt, keyLabel, shiftKey, todayKey } from '@/lib/datetime'
import { SOURCE } from '@/lib/constants'
import { errorMessage } from '@/lib/errors'
import { cn, formatPhone, isValidPhone, whatsappLink } from '@/lib/utils'
import type { WaitlistEntry, WaitlistStatus } from '@/types/db'

const W_STATUS: Record<WaitlistStatus, { label: string; chip: string }> = {
  waiting: { label: 'Aguardando', chip: 'border-amber-400/30 bg-amber-400/10 text-amber-300' },
  notified: { label: 'Avisado', chip: 'border-sky-400/30 bg-sky-400/10 text-sky-300' },
  converted: { label: 'Virou reserva', chip: 'border-lime/30 bg-lime/10 text-lime' },
  expired: { label: 'Expirado', chip: 'border-ink-500 bg-ink-700/60 text-ink-300' },
  cancelled: { label: 'Cancelado', chip: 'border-ink-500 bg-ink-700/60 text-ink-300' },
}

export default function Waitlist() {
  const { tenant } = useCurrentTenant()
  const tz = tenant.timezone
  const toast = useToast()
  const { newReservation } = useShell()
  const [dateKey, setDateKey] = useState(todayKey(tz))
  const [onlyOpen, setOnlyOpen] = useState(true)
  const [adding, setAdding] = useState(false)
  const { data: entries = [], isLoading } = useWaitlist(tenant.id, dateKey, onlyOpen)
  const { data: areas = [] } = useAreas(tenant.id)
  const { setStatus, notify } = useWaitlistMutations(tenant.id)

  const doNotify = async (w: WaitlistEntry) => {
    try {
      const r = await notify.mutateAsync(w.id)
      if (r.queued) toast('success', 'Cliente avisado', 'Mensagem enviada para a fila de WhatsApp/e-mail.')
      else { window.open(whatsappLink(w.customer_phone, r.message), '_blank'); toast('info', 'Abrindo WhatsApp', 'Automação desativada: envie a mensagem manualmente.') }
    } catch (e) { toast('error', 'Erro', errorMessage(e)) }
  }

  const convert = (w: WaitlistEntry) => newReservation({
    dateKey: w.desired_date, time: w.desired_time?.slice(0, 5),
    customer: { id: '', name: w.customer_name, phone: w.customer_phone, email: w.customer_email },
    partySize: w.party_size,
    onCreated: (reservationId) => setStatus.mutate({ id: w.id, status: 'converted', reservationId }),
  })

  const waiting = entries.filter((e) => e.status === 'waiting').length
  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-2xl font-bold md:text-3xl">Lista de espera</h1>
          <p className="mt-1 text-sm text-ink-400">Clientes que querem um horário lotado. Você é avisado sempre que uma reserva é cancelada.</p>
        </div>
        <Button size="sm" className="h-9" onClick={() => setAdding(true)}><Plus className="h-3.5 w-3.5" /> Adicionar</Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center rounded-xl border border-ink-700 bg-ink-850">
          {[0, 1, 2].map((d) => {
            const k = shiftKey(todayKey(tz), d)
            return <button key={d} onClick={() => setDateKey(k)} className={cn('h-9 px-3 text-xs font-semibold', dateKey === k ? 'text-lime' : 'text-ink-300 hover:text-ink-100')}>{d === 0 ? 'Hoje' : d === 1 ? 'Amanhã' : keyLabel(k, 'EEE dd')}</button>
          })}
        </div>
        <Input type="date" value={dateKey} onChange={(e) => e.target.value && setDateKey(e.target.value)} className="h-9 w-[160px]" />
        <label className="ml-auto flex items-center gap-2 text-sm text-ink-300"><input type="checkbox" checked={onlyOpen} onChange={(e) => setOnlyOpen(e.target.checked)} className="accent-[#C6F432]" /> Apenas em aberto</label>
      </div>

      <p className="text-sm text-ink-400 first-letter:uppercase">{keyLabel(dateKey, "EEEE, d 'de' MMMM")} · <b className="text-ink-100">{waiting}</b> aguardando</p>

      {isLoading ? <div className="skeleton h-40 rounded-2xl" /> : entries.length === 0 ? (
        <Card><EmptyState icon={<ListPlus className="h-6 w-6" />} title="Ninguém na lista para este dia" description="Quando um horário lota, o cliente pode entrar na lista pela página de reservas." /></Card>
      ) : (
        <div className="space-y-2">
          {entries.map((w, i) => (
            <Card key={w.id} className="flex flex-col gap-3 p-4 md:flex-row md:items-center">
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-ink-700 bg-ink-850 font-display text-sm font-bold text-ink-300">{i + 1}</span>
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 font-semibold">{w.customer_name}<span className={cn('chip', W_STATUS[w.status].chip)}>{W_STATUS[w.status].label}</span></p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-3 text-xs text-ink-400">
                    <span className="flex items-center gap-1"><Users className="h-3 w-3" /> {w.party_size}</span>
                    {w.desired_time && <span className="flex items-center gap-1"><Clock className="h-3 w-3" /> {w.desired_time.slice(0, 5)}</span>}
                    {w.area_id && <span>{areas.find((a) => a.id === w.area_id)?.name}</span>}
                    <span>{formatPhone(w.customer_phone)}</span>
                    <span>{SOURCE[w.source]} · {fmt(w.created_at, tz, "dd/MM HH:mm")}</span>
                    {w.notified_at && <span className="text-sky-300">avisado {fmt(w.notified_at, tz, 'HH:mm')}</span>}
                  </p>
                  {w.notes && <p className="mt-1 text-xs text-ink-300">{w.notes}</p>}
                </div>
              </div>
              {(w.status === 'waiting' || w.status === 'notified') && (
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" onClick={() => doNotify(w)} loading={notify.isPending && notify.variables === w.id}><BellRing className="h-3.5 w-3.5" /> Avisar</Button>
                  <a href={whatsappLink(w.customer_phone)} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-ink-600 px-3 text-xs font-semibold hover:border-lime/50"><MessageCircle className="h-3.5 w-3.5" /></a>
                  <Button size="sm" onClick={() => convert(w)}><CalendarPlus className="h-3.5 w-3.5" /> Criar reserva</Button>
                  <Button size="sm" variant="ghost" onClick={() => setStatus.mutate({ id: w.id, status: 'cancelled' })} title="Remover"><XCircle className="h-3.5 w-3.5" /></Button>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
      <AddEntry open={adding} onClose={() => setAdding(false)} dateKey={dateKey} />
    </div>
  )
}

function AddEntry({ open, onClose, dateKey }: { open: boolean; onClose: () => void; dateKey: string }) {
  const { tenant } = useCurrentTenant()
  const toast = useToast()
  const { create } = useWaitlistMutations(tenant.id)
  const { data: areas = [] } = useAreas(tenant.id)
  const [f, setF] = useState({ name: '', phone: '', date: dateKey, time: '', party: 2, area: '', notes: '' })
  const save = async () => {
    if (f.name.trim().length < 2) return toast('error', 'Informe o nome')
    if (!isValidPhone(f.phone)) return toast('error', 'Telefone inválido')
    try {
      await create.mutateAsync({ customer_name: f.name.trim(), customer_phone: f.phone, desired_date: f.date || dateKey, desired_time: f.time || null, party_size: f.party, area_id: f.area || null, notes: f.notes, source: 'phone' })
      toast('success', 'Adicionado à lista de espera'); setF({ ...f, name: '', phone: '', notes: '' }); onClose()
    } catch (e) { toast('error', 'Erro', errorMessage(e)) }
  }
  return (
    <Sheet open={open} onClose={onClose} title="Adicionar à lista de espera" footer={<Button className="w-full" onClick={save} loading={create.isPending}>Adicionar</Button>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Nome" className="col-span-2"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Telefone" className="col-span-2"><Input value={f.phone} onChange={(e) => setF({ ...f, phone: formatPhone(e.target.value) })} inputMode="tel" /></Field>
        <Field label="Data"><Input type="date" value={f.date || dateKey} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
        <Field label="Horário desejado" hint="opcional"><Input type="time" value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} /></Field>
        <Field label="Pessoas"><Input type="number" min={1} value={f.party} onChange={(e) => setF({ ...f, party: Number(e.target.value) })} /></Field>
        <Field label="Ambiente">
          <Select value={f.area} onChange={(e) => setF({ ...f, area: e.target.value })}>
            <option value="">Sem preferência</option>
            {areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </Select>
        </Field>
        <Field label="Observações" className="col-span-2"><Textarea value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
      </div>
    </Sheet>
  )
}
