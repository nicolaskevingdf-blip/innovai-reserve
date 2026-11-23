import { useEffect, useMemo, useState } from 'react'
import { Clock, Minus, Plus, Search, UserRound, AlertTriangle } from 'lucide-react'
import { Sheet } from '@/components/ui/Sheet'
import { Button, Field, Input, Select, Spinner, Switch, Textarea, Avatar } from '@/components/ui/ui'
import { useToast } from '@/components/ui/Toast'
import { useCurrentTenant } from '@/hooks/useTenant'
import { useBookingSettings } from '@/api/tenant'
import { useReservationMutations, useTenantSlots } from '@/api/reservations'
import { useCustomerSearch } from '@/api/customers'
import { useAreas, useFreeTables, useTables } from '@/api/floor'
import { qualifiedStaff, useFreeStaff, useServiceStaff, useServices, useStaff } from '@/api/staff'
import { errorMessage } from '@/lib/errors'
import { fmtTime, localDateKey, todayKey, zonedToUtcIso } from '@/lib/datetime'
import { SEGMENT, SOURCE, newUnit } from '@/lib/constants'
import { cn, formatPhone, isValidEmail, isValidPhone } from '@/lib/utils'
import type { Customer, Reservation, ReservationSource } from '@/types/db'

export interface ReservationPrefill {
  dateKey?: string
  time?: string
  customer?: Pick<Customer, 'id' | 'name' | 'phone' | 'email'>
  partySize?: number
  staffId?: string
  onCreated?: (reservationId: string) => void
}

