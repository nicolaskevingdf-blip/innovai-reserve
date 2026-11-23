import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react'
import { Link } from 'react-router-dom'
import {
  Armchair, Check, Clock, Layers, LayoutGrid, List, Link2, Move, Pencil, Plus, Save, Settings2, Trash2, UserPlus, Users, X,
} from 'lucide-react'
import { useCurrentTenant } from '@/hooks/useTenant'
import { useAreas, useCombinations, useFloorMutations, useTables } from '@/api/floor'
import { useBlocks, useReservationMutations, useReservations } from '@/api/reservations'
import { useBookingSettings } from '@/api/tenant'
import { Button, Card, EmptyState, Field, Input, Segmented, Select, Switch } from '@/components/ui/ui'
import { ConfirmDialog, Sheet } from '@/components/ui/Sheet'
import { useToast } from '@/components/ui/Toast'
import { ReservationDetail, StatusBadge } from '@/components/reservations/ReservationDetail'
import { dayRangeUtc, fmt, fmtTime, keyLabel, todayKey, zonedToUtcIso } from '@/lib/datetime'
import { STATUS_ORDER_FLOOR, TABLE_STATUS, tableState, type TableState } from '@/lib/floor'
import { errorMessage } from '@/lib/errors'
import { cn, formatPhone, isValidPhone } from '@/lib/utils'
import type { DiningTable, Reservation, TableShape } from '@/types/db'

const CANVAS_W = 1000
const CANVAS_H = 620

