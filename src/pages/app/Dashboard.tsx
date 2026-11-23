import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import {
  ArrowDownRight, ArrowUpRight, CalendarCheck2, Check, Clock3, Copy, Gauge, Hourglass, Sparkles, UserPlus, Users, XCircle, ChevronRight, CalendarX2,
} from 'lucide-react'
import { useCurrentTenant } from '@/hooks/useTenant'
import { useBlocks, useDashboard, useReservationMutations, useReservations, useTenantSlots, useUpcoming } from '@/api/reservations'
import { useFloorOccupancy, useTables } from '@/api/floor'
import { useFreeStaff, useStaff, useStaffMetrics } from '@/api/staff'
import { Avatar } from '@/components/ui/ui'
import { formatMoney } from '@/lib/utils'
import { TABLE_STATUS, tableState, type TableStatus } from '@/lib/floor'
import { useBookingSettings } from '@/api/tenant'
import { useShell, publicBookingUrl } from '@/components/layout/AppShell'
import { Button, Card, CardHeader, EmptyState, Segmented } from '@/components/ui/ui'
import { useToast } from '@/components/ui/Toast'
import { ReservationDetail, StatusBadge } from '@/components/reservations/ReservationDetail'
import { dayRangeUtc, fmt, fmtTime, greeting, keyLabel, shiftKey, todayKey, WEEKDAYS_SHORT } from '@/lib/datetime'
import { SEGMENT, SOURCE, newUnit, noneUnit } from '@/lib/constants'
import { errorMessage } from '@/lib/errors'
import { cn, pct } from '@/lib/utils'
import type { Reservation } from '@/types/db'

type Period = 'today' | '7d' | '30d'

