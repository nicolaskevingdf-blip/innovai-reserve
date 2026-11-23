import { useState } from 'react'
import { Armchair, CalendarClock, Copy, Scissors, History, MessageCircle, Pencil, Phone, Trash2, Users, Mail, StickyNote, Globe } from 'lucide-react'
import { Sheet, ConfirmDialog } from '@/components/ui/Sheet'
import { Button, Spinner, Textarea } from '@/components/ui/ui'
import { useToast } from '@/components/ui/Toast'
import { useCurrentTenant } from '@/hooks/useTenant'
import { useReservationEvents, useReservationMutations } from '@/api/reservations'
import { useAreas, useTables } from '@/api/floor'
import { useServices, useStaff } from '@/api/staff'
import { tableLabel } from '@/lib/floor'
import { errorMessage } from '@/lib/errors'
import { fmt, fmtDateLong, fmtTime } from '@/lib/datetime'
import { NEXT_STATUS, SOURCE, STATUS } from '@/lib/constants'
import { cn, formatPhone, whatsappLink } from '@/lib/utils'
import type { Reservation, ReservationEvent, ReservationStatus } from '@/types/db'
import { ReservationForm } from './ReservationForm'

export function StatusBadge({ status, className }: { status: ReservationStatus; className?: string }) {
  return (
    <span className={cn('chip', STATUS[status].chip, className)}>
      <span className={cn('h-1.5 w-1.5 rounded-full', STATUS[status].dot)} />
      {STATUS[status].label}
    </span>
  )
}

const ACTION_LABEL: Record<ReservationStatus, string> = {
  pending: 'Voltar para pendente',
  confirmed: 'Confirmar',
  in_progress: 'Check-in / iniciar',
  completed: 'Concluir',
  cancelled: 'Cancelar',
  no_show: 'Não compareceu',
}