export default function Floor() {
  const { tenant, isManager } = useCurrentTenant()
  const tz = tenant.timezone
  const toast = useToast()
  const { data: tables = [], isLoading } = useTables(tenant.id)
  const { data: areas = [] } = useAreas(tenant.id)
  const { data: settings } = useBookingSettings(tenant.id)
  const { saveLayout } = useFloorMutations(tenant.id)

  const [dateKey, setDateKey] = useState(todayKey(tz))
  const [time, setTime] = useState<string | null>(null) // null = live (now)
  const [tick, setTick] = useState(Date.now())
  const [area, setArea] = useState<string>('all')
  const [view, setView] = useState<'map' | 'list'>('map')
  const [editing, setEditing] = useState(false)
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({})
  const [selected, setSelected] = useState<DiningTable | null>(null)
  const [newTable, setNewTable] = useState(false)
  const [configOpen, setConfigOpen] = useState(false)
  const [detail, setDetail] = useState<Reservation | null>(null)

  useEffect(() => { const i = setInterval(() => setTick(Date.now()), 30_000); return () => clearInterval(i) }, [])
  const live = time === null && dateKey === todayKey(tz)
  const at = useMemo(() => (time ? new Date(zonedToUtcIso(dateKey, time, tz)) : live ? new Date(tick) : new Date(zonedToUtcIso(dateKey, '20:00', tz))), [time, dateKey, tz, live, tick])

  const range = dayRangeUtc(dateKey, dateKey, tz)
  const { data: reservations = [] } = useReservations(tenant.id, { from: range.from, to: range.to })
  const { data: blocks = [] } = useBlocks(tenant.id, range.from, range.to)

  const visible = tables.filter((t) => area === 'all' || t.area_id === area)
  const states = useMemo(() => new Map(tables.map((t) => [t.id, tableState(t, reservations, blocks, at)])), [tables, reservations, blocks, at])
  const counts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const t of visible) { const s = states.get(t.id)!.status; c[s] = (c[s] ?? 0) + 1 }
    return c
  }, [visible, states])
  const seated = reservations.filter((r) => r.status === 'in_progress' && r.table_ids.length && (area === 'all' || r.area_id === area)).reduce((s, r) => s + r.party_size, 0)
  const seats = visible.filter((t) => t.is_active).reduce((s, t) => s + t.max_capacity, 0)
  const dirty = Object.keys(positions).length > 0

  const pos = (t: DiningTable) => positions[t.id] ?? { x: t.pos_x, y: t.pos_y }

  const finishEditing = async () => {
    if (dirty) {
      try {
        await saveLayout.mutateAsync(Object.entries(positions).map(([id, p]) => ({ id, pos_x: p.x, pos_y: p.y })))
        toast('success', 'Layout do salão salvo')
      } catch (e) { return toast('error', 'Erro ao salvar layout', errorMessage(e)) }
    }
    setPositions({})
    setEditing(false)
  }

  if (isLoading) return <div className="skeleton h-96 rounded-2xl" />

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <h1 className="text-2xl font-bold md:text-3xl">Salão</h1>
          <p className="mt-1 text-sm text-ink-400">
            {editing ? 'Arraste as mesas para montar o salão. Toque em uma mesa para editar.' : live ? `Ao vivo · ${fmt(at, tz, 'HH:mm')}` : `Situação em ${keyLabel(dateKey, 'dd/MM')} às ${fmt(at, tz, 'HH:mm')}`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!editing && (
            <>
              <Input type="date" value={dateKey} onChange={(e) => { setDateKey(e.target.value || todayKey(tz)); if (e.target.value !== todayKey(tz) && !time) setTime('20:00') }} className="h-9 w-[150px]" />
              <Input type="time" value={time ?? fmt(at, tz, 'HH:mm')} onChange={(e) => setTime(e.target.value || null)} className="h-9 w-[124px]" />
              {!live && <Button size="sm" variant="ghost" className="h-9" onClick={() => { setDateKey(todayKey(tz)); setTime(null) }}><Clock className="h-3.5 w-3.5" /> Agora</Button>}
              <Segmented value={view} onChange={setView} options={[{ value: 'map', label: <span className="flex items-center gap-1"><LayoutGrid className="h-3.5 w-3.5" /> Mapa</span> }, { value: 'list', label: <span className="flex items-center gap-1"><List className="h-3.5 w-3.5" /> Lista</span> }]} />
            </>
          )}
          {isManager && (editing ? (
            <>
              <Button size="sm" variant="secondary" className="h-9" onClick={() => setNewTable(true)}><Plus className="h-3.5 w-3.5" /> Mesa</Button>
              <Button size="sm" variant="secondary" className="h-9" onClick={() => setConfigOpen(true)}><Settings2 className="h-3.5 w-3.5" /> Ambientes e uniões</Button>
              {dirty && <Button size="sm" variant="ghost" className="h-9" onClick={() => setPositions({})}>Descartar</Button>}
              <Button size="sm" className="h-9" loading={saveLayout.isPending} onClick={finishEditing}><Save className="h-3.5 w-3.5" /> {dirty ? 'Salvar layout' : 'Concluir'}</Button>
            </>
          ) : (
            <Button size="sm" variant="secondary" className="h-9" onClick={() => { setEditing(true); setView('map') }}><Pencil className="h-3.5 w-3.5" /> Editar salão</Button>
          ))}
        </div>
      </div>

      {settings?.allocation_mode !== 'tables' && tables.length > 0 && (
        <div className="flex flex-col gap-2 rounded-2xl border border-amber-400/30 bg-amber-400/[0.07] px-4 py-3 text-sm text-amber-100 sm:flex-row sm:items-center sm:justify-between">
          <span>As reservas ainda usam capacidade geral. Ative a alocação por mesas para o sistema escolher a mesa de cada reserva automaticamente.</span>
          <Link to="/app/configuracoes?tab=regras" className="shrink-0 font-semibold text-amber-300 hover:underline">Ativar em Regras de reserva →</Link>
        </div>
      )}

      {/* area tabs */}
      {areas.length > 0 && (
        <div className="-mx-4 flex gap-1.5 overflow-x-auto px-4 md:mx-0 md:px-0">
          {[{ id: 'all', name: 'Todos os ambientes' }, ...areas.filter((a) => a.is_active)].map((a) => (
            <button key={a.id} onClick={() => setArea(a.id)}
              className={cn('chip shrink-0 px-3 py-1.5 text-sm transition', area === a.id ? 'border-lime/40 bg-lime/10 text-lime' : 'border-ink-700 text-ink-300 hover:text-ink-100')}>
              <Layers className="h-3.5 w-3.5" /> {a.name}
              <span className="text-ink-500">{a.id === 'all' ? tables.length : tables.filter((t) => t.area_id === a.id).length}</span>
            </button>
          ))}
        </div>
      )}

      {/* summary */}
      {!editing && tables.length > 0 && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-7">
          {STATUS_ORDER_FLOOR.map((s) => (
            <div key={s} className="flex items-center gap-2.5 rounded-xl border border-ink-800 bg-ink-900/70 px-3 py-2.5">
              <span className={cn('h-2.5 w-2.5 rounded-full', TABLE_STATUS[s].dot)} />
              <span className="flex-1 truncate text-xs text-ink-300">{TABLE_STATUS[s].label}</span>
              <span className="font-display text-lg font-bold tabular-nums">{counts[s] ?? 0}</span>
            </div>
          ))}
          <div className="flex items-center gap-2.5 rounded-xl border border-ink-800 bg-ink-900/70 px-3 py-2.5">
            <Users className="h-3.5 w-3.5 text-ink-400" />
            <span className="flex-1 truncate text-xs text-ink-300">No salão</span>
            <span className="font-display text-lg font-bold tabular-nums">{seated}<span className="text-xs font-normal text-ink-500">/{seats}</span></span>
          </div>
          <div className="flex items-center gap-2.5 rounded-xl border border-ink-800 bg-ink-900/70 px-3 py-2.5">
            <Armchair className="h-3.5 w-3.5 text-ink-400" />
            <span className="flex-1 truncate text-xs text-ink-300">Ocupação</span>
            <span className="font-display text-lg font-bold tabular-nums">{visible.length ? Math.round((((counts.occupied ?? 0) + (counts.arriving ?? 0)) / visible.length) * 100) : 0}%</span>
          </div>
        </div>
      )}

      {tables.length === 0 ? (
        <Card>
          <EmptyState icon={<Armchair className="h-6 w-6" />} title="Monte seu salão"
            description="Cadastre as mesas com capacidade e ambiente. Depois é só arrastar para reproduzir a disposição real."
            action={isManager ? <Button onClick={() => { setEditing(true); setNewTable(true) }}><Plus className="h-4 w-4" /> Adicionar primeira mesa</Button> : undefined} />
        </Card>
      ) : view === 'map' ? (
        <FloorCanvas
          tables={visible} states={states} editing={editing} pos={pos} tz={tz}
          onMove={(id, x, y) => setPositions((p) => ({ ...p, [id]: { x, y } }))}
          onSelect={setSelected}
        />
      ) : (
        <FloorList tables={visible} areas={areas} states={states} tz={tz} onSelect={setSelected} />
      )}

      {!editing && tables.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-ink-500">
          {STATUS_ORDER_FLOOR.map((s) => <span key={s} className="flex items-center gap-1.5"><span className={cn('h-2 w-2 rounded-full', TABLE_STATUS[s].dot)} /> {TABLE_STATUS[s].label}</span>)}
        </div>
      )}

      {editing ? (
        <TableEditor open={!!selected || newTable} table={selected} onClose={() => { setSelected(null); setNewTable(false) }}
          nextPosition={{ x: 40 + (tables.length % 8) * 115, y: 40 + Math.floor(tables.length / 8) * 115 }} defaultArea={area !== 'all' ? area : areas[0]?.id ?? null} />
      ) : (
        <TableSheet table={selected} state={selected ? states.get(selected.id) : undefined} at={at} onClose={() => setSelected(null)} onOpenReservation={(r) => { setSelected(null); setDetail(r) }} />
      )}
      <FloorConfig open={configOpen} onClose={() => setConfigOpen(false)} />
      <ReservationDetail reservation={detail} onClose={() => setDetail(null)} />
    </div>
  )
}

