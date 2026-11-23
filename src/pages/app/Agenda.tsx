import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Ban, ChevronLeft, ChevronRight, Lock, Plus, Search, Trash2 } from 'lucide-react'
import { useCurrentTenant } from '@/hooks/useTenant'
import { useBlockMutations, useBlocks, useReservations } from '@/api/reservations'
import { useBusinessHours, useBookingSettings } from '@/api/tenant'
import { useTables } from '@/api/floor'
import { useStaff, useStaffHours } from '@/api/staff'
import { Avatar, Button, Card, EmptyState, Field, Input, Segmented, Select } from '@/components/ui/ui'
import type { Staff, StaffHour } from '@/types/db'
import { useShell } from '@/components/layout/AppShell'
import { Sheet } from '@/components/ui/Sheet'
import { useToast } from '@/components/ui/Toast'
import { ReservationDetail, StatusBadge } from '@/components/reservations/ReservationDetail'
import {
  dayRangeUtc, fmt, fmtTime, keyLabel, keyToDate, localDateKey, minutesOfDay, monthGridKeys, shiftKey, todayKey, weekKeys, zonedToUtcIso,
} from '@/lib/datetime'
import { STATUS, STATUS_ORDER } from '@/lib/constants'
import { errorMessage } from '@/lib/errors'
import { cn } from '@/lib/utils'
import type { Reservation, ReservationStatus, ScheduleBlock } from '@/types/db'

type View = 'day' | 'week' | 'month' | 'list'
const HOUR_PX = 72

