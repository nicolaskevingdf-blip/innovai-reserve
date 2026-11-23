import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { CalendarOff, CalendarDays, ImagePlus, Plus, Trash2, UserRound } from 'lucide-react'
import { useCurrentTenant } from '@/hooks/useTenant'
import { useServiceStaff, useServices, useStaff, useStaffHours, useStaffMutations } from '@/api/staff'
import { uploadTenantAsset, useBookingSettings, useTeam, useUpdateBookingSettings } from '@/api/tenant'
import { useBlockMutations, useBlocks, useReservations } from '@/api/reservations'
import { Avatar, Button, Card, EmptyState, Field, Input, Segmented, Select, Switch, Textarea } from '@/components/ui/ui'
import { ConfirmDialog, Sheet } from '@/components/ui/Sheet'
import { useToast } from '@/components/ui/Toast'
import { dayRangeUtc, fmt, shiftKey, todayKey, WEEKDAYS, zonedToUtcIso } from '@/lib/datetime'
import { errorMessage } from '@/lib/errors'
import { cn } from '@/lib/utils'
import type { Staff as StaffT } from '@/types/db'

const COLORS = ['#C6F432', '#22D3EE', '#F59E0B', '#F43F5E', '#A78BFA', '#10B981', '#60A5FA', '#F472B6']

/** Shown on Services / Professionals while the agenda is not yet per-professional. */
export function StaffModeBanner() {
  const { tenant, isManager } = useCurrentTenant()
  const { data: settings } = useBookingSettings(tenant.id)
  const { data: staff = [] } = useStaff(tenant.id)
  const update = useUpdateBookingSettings(tenant.id)
  const toast = useToast()
  if (!settings || settings.allocation_mode === 'staff' || tenant.segment === 'restaurant') return null
  const active = staff.filter((s) => s.is_active).length
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-lime/30 bg-lime/[0.06] px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
      <span className="text-ink-100">
        <b>Agenda por profissional desativada.</b> Ative para que cada horário considere quem está livre, a duração do serviço e o intervalo de preparo.
        {!active && ' Cadastre ao menos um profissional ativo.'}
      </span>
      {isManager && (
        <Button size="sm" disabled={!active} loading={update.isPending} onClick={async () => {
          try { await update.mutateAsync({ allocation_mode: 'staff' }); toast('success', 'Agenda por profissional ativada') }
          catch (e) { toast('error', 'Erro', errorMessage(e)) }
        }}>Ativar agora</Button>
      )}
    </div>
  )
}