/* ---------------------------------------------------------------- map */
function FloorCanvas({ tables, states, editing, pos, tz, onMove, onSelect }: {
  tables: DiningTable[]; states: Map<string, TableState>; editing: boolean; tz: string
  pos: (t: DiningTable) => { x: number; y: number }
  onMove: (id: string, x: number, y: number) => void; onSelect: (t: DiningTable) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)
  const drag = useRef<{ id: string; sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setScale(e.contentRect.width / CANVAS_W))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const down = (e: RPointerEvent, t: DiningTable) => {
    if (!editing) return
    const p = pos(t)
    drag.current = { id: t.id, sx: e.clientX, sy: e.clientY, ox: p.x, oy: p.y, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  const move = (e: RPointerEvent, t: DiningTable) => {
    const d = drag.current
    if (!d || d.id !== t.id) return
    const dx = (e.clientX - d.sx) / scale
    const dy = (e.clientY - d.sy) / scale
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true
    const snap = (v: number) => Math.round(v / 10) * 10
    onMove(t.id, Math.max(0, Math.min(CANVAS_W - t.width, snap(d.ox + dx))), Math.max(0, Math.min(CANVAS_H - t.height, snap(d.oy + dy))))
  }
  const up = (t: DiningTable) => {
    if (!editing) return
    const d = drag.current
    drag.current = null
    if (!d?.moved) onSelect(t)
  }

  return (
    <div className="-mx-4 overflow-x-auto px-4 md:mx-0 md:px-0">
      <div ref={ref} className={cn('relative min-w-[680px] overflow-hidden rounded-2xl border bg-ink-900/80', editing ? 'border-lime/40 grid-bg' : 'border-ink-800')}
        style={{ height: CANVAS_H * scale }}>
        {tables.map((t) => {
          const p = pos(t)
          const st = states.get(t.id)!
          const s = TABLE_STATUS[editing ? 'available' : st.status]
          const r = st.current ?? st.next
          const w = t.width * scale
          const h = t.height * scale
          return (
            <button key={t.id} type="button"
              onPointerDown={(e) => down(e, t)} onPointerMove={(e) => move(e, t)} onPointerUp={() => up(t)}
              onClick={(e) => { if (editing) e.preventDefault(); else onSelect(t) }}
              className={cn('absolute flex select-none flex-col items-center justify-center border-2 text-center shadow-lg transition-[box-shadow,transform] hover:z-10 hover:scale-[1.04]',
                s.fill, s.ring, editing ? 'cursor-grab touch-none border-dashed bg-ink-800/80 active:cursor-grabbing' : 'cursor-pointer',
                !t.is_active && 'opacity-50',
                t.shape === 'round' ? 'rounded-full' : 'rounded-2xl')}
              style={{ left: p.x * scale, top: p.y * scale, width: w, height: h }}>
              <span className="font-display text-[13px] font-bold leading-tight text-ink-50" style={{ fontSize: Math.max(11, 15 * scale) }}>{t.name}</span>
              <span className="flex items-center gap-0.5 text-[10px] text-ink-300"><Users className="h-2.5 w-2.5" />{t.min_capacity > 1 ? `${t.min_capacity}-` : ''}{t.max_capacity}</span>
              {!editing && r && h > 70 && (
                <span className={cn('mt-0.5 max-w-full truncate px-1 text-[10px] font-medium', s.text)}>{fmtTime(r.starts_at, tz)} {r.customer_name.split(' ')[0]}</span>
              )}
              {editing && <Move className="absolute right-1 top-1 h-3 w-3 text-ink-500" />}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/* --------------------------------------------------------------- list */
function FloorList({ tables, areas, states, tz, onSelect }: {
  tables: DiningTable[]; areas: { id: string; name: string }[]; states: Map<string, TableState>; tz: string; onSelect: (t: DiningTable) => void
}) {
  const groups = [...areas.map((a) => ({ id: a.id, name: a.name })), { id: null, name: 'Sem ambiente' }]
    .map((g) => ({ ...g, tables: tables.filter((t) => t.area_id === g.id) }))
    .filter((g) => g.tables.length)
  return (
    <div className="space-y-5">
      {groups.map((g) => (
        <div key={g.id ?? 'none'}>
          <p className="mb-2 px-1 text-xs font-semibold uppercase tracking-wider text-ink-400">{g.name}</p>
          <Card className="divide-y divide-ink-800">
            {g.tables.map((t) => {
              const st = states.get(t.id)!
              const r = st.current ?? st.next
              return (
                <button key={t.id} onClick={() => onSelect(t)} className="flex w-full items-center gap-4 px-4 py-3 text-left hover:bg-ink-850">
                  <div className={cn('grid h-11 w-11 shrink-0 place-items-center border-2 font-display text-sm font-bold', TABLE_STATUS[st.status].fill, TABLE_STATUS[st.status].ring, t.shape === 'round' ? 'rounded-full' : 'rounded-xl')}>{t.name}</div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold">{TABLE_STATUS[st.status].label}</p>
                    <p className="truncate text-xs text-ink-400">{t.max_capacity} lugares{r ? ` · ${fmtTime(r.starts_at, tz)} ${r.customer_name} (${r.party_size}p)` : ''}</p>
                  </div>
                  <span className="text-xs text-ink-500">{st.today.length} hoje</span>
                </button>
              )
            })}
          </Card>
        </div>
      ))}
    </div>
  )
}

/* --------------------------------------------------- table operations */
function TableSheet({ table, state, at, onClose, onOpenReservation }: {
  table: DiningTable | null; state?: TableState; at: Date; onClose: () => void; onOpenReservation: (r: Reservation) => void
}) {
  const { tenant } = useCurrentTenant()
  const tz = tenant.timezone
  const toast = useToast()
  const { data: settings } = useBookingSettings(tenant.id)
  const { create, setStatus } = useReservationMutations(tenant.id)
  const [walkIn, setWalkIn] = useState(false)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [party, setParty] = useState(2)
  useEffect(() => { setWalkIn(false); setName(''); setPhone(''); setParty(Math.min(2, table?.max_capacity ?? 2)) }, [table])
  if (!table || !state) return null
  const s = TABLE_STATUS[state.status]

  const act = async (r: Reservation, status: Reservation['status'], msg: string) => {
    try { await setStatus.mutateAsync({ id: r.id, status }); toast('success', msg) } catch (e) { toast('error', 'Erro', errorMessage(e)) }
  }
  const seat = async () => {
    if (name.trim().length < 2) return toast('error', 'Informe o nome do cliente')
    if (!isValidPhone(phone)) return toast('error', 'Informe o telefone com DDD')
    const start = new Date(Math.floor(Date.now() / 60000) * 60000)
    try {
      await create.mutateAsync({
        customer_name: name.trim(), customer_phone: phone, party_size: party, source: 'walk_in', status: 'in_progress',
        starts_at: start.toISOString(), ends_at: new Date(+start + (settings?.default_duration_min ?? 90) * 60000).toISOString(), table_ids: [table.id],
      })
      toast('success', `Mesa ${table.name} ocupada`)
      onClose()
    } catch (e) { toast('error', 'Não foi possível sentar o cliente', errorMessage(e)) }
  }

  const cur = state.current
  return (
    <Sheet open onClose={onClose} title={`Mesa ${table.name}`}
      subtitle={<span className="flex items-center gap-2"><span className={cn('chip', s.fill, s.ring, s.text)}><span className={cn('h-1.5 w-1.5 rounded-full', s.dot)} />{s.label}</span> {table.min_capacity}–{table.max_capacity} lugares</span>}>
      <div className="space-y-5">
        {state.block && <p className="rounded-xl border border-ink-700 bg-ink-850 px-3 py-2.5 text-sm text-ink-300">Bloqueada: {state.block.reason ?? 'sem motivo'} (até {fmtTime(state.block.ends_at, tz)})</p>}
        {!table.is_active && <p className="rounded-xl border border-ink-700 bg-ink-850 px-3 py-2.5 text-sm text-ink-300">Mesa desativada — não recebe reservas.</p>}

        {cur && (
          <div className="rounded-2xl border border-ink-700 bg-ink-850 p-4">
            <p className="text-xs text-ink-400">{state.status === 'occupied' ? 'Ocupada por' : 'Chegada aguardada'}</p>
            <button onClick={() => onOpenReservation(cur)} className="mt-1 text-left">
              <p className="text-lg font-semibold">{cur.customer_name}</p>
              <p className="text-sm text-ink-300">{fmtTime(cur.starts_at, tz)}–{fmtTime(cur.ends_at, tz)} · {cur.party_size} pessoa(s){cur.table_ids.length > 1 ? ' · mesas unidas' : ''}</p>
            </button>
            <div className="mt-3 flex flex-wrap gap-2">
              {state.status === 'occupied' && <Button size="sm" onClick={() => act(cur, 'completed', `Mesa ${table.name} liberada`)}><Check className="h-3.5 w-3.5" /> Liberar mesa</Button>}
              {state.status === 'arriving' && (
                <>
                  <Button size="sm" onClick={() => act(cur, 'in_progress', 'Check-in realizado')}><Check className="h-3.5 w-3.5" /> Check-in</Button>
                  <Button size="sm" variant="secondary" onClick={() => act(cur, 'no_show', 'Marcado como não compareceu')}>Não veio</Button>
                </>
              )}
            </div>
          </div>
        )}

        {table.is_active && !state.block && state.status !== 'occupied' && Math.abs(+at - Date.now()) < 15 * 60000 && (
          walkIn ? (
            <div className="space-y-3 rounded-2xl border border-lime/30 bg-lime/[0.04] p-4">
              <p className="text-sm font-semibold">Sentar cliente sem reserva</p>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nome" />
              <Input value={phone} onChange={(e) => setPhone(formatPhone(e.target.value))} placeholder="Telefone (para o CRM)" inputMode="tel" />
              <Select value={party} onChange={(e) => setParty(Number(e.target.value))}>
                {Array.from({ length: Math.max(table.max_capacity, 1) }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n} pessoa(s)</option>)}
              </Select>
              <div className="flex gap-2">
                <Button variant="ghost" onClick={() => setWalkIn(false)}>Cancelar</Button>
                <Button className="flex-1" onClick={seat} loading={create.isPending}>Ocupar mesa</Button>
              </div>
            </div>
          ) : (
            <Button variant="secondary" className="w-full" onClick={() => setWalkIn(true)}><UserPlus className="h-4 w-4" /> Sentar cliente agora (sem reserva)</Button>
          )
        )}

        <div>
          <p className="label">Reservas desta mesa no dia</p>
          {state.today.length === 0 ? <p className="text-sm text-ink-500">Nenhuma reserva.</p> : (
            <div className="space-y-2">
              {state.today.map((r) => (
                <button key={r.id} onClick={() => onOpenReservation(r)} className="flex w-full items-center gap-3 rounded-xl border border-ink-700 bg-ink-850 px-3 py-2.5 text-left hover:border-ink-600">
                  <span className="w-12 font-display font-bold tabular-nums">{fmtTime(r.starts_at, tz)}</span>
                  <span className="min-w-0 flex-1 truncate text-sm">{r.customer_name} · {r.party_size}p</span>
                  <StatusBadge status={r.status} />
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </Sheet>
  )
}

/* -------------------------------------------------------- table editor */
function TableEditor({ open, table, onClose, nextPosition, defaultArea }: {
  open: boolean; table: DiningTable | null; onClose: () => void; nextPosition: { x: number; y: number }; defaultArea: string | null
}) {
  const { tenant } = useCurrentTenant()
  const toast = useToast()
  const { data: areas = [] } = useAreas(tenant.id)
  const { saveTable, deleteTable } = useFloorMutations(tenant.id)
  const [f, setF] = useState({ name: '', area_id: '' as string, min_capacity: 1, max_capacity: 4, shape: 'square' as TableShape, is_active: true })
  const [confirmDel, setConfirmDel] = useState(false)
  useEffect(() => {
    if (!open) return
    setF(table
      ? { name: table.name, area_id: table.area_id ?? '', min_capacity: table.min_capacity, max_capacity: table.max_capacity, shape: table.shape, is_active: table.is_active }
      : { name: '', area_id: defaultArea ?? '', min_capacity: 1, max_capacity: 4, shape: 'square', is_active: true })
  }, [open, table, defaultArea])

  const size = (shape: TableShape, cap: number) => shape === 'rect' ? { width: Math.min(220, 70 + cap * 18), height: 80 } : { width: cap > 4 ? 110 : 85, height: cap > 4 ? 110 : 85 }

  const save = async () => {
    if (!f.name.trim()) return toast('error', 'Dê um nome à mesa')
    if (f.max_capacity < f.min_capacity) return toast('error', 'Capacidade máxima menor que a mínima')
    try {
      await saveTable.mutateAsync({
        id: table?.id, name: f.name, area_id: f.area_id || null, min_capacity: f.min_capacity, max_capacity: f.max_capacity, shape: f.shape,
        is_active: f.is_active, ...size(f.shape, f.max_capacity), ...(table ? {} : { pos_x: nextPosition.x, pos_y: nextPosition.y }),
      })
      toast('success', table ? 'Mesa atualizada' : 'Mesa criada')
      onClose()
    } catch (e) { toast('error', 'Erro', errorMessage(e)) }
  }

  return (
    <>
      <Sheet open={open} onClose={onClose} title={table ? `Editar mesa ${table.name}` : 'Nova mesa'}
        footer={<div className="flex gap-2">
          {table && <Button variant="ghost" className="text-rose-300" onClick={() => setConfirmDel(true)}><Trash2 className="h-4 w-4" /></Button>}
          <Button className="flex-1" onClick={save} loading={saveTable.isPending}>Salvar</Button>
        </div>}>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Nome / número"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Ex.: 12, V3, Bar 1" autoFocus /></Field>
            <Field label="Ambiente">
              <Select value={f.area_id} onChange={(e) => setF({ ...f, area_id: e.target.value })}>
                <option value="">Sem ambiente</option>
                {areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </Select>
            </Field>
            <Field label="Mín. pessoas"><Input type="number" min={1} value={f.min_capacity} onChange={(e) => setF({ ...f, min_capacity: Number(e.target.value) })} /></Field>
            <Field label="Máx. pessoas"><Input type="number" min={1} value={f.max_capacity} onChange={(e) => setF({ ...f, max_capacity: Number(e.target.value) })} /></Field>
          </div>
          <div>
            <p className="label">Formato</p>
            <div className="grid grid-cols-3 gap-2">
              {(['square', 'round', 'rect'] as TableShape[]).map((sh) => (
                <button key={sh} onClick={() => setF({ ...f, shape: sh })}
                  className={cn('flex flex-col items-center gap-2 rounded-xl border p-3 text-xs', f.shape === sh ? 'border-lime/60 bg-lime/[0.06] text-lime' : 'border-ink-700 text-ink-300')}>
                  <span className={cn('border-2 border-current', sh === 'round' ? 'h-8 w-8 rounded-full' : sh === 'rect' ? 'h-6 w-12 rounded-md' : 'h-8 w-8 rounded-md')} />
                  {sh === 'square' ? 'Quadrada' : sh === 'round' ? 'Redonda' : 'Retangular'}
                </button>
              ))}
            </div>
          </div>
          <Switch checked={f.is_active} onChange={(v) => setF({ ...f, is_active: v })} label="Mesa ativa" description="Mesas inativas não recebem reservas (ex.: manutenção)." />
          <p className="text-xs text-ink-500">A mínima evita que uma mesa grande seja usada por grupos pequenos. Ex.: mesa de 8 com mínimo de 5.</p>
        </div>
      </Sheet>
      <ConfirmDialog open={confirmDel} danger title={`Excluir mesa ${table?.name}?`} confirmLabel="Excluir" loading={deleteTable.isPending}
        description="Mesas com reservas futuras não podem ser excluídas — desative-as." onClose={() => setConfirmDel(false)}
        onConfirm={async () => {
          try { await deleteTable.mutateAsync(table!.id); toast('success', 'Mesa excluída'); setConfirmDel(false); onClose() }
          catch (e) { toast('error', 'Não foi possível excluir', errorMessage(e)); setConfirmDel(false) }
        }} />
    </>
  )
}

/* ---------------------------------------------- areas & joined tables */
function FloorConfig({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { tenant } = useCurrentTenant()
  const toast = useToast()
  const { data: areas = [] } = useAreas(tenant.id)
  const { data: tables = [] } = useTables(tenant.id)
  const { data: combos = [] } = useCombinations(tenant.id)
  const { saveArea, deleteArea, saveCombination, deleteCombination } = useFloorMutations(tenant.id)
  const [areaName, setAreaName] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const [comboMin, setComboMin] = useState(1)
  const pickedCap = picked.reduce((s, id) => s + (tables.find((t) => t.id === id)?.max_capacity ?? 0), 0)
  const name = (id: string) => tables.find((t) => t.id === id)?.name ?? '?'

  const run = async (p: Promise<unknown>, msg: string) => { try { await p; toast('success', msg) } catch (e) { toast('error', 'Erro', errorMessage(e)) } }

  return (
    <Sheet open={open} onClose={onClose} wide title="Ambientes e uniões de mesas">
      <div className="space-y-8">
        <section>
          <h3 className="font-semibold">Ambientes</h3>
          <p className="mt-0.5 text-sm text-ink-400">Ex.: Salão interno, Varanda, Área externa. O cliente pode escolher o ambiente preferido ao reservar.</p>
          <div className="mt-3 flex gap-2">
            <Input value={areaName} onChange={(e) => setAreaName(e.target.value)} placeholder="Nome do ambiente" />
            <Button onClick={() => { if (areaName.trim()) void run(saveArea.mutateAsync({ name: areaName.trim(), sort_order: areas.length + 1 }), 'Ambiente criado').then(() => setAreaName('')) }}>Adicionar</Button>
          </div>
          <div className="mt-3 space-y-2">
            {areas.map((a) => (
              <div key={a.id} className="flex items-center gap-3 rounded-xl border border-ink-700 bg-ink-850 px-3 py-2.5">
                <Layers className="h-4 w-4 text-ink-400" />
                <span className="flex-1 text-sm">{a.name} <span className="text-ink-500">· {tables.filter((t) => t.area_id === a.id).length} mesas</span></span>
                <Switch checked={a.is_active} onChange={(v) => void run(saveArea.mutateAsync({ ...a, is_active: v }), v ? 'Ambiente ativado' : 'Ambiente desativado')} />
                <button onClick={() => void run(deleteArea.mutateAsync(a.id), 'Ambiente removido')} className="rounded-lg p-1.5 text-ink-400 hover:text-rose-300"><Trash2 className="h-4 w-4" /></button>
              </div>
            ))}
          </div>
        </section>

        <section>
          <h3 className="flex items-center gap-2 font-semibold"><Link2 className="h-4 w-4 text-lime" /> Uniões de mesas</h3>
          <p className="mt-0.5 text-sm text-ink-400">Defina quais mesas podem ser juntadas para grupos maiores. A alocação automática usa uma união somente quando nenhuma mesa sozinha comporta o grupo.</p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {tables.filter((t) => t.is_active).map((t) => (
              <button key={t.id} onClick={() => setPicked((p) => (p.includes(t.id) ? p.filter((x) => x !== t.id) : [...p, t.id]))}
                className={cn('chip px-3 py-1.5 text-sm', picked.includes(t.id) ? 'border-lime/50 bg-lime/10 text-lime' : 'border-ink-700 text-ink-300')}>
                {t.name} <span className="text-ink-500">{t.max_capacity}</span>
              </button>
            ))}
          </div>
          {picked.length >= 2 && (
            <div className="mt-3 flex flex-wrap items-end gap-2 rounded-xl border border-ink-700 bg-ink-850 p-3">
              <p className="flex-1 text-sm">{picked.map(name).join(' + ')} · <b>{pickedCap} lugares</b></p>
              <Field label="Mín. pessoas"><Input type="number" min={1} value={comboMin} onChange={(e) => setComboMin(Number(e.target.value))} className="h-9 w-24" /></Field>
              <Button size="sm" className="h-9" onClick={() => void run(saveCombination.mutateAsync({ name: picked.map(name).join(' + '), table_ids: picked, min_capacity: comboMin, max_capacity: pickedCap }), 'União criada').then(() => setPicked([]))}>Criar união</Button>
            </div>
          )}
          <div className="mt-3 space-y-2">
            {combos.map((c) => (
              <div key={c.id} className="flex items-center gap-3 rounded-xl border border-ink-700 bg-ink-850 px-3 py-2.5">
                <Link2 className="h-4 w-4 text-ink-400" />
                <span className="flex-1 text-sm">{c.table_ids.map(name).join(' + ')} <span className="text-ink-500">· {c.min_capacity}–{c.max_capacity} pessoas</span></span>
                <button onClick={() => void run(deleteCombination.mutateAsync(c.id), 'União removida')} className="rounded-lg p-1.5 text-ink-400 hover:text-rose-300"><X className="h-4 w-4" /></button>
              </div>
            ))}
            {combos.length === 0 && <p className="text-sm text-ink-500">Nenhuma união cadastrada.</p>}
          </div>
        </section>
      </div>
    </Sheet>
  )
}