export default function Agenda() {
  const { tenant, memberships, role } = useCurrentTenant()
  const tz = tenant.timezone
  const { newReservation } = useShell()
  const [params, setParams] = useSearchParams()
  const [view, setView] = useState<View>((params.get('view') as View) || 'day')
  const [dateKey, setDateKey] = useState(params.get('date') || todayKey(tz))
  const [statusFilter, setStatusFilter] = useState<ReservationStatus | 'all' | 'active'>('active')
  const [search, setSearch] = useState('')
  const [tableFilter, setTableFilter] = useState('')
  const { data: tables = [] } = useTables(tenant.id)
  const { data: staffList = [] } = useStaff(tenant.id)
  const { data: staffHours = [] } = useStaffHours(tenant.id)
  const { data: settings } = useBookingSettings(tenant.id)
  const staffMode = settings?.allocation_mode === 'staff'
  const myMemberId = memberships.find((m) => m.tenant_id === tenant.id)?.id
  const myStaff = staffList.find((x) => x.member_id && x.member_id === myMemberId)
  const [staffFilter, setStaffFilter] = useState(params.get('staff') ?? '')
  // professionals linked to their login open on their own agenda
  useEffect(() => { if (!params.get('staff') && myStaff && role === 'staff') setStaffFilter(myStaff.id) }, [myStaff, role]) // eslint-disable-line react-hooks/exhaustive-deps
  const [selected, setSelected] = useState<Reservation | null>(null)
  const [blockOpen, setBlockOpen] = useState(false)

  useEffect(() => { setParams({ view, date: dateKey, ...(staffFilter ? { staff: staffFilter } : {}) }, { replace: true }) }, [view, dateKey, staffFilter, setParams])

  const range = useMemo(() => {
    if (view === 'day') return { keys: [dateKey], from: dateKey, to: dateKey }
    if (view === 'month') { const k = monthGridKeys(dateKey); return { keys: k, from: k[0], to: k[k.length - 1] } }
    const k = weekKeys(dateKey)
    return { keys: k, from: k[0], to: k[6] }
  }, [view, dateKey])

  const utc = dayRangeUtc(range.from, range.to, tz)
  const status = statusFilter === 'all' ? undefined : statusFilter === 'active' ? (['pending', 'confirmed', 'in_progress', 'completed', 'no_show'] as ReservationStatus[]) : [statusFilter]
  const { data: allReservations = [], isLoading } = useReservations(tenant.id, { from: utc.from, to: utc.to, status, search })
  const reservations = useMemo(() => allReservations
    .filter((r) => !tableFilter || r.table_ids?.includes(tableFilter))
    .filter((r) => !staffFilter || r.staff_id === staffFilter), [allReservations, tableFilter, staffFilter])
  const { data: blocks = [] } = useBlocks(tenant.id, utc.from, utc.to)
  const { data: hours = [] } = useBusinessHours(tenant.id)

  // keep the detail sheet in sync with realtime updates
  useEffect(() => {
    if (selected) { const fresh = reservations.find((r) => r.id === selected.id); if (fresh && fresh.updated_at !== selected.updated_at) setSelected(fresh) }
  }, [reservations, selected])

  const byDay = useMemo(() => {
    const map = new Map<string, Reservation[]>()
    for (const r of reservations) { const k = localDateKey(r.starts_at, tz); map.set(k, [...(map.get(k) ?? []), r]) }
    return map
  }, [reservations, tz])

  const step = (dir: number) => {
    if (view === 'day') setDateKey(shiftKey(dateKey, dir))
    else if (view === 'month') { const d = keyToDate(dateKey); d.setMonth(d.getMonth() + dir); setDateKey(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`) }
    else setDateKey(shiftKey(dateKey, 7 * dir))
  }

  const title = view === 'day' ? keyLabel(dateKey, "EEEE, d 'de' MMMM")
    : view === 'month' ? keyLabel(dateKey, "MMMM 'de' yyyy")
    : `${keyLabel(range.from, 'd MMM')} – ${keyLabel(range.to, "d MMM yyyy")}`

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex items-center gap-3">
          <div className="flex items-center rounded-xl border border-ink-700 bg-ink-850">
            <button onClick={() => step(-1)} className="grid h-10 w-10 place-items-center text-ink-300 hover:text-ink-50" aria-label="Anterior"><ChevronLeft className="h-4 w-4" /></button>
            <button onClick={() => setDateKey(todayKey(tz))} className="h-10 border-x border-ink-700 px-3 text-xs font-semibold text-ink-200 hover:text-lime">Hoje</button>
            <button onClick={() => step(1)} className="grid h-10 w-10 place-items-center text-ink-300 hover:text-ink-50" aria-label="Próximo"><ChevronRight className="h-4 w-4" /></button>
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-xl font-bold first-letter:uppercase md:text-2xl">
              <span className="md:hidden">{view === 'day' ? keyLabel(dateKey, "EEE, d 'de' MMM") : title}</span>
              <span className="hidden md:inline">{title}</span>
            </h1>
          </div>
          <input type="date" value={dateKey} onChange={(e) => e.target.value && setDateKey(e.target.value)}
            className="ml-auto h-10 w-10 cursor-pointer rounded-xl border border-ink-700 bg-ink-850 text-transparent xl:ml-0" title="Ir para data" />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented value={view} onChange={setView} options={[{ value: 'day', label: 'Dia' }, { value: 'week', label: 'Semana' }, { value: 'month', label: 'Mês' }, { value: 'list', label: 'Lista' }]} />
          <Button variant="secondary" size="sm" className="h-9" onClick={() => setBlockOpen(true)}><Lock className="h-3.5 w-3.5" /> Bloquear</Button>
          <Button size="sm" className="hidden h-9 lg:inline-flex" onClick={() => newReservation({ dateKey })}><Plus className="h-3.5 w-3.5" /> Nova</Button>
        </div>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar por nome, telefone ou código" className="pl-10" />
        </div>
        <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)} className="sm:w-56">
          <option value="active">Ocultar canceladas</option>
          <option value="all">Todos os status</option>
          {STATUS_ORDER.map((s) => <option key={s} value={s}>{STATUS[s].label}</option>)}
        </Select>
        {staffList.length > 0 && (
          <Select value={staffFilter} onChange={(e) => setStaffFilter(e.target.value)} className="sm:w-52">
            <option value="">Todos os profissionais</option>
            {myStaff && <option value={myStaff.id}>Minha agenda</option>}
            {staffList.filter((x) => x.is_active || x.id === staffFilter).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </Select>
        )}
        {tables.length > 0 && (
          <Select value={tableFilter} onChange={(e) => setTableFilter(e.target.value)} className="sm:w-44">
            <option value="">Todas as mesas</option>
            {tables.map((t) => <option key={t.id} value={t.id}>Mesa {t.name}</option>)}
          </Select>
        )}
      </div>

      {view === 'day' && staffMode && !staffFilter && staffList.some((x) => x.is_active) && (
        <StaffDayView dateKey={dateKey} tz={tz} reservations={byDay.get(dateKey) ?? []} blocks={blocks}
          staff={staffList.filter((x) => x.is_active)} staffHours={staffHours}
          hours={hours.filter((h) => h.weekday === keyToDate(dateKey).getDay())}
          onSelect={setSelected} onEmptyClick={(time, sid) => newReservation({ dateKey, time, staffId: sid })} />
      )}

      {view === 'day' && !(staffMode && !staffFilter && staffList.some((x) => x.is_active)) && (() => {
        const dow = keyToDate(dateKey).getDay()
        const own = staffFilter ? staffHours.filter((h) => h.staff_id === staffFilter) : []
        const dayHours = own.length ? own.filter((h) => h.weekday === dow) : hours.filter((h) => h.weekday === dow)
        return (
          <DayTimeline dateKey={dateKey} tz={tz} reservations={byDay.get(dateKey) ?? []}
            blocks={blocks.filter((b) => !b.staff_id || b.staff_id === staffFilter)}
            hours={dayHours} loading={isLoading} onSelect={setSelected}
            onEmptyClick={(time) => newReservation({ dateKey, time, staffId: staffFilter || undefined })} />
        )
      })()}

      {view === 'week' && (
        <div className="-mx-4 overflow-x-auto px-4 md:mx-0 md:px-0">
          <div className="grid min-w-[900px] grid-cols-7 gap-2">
            {range.keys.map((k) => {
              const list = byDay.get(k) ?? []
              const isToday = k === todayKey(tz)
              return (
                <div key={k} className={cn('flex min-h-[420px] flex-col rounded-2xl border bg-ink-900/70 p-2', isToday ? 'border-lime/40' : 'border-ink-800')}>
                  <button onClick={() => { setDateKey(k); setView('day') }} className="mb-2 rounded-xl px-2 py-1.5 text-left hover:bg-ink-850">
                    <p className="text-[11px] uppercase tracking-wide text-ink-400">{keyLabel(k, 'EEE')}</p>
                    <p className={cn('text-lg font-bold', isToday && 'text-lime')}>{keyLabel(k, 'dd')}</p>
                    <p className="text-[11px] text-ink-500">{list.length} · {list.reduce((s, r) => s + (r.status !== 'cancelled' ? r.party_size : 0), 0)}p</p>
                  </button>
                  <div className="flex-1 space-y-1.5">
                    {list.map((r) => (
                      <button key={r.id} onClick={() => setSelected(r)} className={cn('w-full rounded-lg border-l-[3px] px-2 py-1.5 text-left transition hover:brightness-125', STATUS[r.status].bar)}>
                        <p className="text-[11px] font-semibold tabular-nums text-ink-200">{fmtTime(r.starts_at, tz)}</p>
                        <p className="truncate text-xs font-medium">{r.customer_name}</p>
                        <p className="text-[10px] text-ink-400">{r.party_size} pessoa{r.party_size > 1 ? 's' : ''}</p>
                      </button>
                    ))}
                    {blocks.filter((b) => localDateKey(b.starts_at, tz) === k).map((b) => (
                      <div key={b.id} className="rounded-lg border border-dashed border-ink-600 px-2 py-1.5 text-[11px] text-ink-400">
                        <Ban className="mr-1 inline h-3 w-3" />{fmtTime(b.starts_at, tz)}–{fmtTime(b.ends_at, tz)} {b.reason}
                      </div>
                    ))}
                  </div>
                  <button onClick={() => newReservation({ dateKey: k })} className="mt-2 flex h-8 items-center justify-center rounded-lg text-ink-500 hover:bg-ink-850 hover:text-lime"><Plus className="h-4 w-4" /></button>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {view === 'month' && (
        <Card className="p-2 md:p-3">
          <div className="grid grid-cols-7 gap-1 pb-1">
            {['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'].map((d) => <p key={d} className="py-2 text-center text-[11px] font-semibold uppercase tracking-wide text-ink-500">{d}</p>)}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {range.keys.map((k) => {
              const list = (byDay.get(k) ?? []).filter((r) => r.status !== 'cancelled')
              const inMonth = k.slice(0, 7) === dateKey.slice(0, 7)
              const isToday = k === todayKey(tz)
              const guests = list.reduce((s, r) => s + r.party_size, 0)
              return (
                <button key={k} onClick={() => { setDateKey(k); setView('day') }}
                  className={cn('flex aspect-square flex-col rounded-xl border p-1.5 text-left transition hover:border-lime/40 md:aspect-auto md:min-h-[104px] md:p-2.5',
                    inMonth ? 'border-ink-800 bg-ink-850/60' : 'border-transparent opacity-35', isToday && 'border-lime/50')}>
                  <span className={cn('text-xs font-semibold md:text-sm', isToday && 'text-lime')}>{keyLabel(k, 'd')}</span>
                  {list.length > 0 && (
                    <div className="mt-auto">
                      <p className="hidden text-lg font-bold leading-none md:block">{list.length}</p>
                      <p className="hidden text-[11px] text-ink-400 md:block">{guests} pessoas</p>
                      <div className="mt-1 flex flex-wrap gap-0.5 md:hidden">
                        {list.slice(0, 4).map((r) => <span key={r.id} className={cn('h-1.5 w-1.5 rounded-full', STATUS[r.status].dot)} />)}
                      </div>
                    </div>
                  )}
                </button>
              )
            })}
          </div>
        </Card>
      )}

      {view === 'list' && (
        <div className="space-y-5">
          {reservations.length === 0 && !isLoading && <Card><EmptyState title="Nenhuma reserva nesta semana" description="Ajuste os filtros ou navegue para outra semana." /></Card>}
          {range.keys.filter((k) => byDay.get(k)?.length).map((k) => (
            <div key={k}>
              <p className="mb-2 px-1 text-xs font-semibold uppercase tracking-wider text-ink-400">{keyLabel(k, "EEEE, dd 'de' MMMM")}</p>
              <Card className="divide-y divide-ink-800">
                {byDay.get(k)!.map((r) => (
                  <button key={r.id} onClick={() => setSelected(r)} className="flex w-full items-center gap-4 px-4 py-3 text-left transition hover:bg-ink-850">
                    <span className="w-12 font-display font-bold tabular-nums">{fmtTime(r.starts_at, tz)}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold">{r.customer_name}</span>
                      <span className="block truncate text-xs text-ink-400">{r.party_size} pessoa(s){r.notes ? ` · ${r.notes}` : ''}</span>
                    </span>
                    <StatusBadge status={r.status} />
                  </button>
                ))}
              </Card>
            </div>
          ))}
        </div>
      )}

      <ReservationDetail reservation={selected} onClose={() => setSelected(null)} />
      <BlockSheet open={blockOpen} onClose={() => setBlockOpen(false)} dateKey={dateKey} blocks={blocks} staff={staffList} defaultStaff={staffFilter} />
    </div>
  )
}

/* ----------------------------------------------------------------------- */

function DayTimeline({ dateKey, tz, reservations, blocks, hours, loading, onSelect, onEmptyClick }: {
  dateKey: string; tz: string; reservations: Reservation[]; blocks: ScheduleBlock[]
  hours: { opens_at: string; closes_at: string }[]; loading: boolean
  onSelect: (r: Reservation) => void; onEmptyClick: (time: string) => void
}) {
  const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5))
  const resMins = reservations.map((r) => [minutesOfDay(r.starts_at, tz), minutesOfDay(r.starts_at, tz) + (+new Date(r.ends_at) - +new Date(r.starts_at)) / 60000])
  const startMin = Math.floor(Math.min(...hours.map((h) => toMin(h.opens_at)), ...resMins.map((m) => m[0]), 9 * 60) / 60) * 60
  const endMin = Math.ceil(Math.max(...hours.map((h) => toMin(h.closes_at)), ...resMins.map((m) => m[1]), 18 * 60) / 60) * 60
  const total = Math.min(endMin, 24 * 60) - startMin
  const y = (min: number) => ((min - startMin) / 60) * HOUR_PX

  // lane assignment for overlapping reservations
  const laid = useMemo(() => {
    const items = reservations.map((r) => {
      const s = minutesOfDay(r.starts_at, tz)
      return { r, s, e: s + (+new Date(r.ends_at) - +new Date(r.starts_at)) / 60000, lane: 0, lanes: 1 }
    }).sort((a, b) => a.s - b.s)
    const groups: (typeof items)[] = []
    let cur: typeof items = []
    let curEnd = -1
    for (const it of items) {
      if (cur.length && it.s >= curEnd) { groups.push(cur); cur = []; curEnd = -1 }
      cur.push(it); curEnd = Math.max(curEnd, it.e)
    }
    if (cur.length) groups.push(cur)
    for (const g of groups) {
      const laneEnds: number[] = []
      for (const it of g) {
        let lane = laneEnds.findIndex((e) => e <= it.s)
        if (lane === -1) { lane = laneEnds.length; laneEnds.push(it.e) } else laneEnds[lane] = it.e
        it.lane = lane
      }
      for (const it of g) it.lanes = laneEnds.length
    }
    return items
  }, [reservations, tz])

  const isToday = dateKey === todayKey(tz)
  const nowMin = minutesOfDay(new Date().toISOString(), tz)
  const closed = hours.length === 0

  return (
    <Card className="overflow-hidden">
      {closed && <div className="border-b border-ink-800 bg-ink-850 px-4 py-2.5 text-xs text-ink-400">Fechado neste dia segundo seus horários de funcionamento.</div>}
      <div className="relative flex" style={{ height: (total / 60) * HOUR_PX + 16 }}>
        <div className="w-14 shrink-0 border-r border-ink-800 md:w-16">
          {Array.from({ length: total / 60 + 1 }, (_, i) => (
            <div key={i} className="absolute -translate-y-1/2 pl-3 text-[11px] tabular-nums text-ink-500" style={{ top: i * HOUR_PX + 8 }}>
              {String((startMin / 60 + i) % 24).padStart(2, '0')}:00
            </div>
          ))}
        </div>
        <div className="relative flex-1" style={{ marginTop: 8 }}
          onClick={(e) => {
            if (e.target !== e.currentTarget) return
            const rect = e.currentTarget.getBoundingClientRect()
            const min = startMin + Math.floor(((e.clientY - rect.top) / HOUR_PX) * 60 / 15) * 15
            onEmptyClick(`${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`)
          }}>
          {/* open hours shading */}
          {hours.map((h, i) => (
            <div key={i} className="pointer-events-none absolute inset-x-0 bg-lime/[0.025]" style={{ top: y(toMin(h.opens_at)), height: y(toMin(h.closes_at)) - y(toMin(h.opens_at)) }} />
          ))}
          {Array.from({ length: total / 60 + 1 }, (_, i) => (
            <div key={i} className="pointer-events-none absolute inset-x-0 border-t border-ink-800" style={{ top: i * HOUR_PX }} />
          ))}
          {Array.from({ length: total / 60 }, (_, i) => (
            <div key={`h${i}`} className="pointer-events-none absolute inset-x-0 border-t border-dashed border-ink-800/50" style={{ top: i * HOUR_PX + HOUR_PX / 2 }} />
          ))}
          {blocks.filter((b) => localDateKey(b.starts_at, tz) === dateKey || localDateKey(b.ends_at, tz) === dateKey).map((b) => {
            const s = localDateKey(b.starts_at, tz) === dateKey ? minutesOfDay(b.starts_at, tz) : startMin
            const e = localDateKey(b.ends_at, tz) === dateKey ? minutesOfDay(b.ends_at, tz) : endMin
            return (
              <div key={b.id} className="pointer-events-none absolute inset-x-1 rounded-lg border border-ink-600 text-[11px] text-ink-300"
                style={{ top: y(Math.max(s, startMin)), height: Math.max(y(Math.min(e, endMin)) - y(Math.max(s, startMin)), 18),
                  background: 'repeating-linear-gradient(135deg, rgba(255,255,255,0.03) 0 8px, transparent 8px 16px)' }}>
                <span className="m-1.5 inline-flex items-center gap-1 rounded bg-ink-800 px-1.5 py-0.5"><Ban className="h-3 w-3" /> {b.reason || 'Bloqueado'}</span>
              </div>
            )
          })}
          {laid.map(({ r, s, e, lane, lanes }) => (
            <button key={r.id} onClick={() => onSelect(r)}
              className={cn('absolute overflow-hidden rounded-lg border-l-[3px] px-2 py-1 text-left shadow-lg ring-1 ring-black/40 transition hover:z-10 hover:brightness-125 backdrop-blur', STATUS[r.status].bar)}
              style={{ top: y(s) + 1, height: Math.max(y(e) - y(s) - 2, 24), left: `calc(${(lane / lanes) * 100}% + 4px)`, width: `calc(${100 / lanes}% - 8px)` }}>
              <p className="truncate text-xs font-semibold text-ink-50">{r.customer_name}</p>
              <p className="truncate text-[11px] text-ink-300">{fmtTime(r.starts_at, tz)} · {r.party_size}p{r.notes ? ` · ${r.notes}` : ''}</p>
            </button>
          ))}
          {isToday && nowMin >= startMin && nowMin <= endMin && (
            <div className="pointer-events-none absolute inset-x-0 z-20 flex items-center" style={{ top: y(nowMin) }}>
              <span className="-ml-1 h-2.5 w-2.5 rounded-full bg-lime shadow-glow" />
              <span className="h-px flex-1 bg-lime/70" />
            </div>
          )}
          {loading && <div className="absolute inset-0 grid place-items-center bg-ink-900/40"><span className="text-xs text-ink-400">Carregando…</span></div>}
        </div>
      </div>
      <p className="border-t border-ink-800 px-4 py-2.5 text-[11px] text-ink-500">Toque em um espaço vazio para criar uma reserva naquele horário.</p>
    </Card>
  )
}

function BlockSheet({ open, onClose, dateKey, blocks, staff, defaultStaff }: {
  open: boolean; onClose: () => void; dateKey: string; blocks: ScheduleBlock[]; staff: Staff[]; defaultStaff: string
}) {
  const [who, setWho] = useState(defaultStaff)
  useEffect(() => { if (open) setWho(defaultStaff) }, [open, defaultStaff])
  const { tenant } = useCurrentTenant()
  const tz = tenant.timezone
  const toast = useToast()
  const { create, remove } = useBlockMutations(tenant.id)
  const [day, setDay] = useState(dateKey)
  const [allDay, setAllDay] = useState(false)
  const [start, setStart] = useState('12:00')
  const [end, setEnd] = useState('15:00')
  const [reason, setReason] = useState('')
  useEffect(() => { if (open) setDay(dateKey) }, [open, dateKey])

  const save = async () => {
    const s = zonedToUtcIso(day, allDay ? '00:00' : start, tz)
    const e = allDay ? zonedToUtcIso(shiftKey(day, 1), '00:00', tz) : zonedToUtcIso(day, end, tz)
    if (+new Date(e) <= +new Date(s)) return toast('error', 'O fim deve ser depois do início')
    try {
      await create.mutateAsync({ starts_at: s, ends_at: e, reason: reason || undefined, staff_id: who || null })
      toast('success', 'Horário bloqueado', 'Clientes não verão mais este período.')
      setReason('')
    } catch (err) { toast('error', 'Erro ao bloquear', errorMessage(err)) }
  }

  return (
    <Sheet open={open} onClose={onClose} title="Bloquear agenda" subtitle="Feriados, eventos privados, manutenção…"
      footer={<Button className="w-full" onClick={save} loading={create.isPending}><Lock className="h-4 w-4" /> Bloquear período</Button>}>
      <div className="space-y-4">
        {staff.length > 0 && (
          <Field label="Bloquear para">
            <Select value={who} onChange={(e) => setWho(e.target.value)}>
              <option value="">Todo o estabelecimento</option>
              {staff.filter((x) => x.is_active).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </Select>
          </Field>
        )}
        <Field label="Data"><Input type="date" value={day} onChange={(e) => setDay(e.target.value)} /></Field>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} className="accent-[#C6F432]" /> Dia inteiro</label>
        {!allDay && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Início"><Input type="time" value={start} onChange={(e) => setStart(e.target.value)} /></Field>
            <Field label="Fim"><Input type="time" value={end} onChange={(e) => setEnd(e.target.value)} /></Field>
          </div>
        )}
        <Field label="Motivo" hint="opcional"><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ex.: Evento fechado" /></Field>
        <p className="text-xs text-ink-400">Reservas já existentes no período não são canceladas automaticamente.</p>

        {blocks.length > 0 && (
          <div className="pt-2">
            <p className="label">Bloqueios no período visível</p>
            <div className="space-y-2">
              {blocks.map((b) => (
                <div key={b.id} className="flex items-center gap-3 rounded-xl border border-ink-700 bg-ink-850 px-3 py-2.5">
                  <Ban className="h-4 w-4 text-ink-400" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm">{fmt(b.starts_at, tz, "dd/MM HH:mm")} → {fmt(b.ends_at, tz, "dd/MM HH:mm")}{b.staff_id && <span className="text-ink-400"> · {staff.find((x) => x.id === b.staff_id)?.name}</span>}</p>
                    {b.reason && <p className="truncate text-xs text-ink-400">{b.reason}</p>}
                  </div>
                  <button onClick={async () => { try { await remove.mutateAsync(b.id); toast('success', 'Bloqueio removido') } catch (e) { toast('error', 'Erro', errorMessage(e)) } }}
                    className="rounded-lg p-1.5 text-ink-400 hover:bg-ink-800 hover:text-rose-300" title="Remover"><Trash2 className="h-4 w-4" /></button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Sheet>
  )
}

/* ------------------------------------------------ per-professional day */
function StaffDayView({ dateKey, tz, reservations, blocks, staff, staffHours, hours, onSelect, onEmptyClick }: {
  dateKey: string; tz: string; reservations: Reservation[]; blocks: ScheduleBlock[]; staff: Staff[]; staffHours: StaffHour[]
  hours: { opens_at: string; closes_at: string }[]; onSelect: (r: Reservation) => void; onEmptyClick: (time: string, staffId: string) => void
}) {
  const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5))
  const dow = keyToDate(dateKey).getDay()
  const resM = reservations.map((r) => [minutesOfDay(r.starts_at, tz), minutesOfDay(r.starts_at, tz) + (+new Date(r.ends_at) - +new Date(r.starts_at)) / 60000])
  const allShifts = [...hours, ...staffHours.filter((h) => h.weekday === dow)]
  const startMin = Math.floor(Math.min(...allShifts.map((h) => toMin(h.opens_at)), ...resM.map((m) => m[0]), 9 * 60) / 60) * 60
  const endMin = Math.min(24 * 60, Math.ceil(Math.max(...allShifts.map((h) => toMin(h.closes_at)), ...resM.map((m) => m[1]), 18 * 60) / 60) * 60)
  const total = endMin - startMin
  const y = (m: number) => ((m - startMin) / 60) * HOUR_PX
  const unassigned = reservations.filter((r) => !r.staff_id)
  const columns: { id: string; staff?: Staff }[] = [...staff.map((s) => ({ id: s.id, staff: s })), ...(unassigned.length ? [{ id: '' }] : [])]
  const isToday = dateKey === todayKey(tz)
  const nowMin = minutesOfDay(new Date().toISOString(), tz)

  return (
    <Card className="overflow-hidden">
      <div className="overflow-x-auto">
        <div style={{ minWidth: 64 + columns.length * 170 }}>
          <div className="sticky top-0 z-10 flex border-b border-ink-800 bg-ink-900">
            <div className="w-16 shrink-0" />
            {columns.map((c) => (
              <div key={c.id || 'none'} className="flex flex-1 items-center gap-2 border-l border-ink-800 px-3 py-2.5">
                {c.staff ? <Avatar name={c.staff.name} src={c.staff.photo_url} size={26} /> : null}
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">{c.staff?.name ?? 'Sem profissional'}</p>
                  <p className="text-[11px] text-ink-500">{reservations.filter((r) => (r.staff_id ?? '') === c.id).length} atendimento(s)</p>
                </div>
              </div>
            ))}
          </div>
          <div className="relative flex" style={{ height: (total / 60) * HOUR_PX + 8 }}>
            <div className="w-16 shrink-0">
              {Array.from({ length: total / 60 + 1 }, (_, i) => (
                <div key={i} className="absolute -translate-y-1/2 pl-3 text-[11px] tabular-nums text-ink-500" style={{ top: i * HOUR_PX + 4 }}>{String(startMin / 60 + i).padStart(2, '0')}:00</div>
              ))}
            </div>
            {columns.map((c) => {
              const own = c.staff ? staffHours.filter((h) => h.staff_id === c.id) : []
              const shifts = c.staff ? (own.length ? own.filter((h) => h.weekday === dow) : hours) : []
              const mine = reservations.filter((r) => (r.staff_id ?? '') === c.id)
              const myBlocks = blocks.filter((b) => (b.staff_id === c.id || (!b.staff_id && !b.table_id)) && (localDateKey(b.starts_at, tz) === dateKey || localDateKey(b.ends_at, tz) === dateKey))
              return (
                <div key={c.id || 'none'} className="relative flex-1 border-l border-ink-800" style={{ marginTop: 4 }}
                  onClick={(e) => {
                    if (e.target !== e.currentTarget || !c.staff) return
                    const rect = e.currentTarget.getBoundingClientRect()
                    const m = startMin + Math.floor(((e.clientY - rect.top) / HOUR_PX) * 60 / 15) * 15
                    onEmptyClick(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`, c.id)
                  }}>
                  {/* off-hours shading: whole column dark, working shifts lit */}
                  {c.staff && <div className="pointer-events-none absolute inset-0 bg-[repeating-linear-gradient(135deg,rgba(255,255,255,0.02)_0_6px,transparent_6px_12px)]" />}
                  {shifts.map((h, i) => (
                    <div key={i} className="pointer-events-none absolute inset-x-0 bg-ink-900" style={{ top: y(toMin(h.opens_at)), height: y(toMin(h.closes_at)) - y(toMin(h.opens_at)) }}>
                      <div className="h-full w-full" style={{ background: `${c.staff!.color}0d` }} />
                    </div>
                  ))}
                  {Array.from({ length: total / 60 + 1 }, (_, i) => <div key={i} className="pointer-events-none absolute inset-x-0 border-t border-ink-800" style={{ top: i * HOUR_PX }} />)}
                  {myBlocks.map((b) => {
                    const s0 = localDateKey(b.starts_at, tz) === dateKey ? minutesOfDay(b.starts_at, tz) : startMin
                    const e0 = localDateKey(b.ends_at, tz) === dateKey ? minutesOfDay(b.ends_at, tz) : endMin
                    return (
                      <div key={b.id} className="pointer-events-none absolute inset-x-1 rounded-lg border border-dashed border-ink-600 bg-ink-850/90 p-1.5 text-[10px] text-ink-400"
                        style={{ top: y(Math.max(s0, startMin)), height: Math.max(y(Math.min(e0, endMin)) - y(Math.max(s0, startMin)), 16) }}>
                        <Ban className="mr-1 inline h-3 w-3" />{b.reason || 'Bloqueado'}
                      </div>
                    )
                  })}
                  {mine.map((r) => {
                    const s0 = minutesOfDay(r.starts_at, tz)
                    const e0 = s0 + (+new Date(r.ends_at) - +new Date(r.starts_at)) / 60000
                    const occ = r.occupied_until ? s0 + (+new Date(r.occupied_until) - +new Date(r.starts_at)) / 60000 : e0
                    return (
                      <div key={r.id}>
                        {occ > e0 && <div className="pointer-events-none absolute inset-x-2 rounded-b-md bg-ink-700/40" style={{ top: y(e0), height: y(occ) - y(e0) }} title="Preparo" />}
                        <button onClick={() => onSelect(r)}
                          className={cn('absolute inset-x-1 overflow-hidden rounded-lg border-l-[3px] px-2 py-1 text-left shadow-lg ring-1 ring-black/40 transition hover:z-10 hover:brightness-125', STATUS[r.status].bar)}
                          style={{ top: y(s0) + 1, height: Math.max(y(e0) - y(s0) - 2, 22) }}>
                          <p className="truncate text-xs font-semibold text-ink-50">{r.customer_name}</p>
                          <p className="truncate text-[11px] text-ink-300">{fmtTime(r.starts_at, tz)}–{fmtTime(r.ends_at, tz)}</p>
                        </button>
                      </div>
                    )
                  })}
                  {isToday && nowMin >= startMin && nowMin <= endMin && (
                    <div className="pointer-events-none absolute inset-x-0 z-20 h-px bg-lime/70" style={{ top: y(nowMin) }} />
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>
      <p className="border-t border-ink-800 px-4 py-2.5 text-[11px] text-ink-500">Áreas listradas = fora do horário do profissional. Faixa cinza após o atendimento = preparo. Toque num espaço vazio para agendar com aquele profissional.</p>
    </Card>
  )
}