export default function Dashboard() {
  const { tenant } = useCurrentTenant()
  const tz = tenant.timezone
  const toast = useToast()
  const { newReservation } = useShell()
  const [period, setPeriod] = useState<Period>('7d')
  const [selected, setSelected] = useState<Reservation | null>(null)
  const today = todayKey(tz)
  const from = period === 'today' ? today : shiftKey(today, period === '7d' ? -6 : -29)

  const { data: m, isLoading } = useDashboard(tenant.id, from, today)
  const todayRange = dayRangeUtc(today, today, tz)
  const { data: todayList = [] } = useReservations(tenant.id, { from: todayRange.from, to: todayRange.to })
  const { data: upcoming = [] } = useUpcoming(tenant.id, 6)
  const { data: settings } = useBookingSettings(tenant.id)
  const tablesMode = settings?.allocation_mode === 'tables'
  const { data: tables = [] } = useTables(tenant.id)
  const { data: blocksToday = [] } = useBlocks(tenant.id, todayRange.from, todayRange.to)
  const { data: floorOcc } = useFloorOccupancy(tenant.id, from, today, tablesMode)
  const staffMode = settings?.allocation_mode === 'staff'
  const { data: staffList = [] } = useStaff(tenant.id)
  const { data: sm } = useStaffMetrics(tenant.id, from, today, staffMode)
  const [nowIso] = useState(() => new Date().toISOString())
  const freeNow = useFreeStaff(tenant.id, staffMode ? nowIso : null, staffMode ? new Date(Date.parse(nowIso) + 30 * 60000).toISOString() : null)
  const availableNow = staffList.filter((x) => x.is_active && freeNow.data?.get(x.id)?.is_free && freeNow.data?.get(x.id)?.is_working)
  const freeSlotsToday = useTenantSlots(tenant.id, today, 1)
  const { setStatus } = useReservationMutations(tenant.id)

  const isRestaurant = tenant.segment === 'restaurant'
  const seg = SEGMENT[tenant.segment]
  const activeToday = todayList.filter((r) => r.status !== 'cancelled')
  const pendingList = upcoming.filter((r) => r.status === 'pending')
  const guestsToday = activeToday.filter((r) => r.status !== 'no_show').reduce((s, r) => s + r.party_size, 0)
  const now = Date.now()
  const inHouse = activeToday.filter((r) => r.status === 'in_progress').reduce((s, r) => s + r.party_size, 0)

  const kpis = useMemo(() => {
    if (!m) return []
    const t = m.totals
    const p = m.previous
    return [
      { label: `${seg.unitPlural.replace(/^./, (c) => c.toUpperCase())}`, value: t.reservations - t.cancelled, delta: pct(t.reservations - t.cancelled, p.reservations - p.cancelled), icon: CalendarCheck2 },
      isRestaurant
        ? { label: 'Pessoas atendidas/esperadas', value: t.guests, delta: pct(t.guests, p.guests), icon: Users }
        : { label: 'Atendimentos concluídos', value: t.completed, delta: null, icon: Check },
      staffMode
        ? { label: 'Ocupação da agenda dos profissionais', value: sm?.occupancy == null ? '—' : `${sm.occupancy}%`, icon: Gauge }
        : tablesMode
        ? { label: 'Ocupação das mesas', value: floorOcc == null ? '—' : `${floorOcc}%`, icon: Gauge }
        : { label: isRestaurant ? 'Ocupação do salão' : 'Ocupação da agenda', value: m.occupancy == null ? '—' : `${m.occupancy}%`, hint: m.occupancy == null ? 'Defina a capacidade em Configurações' : undefined, icon: Gauge },
      { label: 'Cancelamentos + faltas', value: t.cancelled + t.no_show, delta: pct(t.cancelled + t.no_show, p.cancelled + p.no_show), invert: true, icon: XCircle },
      { label: 'Novos clientes', value: t.new_customers, delta: pct(t.new_customers, p.new_customers), icon: UserPlus },
      { label: 'Reservas online', value: t.online_share == null ? '—' : `${t.online_share}%`, icon: Sparkles },
    ]
  }, [m, isRestaurant, seg.unitPlural, tablesMode, floorOcc, staffMode, sm])

  const byDay = (m?.by_day ?? []).map((d) => ({ ...d, label: keyLabel(d.date, period === '30d' ? 'dd/MM' : 'EEE dd') }))
  const byHour = useMemo(() => {
    const map = new Map((m?.by_hour ?? []).map((h) => [h.hour, h.count]))
    const hours = [...map.keys()]
    if (!hours.length) return []
    const min = Math.min(...hours), max = Math.max(...hours)
    return Array.from({ length: max - min + 1 }, (_, i) => ({ hour: `${String(min + i).padStart(2, '0')}h`, count: map.get(min + i) ?? 0 }))
  }, [m])
  const peak = byHour.reduce<{ hour: string; count: number } | null>((a, b) => (!a || b.count > a.count ? b : a), null)
  const topWeekday = (m?.by_weekday ?? []).reduce<{ weekday: number; count: number } | null>((a, b) => (!a || b.count > a.count ? b : a), null)

  const url = publicBookingUrl(tenant.segment, tenant.slug)

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="text-sm text-ink-400 first-letter:uppercase">{fmt(new Date(), tz, "EEEE, d 'de' MMMM")}</p>
          <h1 className="mt-1 text-2xl font-bold md:text-3xl">{greeting(tz)} 👋</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented value={period} onChange={setPeriod} options={[{ value: 'today', label: 'Hoje' }, { value: '7d', label: '7 dias' }, { value: '30d', label: '30 dias' }]} />
          <Button variant="secondary" size="sm" className="h-9" onClick={() => { void navigator.clipboard.writeText(url); toast('success', 'Link de reservas copiado', url) }}>
            <Copy className="h-3.5 w-3.5" /> Link de reservas
          </Button>
        </div>
      </div>

      {/* Floor now (restaurants with tables) */}
      {tables.length > 0 && (() => {
        const nowD = new Date()
        const c: Partial<Record<TableStatus, number>> = {}
        for (const t of tables) { const st = tableState(t, todayList, blocksToday, nowD).status; c[st] = (c[st] ?? 0) + 1 }
        const items: TableStatus[] = ['occupied', 'arriving', 'reserved', 'available']
        return (
          <Link to="/app/mesas" className="card flex flex-wrap items-center gap-x-6 gap-y-3 px-5 py-4 transition hover:border-ink-600">
            <span className="text-sm font-semibold">Salão agora</span>
            {items.map((k) => (
              <span key={k} className="flex items-center gap-2 text-sm">
                <span className={cn('h-2.5 w-2.5 rounded-full', TABLE_STATUS[k].dot)} />
                <span className="text-ink-300">{k === 'occupied' ? 'Mesas ocupadas' : k === 'arriving' ? 'Chegando' : k === 'reserved' ? 'Mesas reservadas' : 'Disponíveis'}</span>
                <b className="font-display tabular-nums">{c[k] ?? 0}</b>
              </span>
            ))}
            <span className="ml-auto flex items-center gap-1 text-xs text-ink-400">Ver mapa <ChevronRight className="h-3.5 w-3.5" /></span>
          </Link>
        )
      })()}

      {/* Today strip */}
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <TodayTile label={`${seg.unitPlural} hoje`} value={activeToday.length} sub={`${activeToday.filter((r) => r.status === 'confirmed').length} confirmadas`} accent />
        {isRestaurant ? (
          <TodayTile label="Pessoas esperadas hoje" value={guestsToday} sub={`${inHouse} no salão agora`} />
        ) : (
          <TodayTile label="Próximo cliente" value={upcoming[0] ? fmtTime(upcoming[0].starts_at, tz) : '—'} sub={upcoming[0]?.customer_name ?? 'Agenda livre'} />
        )}
        {staffMode ? (
          <TodayTile label="Profissionais disponíveis agora" value={`${availableNow.length}/${staffList.filter((x) => x.is_active).length}`}
            sub={availableNow.length ? availableNow.map((x) => x.name).join(', ') : 'Todos ocupados ou fora do horário'} />
        ) : (
          <TodayTile label="Aguardando confirmação" value={pendingList.length} sub={pendingList.length ? 'Requer sua ação' : 'Tudo em dia'} warn={pendingList.length > 0} />
        )}
        <TodayTile
          label={isRestaurant ? 'Horários livres hoje' : 'Horários vagos hoje'}
          value={freeSlotsToday.data?.length ?? '—'}
          sub={staffMode ? `${staffList.filter((x) => x.is_active).length} profissional(is) ativo(s)` : tablesMode ? `${tables.filter((t) => t.is_active).length} mesa(s) ativa(s)` : settings?.max_reservations_per_slot ? `Capacidade: ${settings.max_reservations_per_slot} simultâneas` : 'Capacidade ilimitada'}
        />
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 2xl:grid-cols-6">
        {isLoading
          ? Array.from({ length: 6 }).map((_, i) => <div key={i} className="skeleton h-[104px] rounded-2xl" />)
          : kpis.map((k) => (
              <Card key={k.label} className="p-4">
                <div className="flex items-center justify-between">
                  <k.icon className="h-4 w-4 text-ink-400" />
                  {'delta' in k && k.delta != null && <Delta value={k.delta} invert={'invert' in k && k.invert} />}
                </div>
                <p className="mt-3 font-display text-2xl font-bold tabular-nums">{k.value}</p>
                <p className="mt-0.5 text-xs text-ink-400">{k.label}</p>
                {'hint' in k && k.hint && <Link to="/app/configuracoes?tab=regras" className="mt-1 block text-[11px] text-lime/80 hover:text-lime">{k.hint}</Link>}
              </Card>
            ))}
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.6fr_1fr]">
        {/* Trend */}
        <Card className="overflow-hidden">
          <CardHeader title="Movimento" subtitle={period === 'today' ? 'Hoje' : `Últimos ${m?.period.days ?? ''} dias · comparação com o período anterior`}
            action={m && <span className="text-xs text-ink-400">Anterior: <b className="text-ink-200">{m.previous.reservations}</b></span>} />
          <div className="h-[260px] px-2 pb-3 pt-4">
            {byDay.length > 0 && (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={byDay} margin={{ left: -18, right: 12, top: 8 }}>
                  <defs>
                    <linearGradient id="lime" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#C6F432" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="#C6F432" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="#1E1E22" vertical={false} />
                  <XAxis dataKey="label" tick={{ fill: '#6C6C76', fontSize: 11 }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                  <YAxis allowDecimals={false} tick={{ fill: '#6C6C76', fontSize: 11 }} axisLine={false} tickLine={false} />
                  <Tooltip content={<ChartTooltip />} cursor={{ stroke: '#3D3D45' }} />
                  <Area type="monotone" dataKey="total" name="Reservas" stroke="#C6F432" strokeWidth={2.2} fill="url(#lime)" />
                  <Area type="monotone" dataKey="cancelled" name="Canceladas" stroke="#FB7185" strokeWidth={1.5} fill="transparent" strokeDasharray="4 4" />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
        </Card>

        {/* Peak hours */}
        <Card>
          <CardHeader title="Horários mais movimentados" subtitle={peak ? `Pico às ${peak.hour}${topWeekday ? ` · dia mais forte: ${WEEKDAYS_SHORT[topWeekday.weekday]}` : ''}` : 'Sem dados no período'} icon={<Clock3 className="h-4 w-4" />} />
          <div className="h-[230px] px-2 pb-3 pt-4">
            {byHour.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={byHour} margin={{ left: -24, right: 8 }}>
                  <CartesianGrid stroke="#1E1E22" vertical={false} />
                  <XAxis dataKey="hour" tick={{ fill: '#6C6C76', fontSize: 11 }} axisLine={false} tickLine={false} />
                  <YAxis allowDecimals={false} tick={{ fill: '#6C6C76', fontSize: 11 }} axisLine={false} tickLine={false} />
                  <Tooltip content={<ChartTooltip />} cursor={{ fill: 'rgba(255,255,255,0.03)' }} />
                  <Bar dataKey="count" name="Reservas" radius={[6, 6, 2, 2]} fill="#C6F432" maxBarSize={28} />
                </BarChart>
              </ResponsiveContainer>
            ) : <EmptyState title="Ainda sem movimento" description="Os horários de pico aparecem aqui assim que houver reservas." />}
          </div>
        </Card>
      </div>

      {staffMode && sm && (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader title="Atendimentos por profissional" subtitle={period === 'today' ? 'Hoje' : `Últimos ${m?.period.days ?? ''} dias`} />
            <div className="space-y-3 p-5">
              {sm.by_staff.filter((x) => x.appointments > 0).length === 0 && <p className="text-sm text-ink-500">Sem atendimentos no período.</p>}
              {sm.by_staff.filter((x) => x.appointments > 0).map((x) => {
                const max = Math.max(...sm.by_staff.map((y) => y.appointments), 1)
                const st = staffList.find((y) => y.id === x.staff_id)
                return (
                  <div key={x.staff_id} className="flex items-center gap-3">
                    <Avatar name={x.name} src={st?.photo_url} size={30} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2 text-sm">
                        <span className="truncate font-medium">{x.name}</span>
                        <span className="tabular-nums text-ink-300"><b className="text-ink-50">{x.appointments}</b>{x.revenue_cents ? ` · ${formatMoney(x.revenue_cents)}` : ''}</span>
                      </div>
                      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-ink-800"><div className="h-full rounded-full" style={{ width: `${(x.appointments / max) * 100}%`, background: x.color }} /></div>
                    </div>
                  </div>
                )
              })}
            </div>
          </Card>
          <Card>
            <CardHeader title="Serviços mais realizados" subtitle="Receita considera atendimentos concluídos" />
            <div className="space-y-2 p-5">
              {sm.by_service.length === 0 && <p className="text-sm text-ink-500">Sem serviços no período.</p>}
              {sm.by_service.slice(0, 6).map((x, i) => (
                <div key={x.service_id} className="flex items-center gap-3 rounded-xl bg-ink-850/60 px-3 py-2.5">
                  <span className="w-5 font-display text-sm font-bold text-ink-500">{i + 1}</span>
                  <span className="flex-1 truncate text-sm">{x.name}</span>
                  <span className="text-sm tabular-nums"><b>{x.appointments}</b> <span className="text-ink-500">· {x.completed} concluídos</span></span>
                  {x.revenue_cents > 0 && <span className="text-xs text-lime">{formatMoney(x.revenue_cents)}</span>}
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-[1.6fr_1fr]">
        {/* Today agenda */}
        <Card>
          <CardHeader title="Agenda de hoje" subtitle={`${activeToday.length} ${seg.unitPlural}`}
            action={<Link to="/app/agenda" className="flex items-center gap-1 text-xs font-medium text-ink-300 hover:text-lime">Abrir agenda <ChevronRight className="h-3.5 w-3.5" /></Link>} />
          <div className="p-3">
            {todayList.length === 0 ? (
              <EmptyState icon={<CalendarX2 className="h-6 w-6" />} title={`${noneUnit(tenant.segment)} para hoje`}
                description="Compartilhe seu link de reservas ou crie uma reserva manual."
                action={<Button size="sm" onClick={() => newReservation()}>{newUnit(tenant.segment)}</Button>} />
            ) : (
              <ul className="divide-y divide-ink-800">
                {todayList.map((r) => {
                  const past = +new Date(r.ends_at) < now
                  return (
                    <li key={r.id}>
                      <button onClick={() => setSelected(r)} className={cn('flex w-full items-center gap-4 rounded-xl px-3 py-3 text-left transition hover:bg-ink-850', past && r.status !== 'in_progress' && 'opacity-60')}>
                        <div className="w-14 shrink-0">
                          <p className="font-display text-base font-bold tabular-nums">{fmtTime(r.starts_at, tz)}</p>
                          <p className="text-[11px] text-ink-500">{fmtTime(r.ends_at, tz)}</p>
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-semibold">{r.customer_name}</p>
                          <p className="truncate text-xs text-ink-400">{r.party_size} pessoa{r.party_size > 1 ? 's' : ''} · {SOURCE[r.source]}{r.notes ? ` · ${r.notes}` : ''}</p>
                        </div>
                        <StatusBadge status={r.status} className="hidden sm:inline-flex" />
                        <span className={cn('h-2 w-2 rounded-full sm:hidden', r.status === 'confirmed' ? 'bg-lime' : r.status === 'pending' ? 'bg-amber-400' : 'bg-ink-500')} />
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </Card>

        <div className="space-y-6">
          {/* Pending confirmations */}
          <Card>
            <CardHeader title="Aguardando confirmação" icon={<Hourglass className="h-4 w-4" />} subtitle={pendingList.length ? 'Confirme para garantir o horário' : 'Nenhuma pendência'} />
            <div className="space-y-2 p-4">
              {pendingList.length === 0 && <p className="py-4 text-center text-sm text-ink-500">Tudo confirmado ✓</p>}
              {pendingList.map((r) => (
                <div key={r.id} className="flex items-center gap-3 rounded-xl border border-ink-700 bg-ink-850 p-3">
                  <button className="min-w-0 flex-1 text-left" onClick={() => setSelected(r)}>
                    <p className="truncate text-sm font-semibold">{r.customer_name}</p>
                    <p className="text-xs text-ink-400">{fmt(r.starts_at, tz, "EEE dd/MM 'às' HH:mm")} · {r.party_size}p</p>
                  </button>
                  <Button size="sm" onClick={async () => {
                    try { await setStatus.mutateAsync({ id: r.id, status: 'confirmed' }); toast('success', 'Reserva confirmada') }
                    catch (e) { toast('error', 'Erro', errorMessage(e)) }
                  }}><Check className="h-3.5 w-3.5" /> Confirmar</Button>
                </div>
              ))}
            </div>
          </Card>

          {/* Upcoming */}
          <Card>
            <CardHeader title="Próximas" subtitle="Em ordem de chegada" />
            <ul className="space-y-1 p-3">
              {upcoming.length === 0 && <p className="py-4 text-center text-sm text-ink-500">Sem próximas {seg.unitPlural}</p>}
              {upcoming.map((r) => (
                <li key={r.id}>
                  <button onClick={() => setSelected(r)} className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left hover:bg-ink-850">
                    <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-ink-700 bg-ink-850 text-center leading-none">
                      <span className="text-[10px] uppercase text-ink-400">{fmt(r.starts_at, tz, 'EEE')}</span>
                      <span className="text-sm font-bold">{fmt(r.starts_at, tz, 'dd')}</span>
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{r.customer_name}</p>
                      <p className="text-xs text-ink-400">{fmtTime(r.starts_at, tz)} · {r.party_size}p</p>
                    </div>
                    <StatusBadge status={r.status} />
                  </button>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>

      <ReservationDetail reservation={selected} onClose={() => setSelected(null)} />
    </div>
  )
}

function TodayTile({ label, value, sub, accent, warn }: { label: string; value: React.ReactNode; sub?: string; accent?: boolean; warn?: boolean }) {
  return (
    <div className={cn('relative overflow-hidden rounded-2xl border p-4 md:p-5',
      accent ? 'border-lime/30 bg-gradient-to-br from-lime/[0.14] via-ink-900 to-ink-900' : 'border-ink-700/70 bg-ink-900/80',
      warn && 'border-amber-400/30')}>
      {accent && <div className="pointer-events-none absolute -right-10 -top-10 h-32 w-32 rounded-full bg-lime/20 blur-3xl" />}
      <p className="text-xs font-medium first-letter:uppercase text-ink-300">{label}</p>
      <p className={cn('mt-2 font-display text-2xl font-extrabold tabular-nums md:text-3xl', accent && 'text-lime', warn && 'text-amber-300')}>{value}</p>
      {sub && <p className="mt-1 truncate text-xs text-ink-400">{sub}</p>}
    </div>
  )
}

function Delta({ value, invert }: { value: number; invert?: boolean }) {
  const up = value >= 0
  const good = invert ? !up : up
  if (Math.abs(value) < 0.5) return <span className="text-[11px] font-medium text-ink-500">=</span>
  return (
    <span className={cn('flex items-center gap-0.5 text-[11px] font-semibold', good ? 'text-lime' : 'text-rose-300')}>
      {up ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
      {Math.abs(value).toFixed(0)}%
    </span>
  )
}

function ChartTooltip({ active, payload, label }: { active?: boolean; payload?: { name: string; value: number; color: string }[]; label?: string }) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-xl border border-ink-700 bg-ink-850/95 px-3 py-2 text-xs shadow-xl backdrop-blur">
      <p className="mb-1 font-semibold first-letter:uppercase text-ink-100">{label}</p>
      {payload.map((p) => (
        <p key={p.name} className="flex items-center gap-2 text-ink-300">
          <span className="h-2 w-2 rounded-full" style={{ background: p.color }} /> {p.name}: <b className="text-ink-50">{p.value}</b>
        </p>
      ))}
    </div>
  )
}
