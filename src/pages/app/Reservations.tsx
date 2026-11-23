import { useEffect, useMemo, useState } from 'react'
import { Download, Search, CalendarRange, Inbox } from 'lucide-react'
import { useCurrentTenant } from '@/hooks/useTenant'
import { useReservations } from '@/api/reservations'
import { useShell } from '@/components/layout/AppShell'
import { Button, Card, EmptyState, Input, Segmented, Select } from '@/components/ui/ui'
import { ReservationDetail, StatusBadge } from '@/components/reservations/ReservationDetail'
import { dayRangeUtc, fmt, fmtTime, shiftKey, todayKey } from '@/lib/datetime'
import { SEGMENT, SOURCE, STATUS, STATUS_ORDER, newUnit } from '@/lib/constants'
import { cn, formatPhone } from '@/lib/utils'
import type { Reservation, ReservationSource, ReservationStatus } from '@/types/db'

type Preset = 'today' | 'next7' | 'last30' | 'custom'

export default function Reservations() {
  const { tenant } = useCurrentTenant()
  const tz = tenant.timezone
  const { newReservation } = useShell()
  const today = todayKey(tz)
  const [preset, setPreset] = useState<Preset>('next7')
  const [from, setFrom] = useState(today)
  const [to, setTo] = useState(shiftKey(today, 6))
  const [statuses, setStatuses] = useState<ReservationStatus[]>([])
  const [source, setSource] = useState<ReservationSource | ''>('')
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [selected, setSelected] = useState<Reservation | null>(null)

  useEffect(() => { const t = setTimeout(() => setDebounced(search), 250); return () => clearTimeout(t) }, [search])
  useEffect(() => {
    if (preset === 'today') { setFrom(today); setTo(today) }
    if (preset === 'next7') { setFrom(today); setTo(shiftKey(today, 6)) }
    if (preset === 'last30') { setFrom(shiftKey(today, -29)); setTo(today) }
  }, [preset, today])

  const utc = dayRangeUtc(from, to, tz)
  const { data = [], isLoading } = useReservations(tenant.id, { from: utc.from, to: utc.to, status: statuses, search: debounced })
  const rows = useMemo(() => (source ? data.filter((r) => r.source === source) : data), [data, source])
  useEffect(() => { if (selected) { const f = rows.find((r) => r.id === selected.id); if (f && f.updated_at !== selected.updated_at) setSelected(f) } }, [rows, selected])

  const counts = useMemo(() => {
    const c: Partial<Record<ReservationStatus, number>> = {}
    for (const r of data) c[r.status] = (c[r.status] ?? 0) + 1
    return c
  }, [data])

  const exportCsv = () => {
    const header = ['Código', 'Data', 'Hora', 'Cliente', 'Telefone', 'E-mail', 'Pessoas', 'Status', 'Origem', 'Observações', 'Criada em']
    const lines = rows.map((r) => [r.code, fmt(r.starts_at, tz, 'dd/MM/yyyy'), fmtTime(r.starts_at, tz), r.customer_name, r.customer_phone, r.customer_email ?? '',
      r.party_size, STATUS[r.status].label, SOURCE[r.source], (r.notes ?? '').replace(/\n/g, ' '), fmt(r.created_at, tz, 'dd/MM/yyyy HH:mm')])
    const csv = [header, ...lines].map((l) => l.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(';')).join('\n')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }))
    a.download = `reservas-${tenant.slug}-${from}_${to}.csv`
    a.click()
  }

  const toggle = (s: ReservationStatus) => setStatuses((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]))
  const seg = SEGMENT[tenant.segment]

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-2xl font-bold first-letter:uppercase md:text-3xl">{seg.unitPlural}</h1>
          <p className="mt-1 text-sm text-ink-400">{rows.length} resultado(s) · {rows.filter((r) => r.status !== 'cancelled').reduce((s, r) => s + r.party_size, 0)} pessoas</p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" className="h-9" onClick={exportCsv} disabled={!rows.length}><Download className="h-3.5 w-3.5" /> Exportar CSV</Button>
          <Button size="sm" className="hidden h-9 md:inline-flex" onClick={() => newReservation()}>{newUnit(tenant.segment)}</Button>
        </div>
      </div>

      <Card className="space-y-3 p-3 md:p-4">
        <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
          <Segmented value={preset} onChange={setPreset} options={[{ value: 'today', label: 'Hoje' }, { value: 'next7', label: 'Próximos 7 dias' }, { value: 'last30', label: 'Últimos 30' }, { value: 'custom', label: 'Período' }]} />
          {preset === 'custom' && (
            <div className="flex items-center gap-2">
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-9" />
              <CalendarRange className="h-4 w-4 shrink-0 text-ink-500" />
              <Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} className="h-9" />
            </div>
          )}
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Nome, telefone ou código" className="h-9 pl-10" />
          </div>
          <Select value={source} onChange={(e) => setSource(e.target.value as ReservationSource | '')} className="h-9 lg:w-44">
            <option value="">Todas as origens</option>
            {(Object.keys(SOURCE) as ReservationSource[]).map((s) => <option key={s} value={s}>{SOURCE[s]}</option>)}
          </Select>
        </div>
        <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-0.5">
          {STATUS_ORDER.map((s) => (
            <button key={s} onClick={() => toggle(s)}
              className={cn('chip shrink-0 transition', statuses.includes(s) ? STATUS[s].chip : 'border-ink-700 text-ink-400 hover:text-ink-200')}>
              <span className={cn('h-1.5 w-1.5 rounded-full', STATUS[s].dot)} /> {STATUS[s].label}
              <span className="text-ink-500">{counts[s] ?? 0}</span>
            </button>
          ))}
          {statuses.length > 0 && <button onClick={() => setStatuses([])} className="shrink-0 px-2 text-xs text-ink-400 hover:text-lime">Limpar</button>}
        </div>
      </Card>

      {isLoading ? (
        <div className="space-y-2">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="skeleton h-16 rounded-2xl" />)}</div>
      ) : rows.length === 0 ? (
        <Card><EmptyState icon={<Inbox className="h-6 w-6" />} title="Nenhuma reserva encontrada" description="Ajuste os filtros ou crie uma nova reserva." /></Card>
      ) : (
        <>
          {/* Desktop table */}
          <Card className="hidden overflow-hidden md:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-800 text-left text-[11px] uppercase tracking-wider text-ink-500">
                  <th className="px-5 py-3 font-semibold">Data</th>
                  <th className="px-3 py-3 font-semibold">Cliente</th>
                  <th className="px-3 py-3 font-semibold">Pessoas</th>
                  <th className="px-3 py-3 font-semibold">Origem</th>
                  <th className="px-3 py-3 font-semibold">Status</th>
                  <th className="px-5 py-3 text-right font-semibold">Código</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-800/80">
                {rows.map((r) => (
                  <tr key={r.id} onClick={() => setSelected(r)} className="cursor-pointer transition hover:bg-ink-850">
                    <td className="px-5 py-3.5">
                      <p className="font-semibold tabular-nums">{fmt(r.starts_at, tz, 'dd/MM')} <span className="text-lime">{fmtTime(r.starts_at, tz)}</span></p>
                      <p className="text-xs first-letter:uppercase text-ink-500">{fmt(r.starts_at, tz, 'EEEE')}</p>
                    </td>
                    <td className="px-3 py-3.5">
                      <p className="font-medium">{r.customer_name}</p>
                      <p className="text-xs text-ink-400">{formatPhone(r.customer_phone)}</p>
                    </td>
                    <td className="px-3 py-3.5 tabular-nums">{r.party_size}</td>
                    <td className="px-3 py-3.5 text-ink-300">{SOURCE[r.source]}</td>
                    <td className="px-3 py-3.5"><StatusBadge status={r.status} /></td>
                    <td className="px-5 py-3.5 text-right font-mono text-xs text-ink-400">{r.code}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          {/* Mobile cards */}
          <div className="space-y-2 md:hidden">
            {rows.map((r) => (
              <button key={r.id} onClick={() => setSelected(r)} className="card flex w-full items-center gap-3 p-3.5 text-left">
                <div className="grid h-12 w-12 shrink-0 place-items-center rounded-xl border border-ink-700 bg-ink-850 text-center leading-tight">
                  <span className="text-[10px] uppercase text-ink-400">{fmt(r.starts_at, tz, 'dd/MM')}</span>
                  <span className="text-sm font-bold">{fmtTime(r.starts_at, tz)}</span>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{r.customer_name}</p>
                  <p className="text-xs text-ink-400">{r.party_size} pessoa(s) · {SOURCE[r.source]}</p>
                </div>
                <StatusBadge status={r.status} />
              </button>
            ))}
          </div>
        </>
      )}

      <ReservationDetail reservation={selected} onClose={() => setSelected(null)} />
    </div>
  )
}