export function ReservationDetail({ reservation, onClose }: { reservation: Reservation | null; onClose: () => void }) {
  const { tenant, isManager } = useCurrentTenant()
  const tz = tenant.timezone
  const toast = useToast()
  const { setStatus, remove } = useReservationMutations(tenant.id)
  const { data: events, isLoading } = useReservationEvents(reservation?.id)
  const { data: tables = [] } = useTables(tenant.id)
  const { data: areas = [] } = useAreas(tenant.id)
  const { data: services = [] } = useServices(tenant.id)
  const { data: staffList = [] } = useStaff(tenant.id)
  const [editing, setEditing] = useState(false)
  const [cancelOpen, setCancelOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [reason, setReason] = useState('')

  if (!reservation) return null
  const r = reservation

  const change = async (status: ReservationStatus, cancelReason?: string) => {
    try {
      await setStatus.mutateAsync({ id: r.id, status, reason: cancelReason })
      toast('success', `Status: ${STATUS[status].label}`)
      setCancelOpen(false)
      if (status === 'cancelled') onClose()
    } catch (e) {
      toast('error', 'Não foi possível alterar', errorMessage(e))
    }
  }

  const next = NEXT_STATUS[r.status]
  const primary = next.find((s) => s !== 'cancelled' && s !== 'no_show' && s !== 'pending')

  return (
    <>
      <Sheet
        open={!!reservation && !editing}
        onClose={onClose}
        title={r.customer_name}
        subtitle={<span className="flex items-center gap-2"><StatusBadge status={r.status} /> <span className="font-mono text-xs text-ink-400">#{r.code}</span></span>}
        footer={
          <div className="flex flex-wrap items-center gap-2">
            {primary && (
              <Button className="flex-1" loading={setStatus.isPending} onClick={() => change(primary)}>{ACTION_LABEL[primary]}</Button>
            )}
            {next.includes('no_show') && <Button variant="secondary" onClick={() => change('no_show')}>Não veio</Button>}
            {next.includes('cancelled') && <Button variant="danger" onClick={() => setCancelOpen(true)}>Cancelar</Button>}
            {!primary && next.length > 0 && next.filter((s) => s !== 'cancelled' && s !== 'no_show').map((s) => (
              <Button key={s} variant="secondary" className="flex-1" onClick={() => change(s)}>{ACTION_LABEL[s]}</Button>
            ))}
          </div>
        }
      >
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-3">
            <InfoTile icon={<CalendarClock className="h-4 w-4" />} label="Quando"
              value={<><span className="inline-block first-letter:uppercase">{fmtDateLong(r.starts_at, tz)}</span><br /><span className="text-lime">{fmtTime(r.starts_at, tz)} – {fmtTime(r.ends_at, tz)}</span></>} />
            <InfoTile icon={<Users className="h-4 w-4" />} label="Pessoas" value={<span className="text-2xl font-bold">{r.party_size}</span>} />
          </div>
          {(r.service_id || r.staff_id) && (() => {
            const sv = services.find((x) => x.id === r.service_id)
            const sf = staffList.find((x) => x.id === r.staff_id)
            return (
              <div className="flex items-center gap-3 rounded-2xl border border-lime/20 bg-lime/[0.04] px-4 py-3">
                {sf ? <span className="h-8 w-8 shrink-0 overflow-hidden rounded-full ring-2" style={{ ['--tw-ring-color' as string]: sf.color }}>
                  {sf.photo_url ? <img src={sf.photo_url} alt="" className="h-full w-full object-cover" /> : <span className="grid h-full w-full place-items-center bg-ink-700 text-xs font-bold">{sf.name[0]}</span>}
                </span> : <Scissors className="h-4 w-4 text-lime" />}
                <span className="text-sm">
                  {sv ? <b>{sv.name}</b> : 'Atendimento'}
                  {sf && <span className="text-ink-300"> com {sf.name}</span>}
                  {r.staff_id && !r.staff_requested && <span className="text-ink-500"> · escolhido pelo sistema</span>}
                </span>
              </div>
            )
          })()}
          {(r.table_ids?.length > 0 || r.area_id) && (
            <div className="flex items-center gap-3 rounded-2xl border border-lime/20 bg-lime/[0.04] px-4 py-3">
              <Armchair className="h-4 w-4 text-lime" />
              <span className="text-sm">
                {r.table_ids?.length ? <>Mesa <b>{tableLabel(r.table_ids, tables)}</b></> : 'Mesa a definir'}
                {r.area_id && <span className="text-ink-400"> · {areas.find((a) => a.id === r.area_id)?.name}</span>}
              </span>
            </div>
          )}

          <div className="space-y-2 rounded-2xl border border-ink-700 bg-ink-850 p-4">
            <Row icon={<Phone className="h-4 w-4" />} value={formatPhone(r.customer_phone)}
              action={
                <div className="flex gap-1.5">
                  <a href={`tel:${r.customer_phone_normalized ?? r.customer_phone}`} className="rounded-lg border border-ink-600 px-2.5 py-1 text-xs hover:border-lime/50">Ligar</a>
                  <a href={whatsappLink(r.customer_phone, `Olá ${r.customer_name.split(' ')[0]}! Sobre sua reserva no ${tenant.name} (${fmt(r.starts_at, tz, "dd/MM 'às' HH:mm")}):`)}
                    target="_blank" rel="noreferrer" className="flex items-center gap-1 rounded-lg border border-ink-600 px-2.5 py-1 text-xs hover:border-lime/50">
                    <MessageCircle className="h-3.5 w-3.5" /> WhatsApp
                  </a>
                </div>
              } />
            {r.customer_email && <Row icon={<Mail className="h-4 w-4" />} value={r.customer_email} />}
            <Row icon={<Globe className="h-4 w-4" />} value={`Origem: ${SOURCE[r.source]}`}
              action={<button onClick={() => { void navigator.clipboard.writeText(r.code); toast('success', 'Código copiado') }} className="flex items-center gap-1 text-xs text-ink-400 hover:text-lime"><Copy className="h-3.5 w-3.5" /> {r.code}</button>} />
          </div>

          {(r.notes || r.internal_notes || r.cancel_reason) && (
            <div className="space-y-3">
              {r.notes && <Note label="Observação do cliente" text={r.notes} />}
              {r.internal_notes && <Note label="Nota interna" text={r.internal_notes} />}
              {r.cancel_reason && <Note label="Motivo do cancelamento" text={r.cancel_reason} />}
            </div>
          )}

          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => setEditing(true)}><Pencil className="h-3.5 w-3.5" /> Editar / remarcar</Button>
            {isManager && <Button variant="ghost" size="sm" onClick={() => setDeleteOpen(true)} className="text-rose-300"><Trash2 className="h-3.5 w-3.5" /> Excluir</Button>}
          </div>

          <div>
            <h4 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-ink-400"><History className="h-3.5 w-3.5" /> Histórico</h4>
            {isLoading ? <Spinner /> : (
              <ol className="relative space-y-4 border-l border-ink-700 pl-5">
                {(events ?? []).map((e) => <EventItem key={e.id} e={e} tz={tz} />)}
              </ol>
            )}
          </div>
        </div>
      </Sheet>

      <ReservationForm open={editing} onClose={() => setEditing(false)} reservation={r} />

      <ConfirmDialog open={cancelOpen} title="Cancelar reserva?" danger confirmLabel="Cancelar reserva" loading={setStatus.isPending}
        description="O horário volta a ficar disponível imediatamente." onClose={() => setCancelOpen(false)}
        onConfirm={() => change('cancelled', reason)}>
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Motivo (opcional)" />
      </ConfirmDialog>

      <ConfirmDialog open={deleteOpen} title="Excluir definitivamente?" danger confirmLabel="Excluir" loading={remove.isPending}
        description="Prefira cancelar: a exclusão remove o histórico desta reserva e não pode ser desfeita."
        onClose={() => setDeleteOpen(false)}
        onConfirm={async () => {
          try { await remove.mutateAsync(r.id); toast('success', 'Reserva excluída'); setDeleteOpen(false); onClose() }
          catch (e) { toast('error', 'Erro ao excluir', errorMessage(e)) }
        }} />
    </>
  )
}

function InfoTile({ icon, label, value }: { icon: React.ReactNode; label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-ink-700 bg-ink-850 p-4">
      <p className="mb-2 flex items-center gap-1.5 text-xs text-ink-400">{icon} {label}</p>
      <div className="text-sm font-medium text-ink-50">{value}</div>
    </div>
  )
}

function Row({ icon, value, action }: { icon: React.ReactNode; value: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 py-1">
      <span className="text-ink-400">{icon}</span>
      <span className="flex-1 truncate text-sm">{value}</span>
      {action}
    </div>
  )
}

function Note({ label, text }: { label: string; text: string }) {
  return (
    <div className="rounded-2xl border border-ink-700 bg-ink-850/60 p-4">
      <p className="mb-1 flex items-center gap-1.5 text-xs text-ink-400"><StickyNote className="h-3.5 w-3.5" /> {label}</p>
      <p className="whitespace-pre-wrap text-sm text-ink-100">{text}</p>
    </div>
  )
}

const FIELD_LABEL: Record<string, string> = {
  starts_at: 'horário', ends_at: 'término', party_size: 'pessoas', customer_name: 'nome', customer_phone: 'telefone',
  customer_email: 'e-mail', notes: 'observações', internal_notes: 'notas internas', status: 'status', table_ids: 'mesa', service_id: 'serviço', staff_id: 'profissional',
}

function EventItem({ e, tz }: { e: ReservationEvent; tz: string }) {
  const who = e.actor_type === 'customer' ? 'Cliente' : e.actor_type === 'system' ? 'Sistema' : 'Equipe'
  let title = 'Atualizada'
  if (e.action === 'created') title = 'Reserva criada'
  if (e.action === 'rescheduled') title = 'Remarcada'
  if (e.action === 'table_changed') title = 'Mesa alterada'
  if (e.action === 'staff_changed') title = 'Profissional alterado'
  if (e.action === 'status_changed' && e.to_status) title = STATUS[e.to_status].label
  const changed = Object.keys(e.changes ?? {}).filter((k) => FIELD_LABEL[k] && e.action !== 'created')
  const moved = e.changes?.starts_at as { from?: string; to?: string } | undefined
  return (
    <li className="relative">
      <span className={cn('absolute -left-[25px] top-1 h-2.5 w-2.5 rounded-full ring-4 ring-ink-900', e.to_status ? STATUS[e.to_status].dot : 'bg-ink-400')} />
      <p className="text-sm font-medium text-ink-100">{title} <span className="font-normal text-ink-400">· {who}</span></p>
      <p className="text-xs text-ink-400">{fmt(e.created_at, tz, "dd/MM/yyyy 'às' HH:mm")}</p>
      {moved?.from && moved?.to && (
        <p className="mt-1 text-xs text-ink-300">{fmt(moved.from, tz, 'dd/MM HH:mm')} → <span className="text-lime">{fmt(moved.to, tz, 'dd/MM HH:mm')}</span></p>
      )}
      {changed.length > 0 && !moved && e.action === 'updated' && (
        <p className="mt-1 text-xs text-ink-400">Alterado: {changed.map((k) => FIELD_LABEL[k]).join(', ')}</p>
      )}
    </li>
  )
}