export function ReservationForm({ open, onClose, prefill, reservation }: {
  open: boolean; onClose: () => void; prefill?: ReservationPrefill; reservation?: Reservation | null
}) {
  const { tenant } = useCurrentTenant()
  const tz = tenant.timezone
  const toast = useToast()
  const { data: settings } = useBookingSettings(tenant.id)
  const { create, update } = useReservationMutations(tenant.id)
  const editing = !!reservation

  const [customerId, setCustomerId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [dateKey, setDateKey] = useState(todayKey(tz))
  const [time, setTime] = useState<string | null>(null)
  const [customTime, setCustomTime] = useState(false)
  const [party, setParty] = useState(2)
  const [duration, setDuration] = useState<number>(60)
  const [source, setSource] = useState<ReservationSource>('phone')
  const [pending, setPending] = useState(false)
  const [notes, setNotes] = useState('')
  const [internal, setInternal] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [areaId, setAreaId] = useState<string>('')
  const [tableIds, setTableIds] = useState<string[]>([])
  const [serviceId, setServiceId] = useState<string>('')
  const [staffId, setStaffId] = useState<string>('')
  const { data: services = [] } = useServices(tenant.id)
  const { data: staffList = [] } = useStaff(tenant.id)
  const { data: links = [] } = useServiceStaff(tenant.id)
  const { data: areas = [] } = useAreas(tenant.id)
  const { data: allTables = [] } = useTables(tenant.id)

  useEffect(() => {
    if (!open) return
    setError(null)
    setSearch('')
    if (reservation) {
      setCustomerId(reservation.customer_id)
      setName(reservation.customer_name)
      setPhone(formatPhone(reservation.customer_phone))
      setEmail(reservation.customer_email ?? '')
      setDateKey(localDateKey(reservation.starts_at, tz))
      setTime(fmtTime(reservation.starts_at, tz))
      setCustomTime(false)
      setParty(reservation.party_size)
      setDuration(Math.round((+new Date(reservation.ends_at) - +new Date(reservation.starts_at)) / 60000))
      setSource(reservation.source)
      setPending(reservation.status === 'pending')
      setNotes(reservation.notes ?? '')
      setInternal(reservation.internal_notes ?? '')
      setAreaId(reservation.area_id ?? '')
      setTableIds(reservation.table_ids ?? [])
      setServiceId(reservation.service_id ?? '')
      setStaffId(reservation.staff_id ?? '')
    } else {
      setCustomerId(prefill?.customer?.id || null)
      setServiceId('')
      setStaffId(prefill?.staffId ?? '')
      setAreaId('')
      setTableIds([])
      setName(prefill?.customer?.name ?? '')
      setPhone(prefill?.customer ? formatPhone(prefill.customer.phone) : '')
      setEmail(prefill?.customer?.email ?? '')
      setDateKey(prefill?.dateKey ?? todayKey(tz))
      setTime(prefill?.time ?? null)
      setCustomTime(!!prefill?.time)
      setParty(prefill?.partySize ?? (tenant.segment === 'restaurant' ? 2 : 1))
      setSource('phone')
      setPending(false)
      setNotes('')
      setInternal('')
    }
  }, [open, reservation, prefill, tz, tenant.segment])

  useEffect(() => {
    if (open && !reservation && settings) setDuration(settings.default_duration_min)
  }, [open, reservation, settings])

  const tablesMode = settings?.allocation_mode === 'tables'
  const staffMode = settings?.allocation_mode === 'staff'
  const service = services.find((x) => x.id === serviceId)
  const activeServices = services.filter((x) => x.is_active || x.id === serviceId)
  const eligibleStaff = qualifiedStaff(staffList.filter((x) => x.is_active || x.id === staffId), links, serviceId || null)
  useEffect(() => { if (service && !reservation) setDuration(service.duration_min) }, [service, reservation])
  const slots = useTenantSlots(tenant.id, open ? dateKey : null, party, duration, reservation?.id, tablesMode && !tableIds.length ? areaId || null : null,
    staffMode ? serviceId || null : null, staffMode ? staffId || null : null)
  const winStart = time ? zonedToUtcIso(dateKey, time, tz) : null
  const winEnd = winStart ? new Date(+new Date(winStart) + duration * 60000).toISOString() : null
  const free = useFreeTables(tenant.id, open && allTables.length ? winStart : null, winEnd, reservation?.id)
  const freeStaff = useFreeStaff(tenant.id, open && staffList.length ? winStart : null, winEnd, serviceId || null, reservation?.id)
  const pickableTables = allTables.filter((t) => t.is_active && (!areaId || t.area_id === areaId))
  const pickedCapacity = tableIds.reduce((sum, id) => sum + (allTables.find((t) => t.id === id)?.max_capacity ?? 0), 0)
  const slotTimes = useMemo(() => (slots.data ?? []).map((s) => fmtTime(s.slot_start, tz)), [slots.data, tz])
  const { data: matches = [] } = useCustomerSearch(tenant.id, search)

  // keep the currently selected time visible when editing even if it is off-grid
  const showCustomByDefault = editing && time && !slotTimes.includes(time) && !slots.isLoading

  const submit = async () => {
    setError(null)
    if (name.trim().length < 2) return setError('Informe o nome do cliente.')
    if (!isValidPhone(phone)) return setError('Informe um telefone válido com DDD.')
    if (email && !isValidEmail(email)) return setError('E-mail inválido.')
    if (!time) return setError('Escolha um horário.')
    const startsAt = zonedToUtcIso(dateKey, time, tz)
    const endsAt = new Date(+new Date(startsAt) + duration * 60000).toISOString()
    try {
      if (reservation) {
        await update.mutateAsync({
          id: reservation.id,
          patch: {
            customer_name: name.trim(), customer_phone: phone, customer_email: email || null, starts_at: startsAt, ends_at: endsAt,
            party_size: party, source, notes: notes || null, internal_notes: internal || null,
            table_ids: tableIds, area_id: areaId || null,
            service_id: serviceId || null, staff_id: staffId || null,
            staff_requested: !!staffId && (staffId !== reservation.staff_id || reservation.staff_requested),
            ...(reservation.status === 'pending' || reservation.status === 'confirmed' ? { status: pending ? 'pending' : 'confirmed' } : {}),
          },
        })
        toast('success', 'Reserva atualizada')
      } else {
        const r = await create.mutateAsync({
          customer_id: customerId ?? undefined, customer_name: name.trim(), customer_phone: phone, customer_email: email || null,
          starts_at: startsAt, ends_at: endsAt, party_size: party, source, status: pending ? 'pending' : 'confirmed',
          notes: notes || null, internal_notes: internal || null, table_ids: tableIds, area_id: areaId || null,
          service_id: serviceId || null, staff_id: staffId || null, staff_requested: !!staffId,
        })
        prefill?.onCreated?.(r.id)
        toast('success', `${SEGMENT[tenant.segment].unit === 'reserva' ? 'Reserva criada' : 'Agendamento criado'}`, `Código ${r.code}`)
      }
      onClose()
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  const pickCustomer = (c: Customer) => {
    setCustomerId(c.id)
    setName(c.name)
    setPhone(formatPhone(c.phone))
    setEmail(c.email ?? '')
    setSearch('')
  }

  const saving = create.isPending || update.isPending
  const unit = SEGMENT[tenant.segment].unit

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={editing ? `Editar ${unit}` : newUnit(tenant.segment)}
      subtitle={editing ? `Código ${reservation!.code}` : 'Disponibilidade validada em tempo real'}
      footer={
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={onClose} className="flex-1 sm:flex-none">Cancelar</Button>
          <Button onClick={submit} loading={saving} className="flex-1">{editing ? 'Salvar alterações' : `Criar ${unit}`}</Button>
        </div>
      }
    >
      <div className="space-y-6">
        {/* Customer */}
        <section className="space-y-3">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-ink-400">Cliente</h4>
          {!editing && (
            <div className="relative">
              <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar cliente existente por nome ou telefone" className="pl-10" />
              {matches.length > 0 && search.length >= 2 && (
                <div className="absolute inset-x-0 top-full z-10 mt-1.5 overflow-hidden rounded-xl border border-ink-700 bg-ink-850 shadow-2xl">
                  {matches.map((c) => (
                    <button key={c.id} onClick={() => pickCustomer(c)} className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left hover:bg-ink-800">
                      <UserRound className="h-4 w-4 text-ink-400" />
                      <span className="flex-1 truncate text-sm">{c.name}</span>
                      <span className="text-xs text-ink-400">{formatPhone(c.phone)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Nome" className="sm:col-span-2">
              <Input value={name} onChange={(e) => { setName(e.target.value); setCustomerId(null) }} placeholder="Nome do cliente" autoComplete="off" />
            </Field>
            <Field label="Telefone">
              <Input value={phone} onChange={(e) => { setPhone(formatPhone(e.target.value)); setCustomerId(null) }} placeholder="(11) 98888-7777" inputMode="tel" />
            </Field>
            <Field label="E-mail" hint="opcional">
              <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="cliente@email.com" type="email" />
            </Field>
          </div>
        </section>

        {/* Service & professional */}
        {(services.length > 0 || staffList.length > 0) && (
          <section className="space-y-3">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-ink-400">Serviço e profissional</h4>
            {services.length > 0 && (
              <Field label="Serviço" hint={service ? `${service.duration_min} min${service.buffer_min ? ` + ${service.buffer_min} preparo` : ''}` : undefined}>
                <Select value={serviceId} onChange={(e) => { setServiceId(e.target.value); setTime(null) }}>
                  <option value="">{staffMode ? 'Selecione o serviço' : 'Sem serviço específico'}</option>
                  {activeServices.map((x) => <option key={x.id} value={x.id}>{x.name} · {x.duration_min} min</option>)}
                </Select>
              </Field>
            )}
            {staffList.length > 0 && (
              <div>
                <span className="label">Profissional</span>
                <div className="flex flex-wrap gap-1.5">
                  <button type="button" onClick={() => setStaffId('')}
                    className={cn('chip px-3 py-1.5 text-xs', !staffId ? 'border-lime/60 bg-lime/15 text-lime' : 'border-ink-600 text-ink-200')}>
                    {staffMode ? 'Qualquer profissional' : 'Nenhum'}
                  </button>
                  {eligibleStaff.map((p) => {
                    const st = freeStaff.data?.get(p.id)
                    const busy = !!st && (!st.is_free || !st.is_working)
                    return (
                      <button key={p.id} type="button" onClick={() => setStaffId(p.id)}
                        className={cn('flex items-center gap-1.5 rounded-full border py-1 pl-1 pr-3 text-xs transition',
                          staffId === p.id ? 'border-lime/60 bg-lime/15 text-lime' : busy ? 'border-ink-800 text-ink-500' : 'border-ink-600 text-ink-200 hover:border-ink-400')}>
                        <Avatar name={p.name} src={p.photo_url} size={20} /> {p.name}
                        {st && !st.is_working && <span className="text-[10px] text-ink-500">fora do horário</span>}
                        {st && st.is_working && !st.is_free && <span className="text-[10px] text-ink-500">ocupado</span>}
                      </button>
                    )
                  })}
                </div>
                {staffMode && !staffId && <p className="mt-2 text-xs text-ink-500">O sistema escolhe quem estiver livre, equilibrando a agenda do dia.</p>}
              </div>
            )}
          </section>
        )}

        {/* When */}
        <section className="space-y-3">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-ink-400">Data e horário</h4>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Data">
              <Input type="date" value={dateKey} onChange={(e) => { setDateKey(e.target.value); if (!customTime) setTime(null) }} />
            </Field>
            <Field label={SEGMENT[tenant.segment].partyLabel}>
              <div className="flex h-11 items-center justify-between rounded-xl border border-ink-600 bg-ink-850 px-1.5">
                <button type="button" onClick={() => setParty((p) => Math.max(1, p - 1))} className="grid h-8 w-8 place-items-center rounded-lg text-ink-200 hover:bg-ink-700"><Minus className="h-4 w-4" /></button>
                <span className="text-sm font-semibold tabular-nums">{party}</span>
                <button type="button" onClick={() => setParty((p) => Math.min(500, p + 1))} className="grid h-8 w-8 place-items-center rounded-lg text-ink-200 hover:bg-ink-700"><Plus className="h-4 w-4" /></button>
              </div>
            </Field>
          </div>

          {!customTime && !showCustomByDefault ? (
            <div>
              <div className="mb-2 flex items-center justify-between">
                <span className="label mb-0">Horários disponíveis</span>
                <button type="button" onClick={() => setCustomTime(true)} className="text-xs font-medium text-ink-300 hover:text-lime">Horário personalizado</button>
              </div>
              {slots.isLoading ? (
                <div className="grid h-20 place-items-center"><Spinner /></div>
              ) : slotTimes.length === 0 ? (
                <div className="rounded-xl border border-dashed border-ink-700 px-4 py-5 text-center text-sm text-ink-400">
                  Nenhum horário livre nesta data com as regras atuais.
                </div>
              ) : (
                <div className="grid grid-cols-4 gap-2 sm:grid-cols-5">
                  {slotTimes.map((t) => (
                    <button key={t} type="button" onClick={() => setTime(t)}
                      className={cn('h-10 rounded-xl border text-sm font-semibold tabular-nums transition',
                        time === t ? 'border-lime bg-lime text-ink-950' : 'border-ink-700 bg-ink-850 text-ink-100 hover:border-lime/50')}>
                      {t}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Horário">
                <Input type="time" value={time ?? ''} onChange={(e) => setTime(e.target.value)} step={300} />
              </Field>
              <div className="flex items-end">
                <button type="button" onClick={() => { setCustomTime(false); setTime(null) }} className="mb-3 text-xs font-medium text-ink-300 hover:text-lime">
                  Ver horários disponíveis
                </button>
              </div>
              <p className="col-span-2 -mt-1 flex items-start gap-2 text-xs text-ink-400">
                <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0" /> Horários fora da grade ainda respeitam bloqueios e a capacidade máxima.
              </p>
            </div>
          )}

          {allTables.length > 0 && (
            <div className="space-y-3 rounded-2xl border border-ink-700 bg-ink-850/60 p-3.5">
              {areas.length > 0 && (
                <Field label="Ambiente">
                  <Select value={areaId} onChange={(e) => { setAreaId(e.target.value); setTableIds([]) }}>
                    <option value="">Qualquer ambiente</option>
                    {areas.filter((a) => a.is_active).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </Select>
                </Field>
              )}
              <div>
                <span className="label flex items-center justify-between">
                  <span>Mesa(s)</span>
                  <span className="normal-case tracking-normal text-ink-400">
                    {tableIds.length ? `${pickedCapacity} lugares` : tablesMode ? 'automática (melhor encaixe)' : 'opcional'}
                  </span>
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {pickableTables.map((t) => {
                    const isFree = free.data?.get(t.id) ?? true
                    const on = tableIds.includes(t.id)
                    return (
                      <button key={t.id} type="button" disabled={!isFree && !on}
                        onClick={() => setTableIds((ids) => (on ? ids.filter((x) => x !== t.id) : [...ids, t.id]))}
                        className={cn('chip px-2.5 py-1 text-xs transition', on ? 'border-lime/60 bg-lime/15 text-lime' : isFree ? 'border-ink-600 text-ink-200 hover:border-ink-400' : 'border-ink-800 text-ink-600 line-through')}>
                        {t.name} <span className="text-ink-500">{t.max_capacity}</span>
                      </button>
                    )
                  })}
                </div>
                {tableIds.length > 0 && pickedCapacity < party && (
                  <p className="mt-2 text-xs text-amber-300">As mesas escolhidas têm {pickedCapacity} lugares para {party} pessoas.</p>
                )}
                {!time && <p className="mt-2 text-xs text-ink-500">Escolha o horário para ver quais mesas estão livres.</p>}
              </div>
            </div>
          )}

          <Field label="Duração" hint={`${duration} min`}>
            <input type="range" min={15} max={300} step={15} value={duration} onChange={(e) => setDuration(Number(e.target.value))} className="w-full accent-[#C6F432]" />
          </Field>
        </section>

        {/* Details */}
        <section className="space-y-3">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-ink-400">Detalhes</h4>
          <Field label="Origem">
            <Select value={source} onChange={(e) => setSource(e.target.value as ReservationSource)}>
              {(Object.keys(SOURCE) as ReservationSource[]).filter((s) => s !== 'online' || reservation?.source === 'online').map((s) => (
                <option key={s} value={s}>{SOURCE[s]}</option>
              ))}
            </Select>
          </Field>
          {(!editing || reservation?.status === 'pending' || reservation?.status === 'confirmed') && (
            <Switch checked={pending} onChange={setPending} label="Aguardando confirmação" description="Marque se o cliente ainda precisa confirmar presença." />
          )}
          <Field label="Observações do cliente"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Aniversário, alergias, preferências…" maxLength={1000} /></Field>
          <Field label="Notas internas" hint="visível só para a equipe"><Textarea value={internal} onChange={(e) => setInternal(e.target.value)} maxLength={2000} /></Field>
        </section>

        {error && (
          <div className="flex items-start gap-2.5 rounded-xl border border-rose-400/30 bg-rose-400/10 px-3.5 py-3 text-sm text-rose-200 animate-fade-up">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {error}
          </div>
        )}
      </div>
    </Sheet>
  )
}