export default function StaffPage() {
  const { tenant, isManager } = useCurrentTenant()
  const tz = tenant.timezone
  const { data: staff = [], isLoading } = useStaff(tenant.id)
  const { data: services = [] } = useServices(tenant.id)
  const { data: links = [] } = useServiceStaff(tenant.id)
  const today = todayKey(tz)
  const r = dayRangeUtc(today, today, tz)
  const { data: todays = [] } = useReservations(tenant.id, { from: r.from, to: r.to, status: ['pending', 'confirmed', 'in_progress', 'completed'] })
  const [selected, setSelected] = useState<StaffT | null>(null)
  const [creating, setCreating] = useState(false)

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-2xl font-bold md:text-3xl">Profissionais</h1>
          <p className="mt-1 text-sm text-ink-400">Horários individuais, folgas, intervalos e serviços de cada profissional.</p>
        </div>
        {isManager && <Button size="sm" className="h-9" onClick={() => setCreating(true)}><Plus className="h-3.5 w-3.5" /> Novo profissional</Button>}
      </div>
      <StaffModeBanner />

      {isLoading ? <div className="skeleton h-40 rounded-2xl" /> : staff.length === 0 ? (
        <Card><EmptyState icon={<UserRound className="h-6 w-6" />} title="Cadastre sua equipe" description="Cada profissional tem agenda própria. O cliente pode escolher com quem quer ser atendido ou deixar o sistema escolher."
          action={isManager ? <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Adicionar profissional</Button> : undefined} /></Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {staff.map((p) => {
            const mine = todays.filter((x) => x.staff_id === p.id)
            const svc = links.filter((l) => l.staff_id === p.id).map((l) => services.find((s) => s.id === l.service_id)?.name).filter(Boolean)
            return (
              <button key={p.id} onClick={() => isManager && setSelected(p)} className={cn('card flex items-start gap-4 p-5 text-left transition hover:border-ink-600', !p.is_active && 'opacity-50')}>
                <div className="relative">
                  <Avatar name={p.name} src={p.photo_url} size={56} />
                  <span className="absolute -bottom-0.5 -right-0.5 h-4 w-4 rounded-full border-2 border-ink-900" style={{ background: p.color }} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold">{p.name}</p>
                  <p className="truncate text-xs text-ink-400">{p.specialty || 'Profissional'}{!p.is_active && ' · inativo'}</p>
                  <p className="mt-2 line-clamp-1 text-xs text-ink-300">{svc.length ? svc.join(' · ') : 'Todos os serviços sem vínculo'}</p>
                  <div className="mt-3 flex items-center gap-3 text-xs">
                    <span className="flex items-center gap-1 text-ink-300"><CalendarDays className="h-3.5 w-3.5 text-ink-500" /> {mine.length} hoje</span>
                    {mine[0] && <span className="text-ink-500">próx. {fmt(mine.find((x) => +new Date(x.ends_at) > Date.now())?.starts_at ?? mine[0].starts_at, tz, 'HH:mm')}</span>}
                    <Link to={`/app/agenda?staff=${p.id}`} onClick={(e) => e.stopPropagation()} className="ml-auto font-semibold text-lime hover:underline">Agenda →</Link>
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      )}
      <StaffEditor open={!!selected || creating} staff={selected} onClose={() => { setSelected(null); setCreating(false) }} />
    </div>
  )
}

interface Shift { weekday: number; opens_at: string; closes_at: string }

function StaffEditor({ open, staff, onClose }: { open: boolean; staff: StaffT | null; onClose: () => void }) {
  const { tenant } = useCurrentTenant()
  const tz = tenant.timezone
  const toast = useToast()
  const { data: services = [] } = useServices(tenant.id)
  const { data: links = [] } = useServiceStaff(tenant.id)
  const { data: allHours = [] } = useStaffHours(tenant.id)
  const { data: team = [] } = useTeam(tenant.id)
  const { saveStaff, deleteStaff } = useStaffMutations(tenant.id)
  const [tab, setTab] = useState<'perfil' | 'horarios' | 'servicos' | 'folgas'>('perfil')
  const [f, setF] = useState({ name: '', specialty: '', bio: '', photo_url: null as string | null, color: COLORS[0], is_active: true, member_id: '' })
  const [shifts, setShifts] = useState<Shift[]>([])
  const [ownHours, setOwnHours] = useState(false)
  const [serviceIds, setServiceIds] = useState<string[]>([])
  const [uploading, setUploading] = useState(false)
  const [confirm, setConfirm] = useState(false)

  useEffect(() => {
    if (!open) return
    setTab('perfil')
    setF({ name: staff?.name ?? '', specialty: staff?.specialty ?? '', bio: staff?.bio ?? '', photo_url: staff?.photo_url ?? null,
      color: staff?.color ?? COLORS[Math.floor(Math.random() * COLORS.length)], is_active: staff?.is_active ?? true, member_id: staff?.member_id ?? '' })
    const h = staff ? allHours.filter((x) => x.staff_id === staff.id).map((x) => ({ weekday: x.weekday, opens_at: x.opens_at.slice(0, 5), closes_at: x.closes_at.slice(0, 5) })) : []
    setShifts(h)
    setOwnHours(h.length > 0)
    setServiceIds(staff ? links.filter((l) => l.staff_id === staff.id).map((l) => l.service_id) : [])
  }, [open, staff, allHours, links])

  const save = async () => {
    if (f.name.trim().length < 2) return toast('error', 'Informe o nome')
    if (ownHours && shifts.some((s) => s.closes_at <= s.opens_at)) return toast('error', 'Há turno com fim antes do início')
    try {
      await saveStaff.mutateAsync({ staff: { ...f, id: staff?.id, member_id: f.member_id || null }, hours: ownHours ? shifts : [], serviceIds })
      toast('success', staff ? 'Profissional atualizado' : 'Profissional cadastrado')
      onClose()
    } catch (e) { toast('error', 'Erro ao salvar', errorMessage(e)) }
  }

  const order = [1, 2, 3, 4, 5, 6, 0]
  const upd = (i: number, patch: Partial<Shift>) => setShifts((s) => s.map((x, j) => (j === i ? { ...x, ...patch } : x)))

  return (
    <>
      <Sheet open={open} onClose={onClose} wide title={staff ? staff.name : 'Novo profissional'}
        subtitle={<Segmented value={tab} onChange={setTab} className="mt-2" options={[
          { value: 'perfil', label: 'Perfil' }, { value: 'horarios', label: 'Horários' }, { value: 'servicos', label: 'Serviços' },
          ...(staff ? [{ value: 'folgas' as const, label: 'Folgas' }] : []),
        ]} />}
        footer={tab !== 'folgas' ? <div className="flex gap-2">
          {staff && <Button variant="ghost" className="text-rose-300" onClick={() => setConfirm(true)}><Trash2 className="h-4 w-4" /></Button>}
          <Button className="flex-1" onClick={save} loading={saveStaff.isPending}>Salvar</Button>
        </div> : undefined}>
        {tab === 'perfil' && (
          <div className="space-y-4">
            <div className="flex items-center gap-4">
              <label className="relative grid h-20 w-20 cursor-pointer place-items-center overflow-hidden rounded-full border border-dashed border-ink-600 bg-ink-850 hover:border-lime/50">
                {f.photo_url ? <img src={f.photo_url} alt="" className="h-full w-full object-cover" /> : <ImagePlus className="h-6 w-6 text-ink-400" />}
                {uploading && <span className="absolute inset-0 grid place-items-center bg-black/60 text-[10px]">Enviando…</span>}
                <input type="file" accept="image/*" className="hidden" onChange={async (e) => {
                  const file = e.target.files?.[0]; if (!file) return
                  setUploading(true)
                  try { setF((x) => ({ ...x, photo_url: null })); const url = await uploadTenantAsset(tenant.id, file, 'staff'); setF((x) => ({ ...x, photo_url: url })) }
                  catch (err) { toast('error', 'Falha no upload', errorMessage(err)) } finally { setUploading(false) }
                }} />
              </label>
              <div className="text-xs text-ink-400">Foto exibida na página de agendamento.<br />JPG ou PNG até 5 MB.</div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Nome"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
              <Field label="Especialidade"><Input value={f.specialty} onChange={(e) => setF({ ...f, specialty: e.target.value })} placeholder="Ex.: Degradê, coloração" /></Field>
            </div>
            <Field label="Sobre" hint="opcional"><Textarea value={f.bio} onChange={(e) => setF({ ...f, bio: e.target.value })} /></Field>
            <div>
              <p className="label">Cor na agenda</p>
              <div className="flex gap-2">{COLORS.map((c) => <button key={c} type="button" onClick={() => setF({ ...f, color: c })} style={{ background: c }}
                className={cn('h-8 w-8 rounded-lg ring-offset-2 ring-offset-ink-900', f.color === c && 'ring-2 ring-white')} />)}</div>
            </div>
            <Field label="Acesso ao painel" hint="vincula a uma pessoa da equipe">
              <Select value={f.member_id} onChange={(e) => setF({ ...f, member_id: e.target.value })}>
                <option value="">Sem acesso (apenas agenda)</option>
                {team.map((m) => <option key={m.member_id} value={m.member_id}>{m.full_name || m.email} · {m.email}</option>)}
              </Select>
            </Field>
            <p className="-mt-2 text-xs text-ink-500">Quem estiver vinculado abre a agenda já filtrada em “Minha agenda”.</p>
            <Switch checked={f.is_active} onChange={(v) => setF({ ...f, is_active: v })} label="Ativo" description="Profissionais inativos não recebem novos agendamentos." />
          </div>
        )}

        {tab === 'horarios' && (
          <div className="space-y-4">
            <Switch checked={ownHours} onChange={(v) => { setOwnHours(v); if (v && !shifts.length) setShifts([1, 2, 3, 4, 5].map((d) => ({ weekday: d, opens_at: '09:00', closes_at: '18:00' }))) }}
              label="Horário próprio" description="Desligado: segue o horário de funcionamento do estabelecimento. Use dois turnos no mesmo dia para o intervalo de almoço." />
            {ownHours && (
              <div className="divide-y divide-ink-800 rounded-2xl border border-ink-700">
                {order.map((d) => {
                  const day = shifts.map((s, i) => ({ s, i })).filter(({ s }) => s.weekday === d)
                  return (
                    <div key={d} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-start">
                      <div className="w-28 pt-1.5 text-sm font-semibold">{WEEKDAYS[d]}<span className={cn('block text-xs font-normal', day.length ? 'text-lime' : 'text-ink-500')}>{day.length ? 'Trabalha' : 'Folga'}</span></div>
                      <div className="flex-1 space-y-2">
                        {day.map(({ s, i }) => (
                          <div key={i} className="flex items-center gap-2">
                            <Input type="time" value={s.opens_at} onChange={(e) => upd(i, { opens_at: e.target.value })} className="h-9 w-[124px]" />
                            <span className="text-ink-500">–</span>
                            <Input type="time" value={s.closes_at} onChange={(e) => upd(i, { closes_at: e.target.value })} className="h-9 w-[124px]" />
                            <button onClick={() => setShifts((all) => all.filter((_, j) => j !== i))} className="rounded-lg p-2 text-ink-400 hover:text-rose-300"><Trash2 className="h-4 w-4" /></button>
                          </div>
                        ))}
                        <button onClick={() => setShifts((all) => [...all, { weekday: d, opens_at: day.length ? '13:00' : '09:00', closes_at: day.length ? '18:00' : '12:00' }])}
                          className="flex items-center gap-1 text-xs font-medium text-ink-300 hover:text-lime"><Plus className="h-3.5 w-3.5" /> {day.length ? 'Adicionar turno (após intervalo)' : 'Adicionar turno'}</button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
            <p className="text-xs text-ink-500">Agendamentos só são oferecidos quando o profissional está trabalhando e o estabelecimento está aberto.</p>
          </div>
        )}

        {tab === 'servicos' && (
          <div className="space-y-2">
            {services.length === 0 && <p className="text-sm text-ink-500">Nenhum serviço cadastrado. <Link to="/app/servicos" className="text-lime hover:underline">Cadastrar serviços →</Link></p>}
            {services.map((s) => (
              <label key={s.id} className="flex cursor-pointer items-center gap-3 rounded-xl border border-ink-700 bg-ink-850 px-3 py-2.5">
                <input type="checkbox" className="accent-[#C6F432]" checked={serviceIds.includes(s.id)}
                  onChange={(e) => setServiceIds((ids) => (e.target.checked ? [...ids, s.id] : ids.filter((x) => x !== s.id)))} />
                <span className="flex-1 text-sm">{s.name}</span>
                <span className="text-xs text-ink-500">{s.duration_min} min</span>
              </label>
            ))}
          </div>
        )}

        {tab === 'folgas' && staff && <StaffTimeOff staffId={staff.id} tz={tz} />}
      </Sheet>
      <ConfirmDialog open={confirm} danger title={`Excluir ${staff?.name}?`} confirmLabel="Excluir" loading={deleteStaff.isPending}
        description="Agendamentos existentes ficam sem profissional. Prefira desativar." onClose={() => setConfirm(false)}
        onConfirm={async () => {
          try { await deleteStaff.mutateAsync(staff!.id); toast('success', 'Profissional excluído'); setConfirm(false); onClose() }
          catch (e) { toast('error', 'Erro', errorMessage(e)) }
        }} />
    </>
  )
}

function StaffTimeOff({ staffId, tz }: { staffId: string; tz: string }) {
  const { tenant } = useCurrentTenant()
  const toast = useToast()
  const today = todayKey(tz)
  const range = dayRangeUtc(today, shiftKey(today, 120), tz)
  const { data: blocks = [] } = useBlocks(tenant.id, range.from, range.to)
  const { create, remove } = useBlockMutations(tenant.id)
  const mine = useMemo(() => blocks.filter((b) => b.staff_id === staffId), [blocks, staffId])
  const [from, setFrom] = useState(today)
  const [to, setTo] = useState(today)
  const [allDay, setAllDay] = useState(true)
  const [start, setStart] = useState('12:00')
  const [end, setEnd] = useState('13:00')
  const [reason, setReason] = useState('')

  const add = async () => {
    const s = zonedToUtcIso(from, allDay ? '00:00' : start, tz)
    const e = allDay ? zonedToUtcIso(shiftKey(to, 1), '00:00', tz) : zonedToUtcIso(from, end, tz)
    if (+new Date(e) <= +new Date(s)) return toast('error', 'O fim deve ser depois do início')
    try { await create.mutateAsync({ starts_at: s, ends_at: e, reason: reason || (allDay ? 'Folga' : 'Intervalo'), staff_id: staffId }); toast('success', 'Período bloqueado na agenda do profissional'); setReason('') }
    catch (err) { toast('error', 'Erro', errorMessage(err)) }
  }

  return (
    <div className="space-y-5">
      <div className="space-y-3 rounded-2xl border border-ink-700 bg-ink-850/60 p-4">
        <p className="text-sm font-semibold">Adicionar folga, férias ou intervalo pontual</p>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} className="accent-[#C6F432]" /> Dias inteiros</label>
        <div className="grid grid-cols-2 gap-3">
          <Field label={allDay ? 'De' : 'Data'}><Input type="date" value={from} onChange={(e) => { setFrom(e.target.value); if (e.target.value > to) setTo(e.target.value) }} /></Field>
          {allDay ? <Field label="Até"><Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></Field> : (
            <div className="grid grid-cols-2 gap-2">
              <Field label="Início"><Input type="time" value={start} onChange={(e) => setStart(e.target.value)} /></Field>
              <Field label="Fim"><Input type="time" value={end} onChange={(e) => setEnd(e.target.value)} /></Field>
            </div>
          )}
        </div>
        <Field label="Motivo" hint="opcional"><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Férias, consulta médica…" /></Field>
        <Button onClick={add} loading={create.isPending} className="w-full"><CalendarOff className="h-4 w-4" /> Bloquear agenda</Button>
        <p className="text-xs text-ink-500">Agendamentos já marcados no período não são cancelados automaticamente.</p>
      </div>
      <div>
        <p className="label">Próximos bloqueios</p>
        {mine.length === 0 ? <p className="text-sm text-ink-500">Nenhum bloqueio.</p> : (
          <div className="space-y-2">
            {mine.map((b) => (
              <div key={b.id} className="flex items-center gap-3 rounded-xl border border-ink-700 bg-ink-850 px-3 py-2.5">
                <CalendarOff className="h-4 w-4 text-ink-400" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm">{fmt(b.starts_at, tz, 'dd/MM HH:mm')} → {fmt(b.ends_at, tz, 'dd/MM HH:mm')}</p>
                  {b.reason && <p className="text-xs text-ink-400">{b.reason}</p>}
                </div>
                <button onClick={() => remove.mutate(b.id)} className="rounded-lg p-1.5 text-ink-400 hover:text-rose-300"><Trash2 className="h-4 w-4" /></button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
