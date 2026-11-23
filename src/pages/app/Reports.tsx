import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Download, Lock } from 'lucide-react'
import { useCurrentTenant } from '@/hooks/useTenant'
import { useReport } from '@/api/intelligence'
import { usePlanUsage } from '@/api/saas'
import { useBookingSettings } from '@/api/tenant'
import { Button, Card, CardHeader, Input, Segmented } from '@/components/ui/ui'
import { InsightCards } from '@/components/intelligence/InsightCards'
import { AssistantPanel } from '@/components/intelligence/AssistantPanel'
import { shiftKey, todayKey, WEEKDAYS_SHORT } from '@/lib/datetime'
import { SOURCE } from '@/lib/constants'
import { cn, formatMoney } from '@/lib/utils'
import type { ReportData } from '@/types/db'

type Preset = '7' | '30' | '90' | 'custom'
const ORDER = [1, 2, 3, 4, 5, 6, 0]
const fmtN = (v: number | null | undefined, suffix = '') => (v == null ? '—' : `${v.toLocaleString('pt-BR')}${suffix}`)

export default function Reports() {
  const { tenant } = useCurrentTenant()
  const tz = tenant.timezone
  const today = todayKey(tz)
  const [preset, setPreset] = useState<Preset>('30')
  const [from, setFrom] = useState(shiftKey(today, -29))
  const [to, setTo] = useState(today)
  const range = preset === 'custom' ? { from, to } : { from: shiftKey(today, 1 - Number(preset)), to: today }
  const { data: usage } = usePlanUsage(tenant.id)
  const { data: settings } = useBookingSettings(tenant.id)
  const advanced = usage?.features.reports_advanced ?? false
  const { data: r, isLoading } = useReport(tenant.id, range.from, range.to, advanced)

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-2xl font-bold md:text-3xl">Relatórios</h1>
          <p className="mt-1 text-sm text-ink-400">Indicadores, recomendações e um assistente que responde perguntas usando somente seus dados.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented value={preset} onChange={setPreset} options={[{ value: '7', label: '7 dias' }, { value: '30', label: '30 dias' }, { value: '90', label: '90 dias' }, { value: 'custom', label: 'Período' }]} />
          {preset === 'custom' && (
            <>
              <Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className="h-9 w-[150px]" />
              <Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} className="h-9 w-[150px]" />
            </>
          )}
          {r && <Button size="sm" variant="secondary" className="h-9" onClick={() => exportCsv(r, tenant.slug)}><Download className="h-3.5 w-3.5" /> CSV</Button>}
        </div>
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-400">Recomendações (últimos 30 dias)</h2>
        <InsightCards tenantId={tenant.id} />
      </section>

      <AssistantPanel tenantId={tenant.id} segment={tenant.segment} />

      {!advanced ? (
        <Card className="flex flex-col items-center gap-3 p-10 text-center">
          <Lock className="h-6 w-6 text-ink-400" />
          <p className="font-semibold">Relatórios avançados no plano Pro</p>
          <p className="max-w-md text-sm text-ink-400">Mapa de horários, faltas por dia, motivos de cancelamento, ocupação por mesa ou profissional e clientes recorrentes. O Dashboard continua com os indicadores principais.</p>
          <Link to="/app/plano" className="text-sm font-semibold text-lime hover:underline">Ver planos</Link>
        </Card>
      ) : isLoading || !r ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{Array.from({ length: 8 }).map((_, i) => <div key={i} className="skeleton h-24 rounded-2xl" />)}</div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[
              ['Reservas', fmtN(r.summary.reservations)], ['Atendidas', fmtN(r.summary.attended)], ['Pessoas', fmtN(r.summary.guests)],
              ['Pessoas por reserva', fmtN(r.summary.avg_party)], ['Cancelamentos', `${fmtN(r.summary.cancelled)} · ${fmtN(r.summary.cancel_rate, '%')}`],
              ['Faltas', `${fmtN(r.summary.no_show)} · ${fmtN(r.summary.no_show_rate, '%')}`], ['Reservas online', fmtN(r.summary.online_share, '%')],
              ['Antecedência (mediana)', r.summary.lead_time_hours_median == null ? '—' : r.summary.lead_time_hours_median >= 48 ? `${Math.round(r.summary.lead_time_hours_median / 24)} dias` : `${r.summary.lead_time_hours_median} h`],
            ].map(([l, v]) => (
              <Card key={l} className="p-4"><p className="font-display text-xl font-bold tabular-nums">{v}</p><p className="mt-0.5 text-xs text-ink-400">{l}</p></Card>
            ))}
          </div>

          <Card>
            <CardHeader title="Mapa de movimento" subtitle="Reservas por dia da semana e hora (exceto canceladas)" />
            <Heatmap data={r.heatmap} />
          </Card>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader title="Faltas por dia da semana" />
              <div className="h-[220px] px-2 pb-3 pt-4">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={ORDER.map((w) => ({ d: WEEKDAYS_SHORT[w], ...(r.no_show_by_weekday.find((x) => x.weekday === w) ?? { no_show: 0, total: 0 }) }))} margin={{ left: -24, right: 8 }}>
                    <CartesianGrid stroke="#1E1E22" vertical={false} />
                    <XAxis dataKey="d" tick={{ fill: '#6C6C76', fontSize: 11 }} axisLine={false} tickLine={false} />
                    <YAxis allowDecimals={false} tick={{ fill: '#6C6C76', fontSize: 11 }} axisLine={false} tickLine={false} />
                    <Tooltip cursor={{ fill: 'rgba(255,255,255,0.03)' }} contentStyle={{ background: '#151519', border: '1px solid #2C2C33', borderRadius: 12 }} />
                    <Bar dataKey="no_show" name="Faltas" fill="#FB923C" radius={[6, 6, 2, 2]} maxBarSize={28} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>
            <Card>
              <CardHeader title="Origem e cancelamentos" />
              <div className="grid gap-5 p-5 sm:grid-cols-2">
                <Ranking title="Origem" rows={r.by_source.map((s) => ({ label: SOURCE[s.source], value: s.count }))} />
                <Ranking title="Motivos de cancelamento" rows={r.cancel_reasons.map((c) => ({ label: c.reason, value: c.count }))} empty="Nenhum cancelamento" />
              </div>
            </Card>
          </div>

          {settings?.allocation_mode === 'tables' || r.tables.length > 0 ? (
            <Card>
              <CardHeader title="Ocupação por mesa" subtitle="Minutos reservados ÷ minutos de funcionamento no período" />
              <div className="overflow-x-auto p-3">
                <table className="w-full min-w-[520px] text-sm">
                  <thead><tr className="text-left text-[11px] uppercase tracking-wider text-ink-500"><th className="px-3 py-2">Mesa</th><th className="px-3 py-2">Ambiente</th><th className="px-3 py-2">Reservas</th><th className="px-3 py-2">Pessoas</th><th className="px-3 py-2">Ocupação</th></tr></thead>
                  <tbody className="divide-y divide-ink-800">
                    {r.tables.map((t) => (
                      <tr key={t.id}>
                        <td className="px-3 py-2.5 font-medium">{t.name}</td><td className="px-3 py-2.5 text-ink-400">{t.area ?? '—'}</td>
                        <td className="px-3 py-2.5 tabular-nums">{t.reservations}</td><td className="px-3 py-2.5 tabular-nums">{t.guests}</td>
                        <td className="px-3 py-2.5"><Bar100 value={t.occupancy} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          ) : null}

          {r.staff.by_staff.some((x) => x.appointments > 0) && (
            <div className="grid gap-6 lg:grid-cols-2">
              <Card>
                <CardHeader title="Profissionais" subtitle={r.staff.occupancy != null ? `Ocupação da agenda: ${r.staff.occupancy}%` : undefined} />
                <div className="p-5"><Ranking rows={r.staff.by_staff.filter((x) => x.appointments > 0).map((x) => ({ label: x.name, value: x.appointments, extra: x.revenue_cents ? formatMoney(x.revenue_cents) : undefined }))} /></div>
              </Card>
              <Card>
                <CardHeader title="Serviços" />
                <div className="p-5"><Ranking rows={r.staff.by_service.map((x) => ({ label: x.name, value: x.appointments, extra: x.revenue_cents ? formatMoney(x.revenue_cents) : undefined }))} /></div>
              </Card>
            </div>
          )}

          <Card>
            <CardHeader title="Clientes no período" subtitle={`${r.customers.new} novos · ${r.customers.returning} recorrentes`} />
            <div className="p-5"><Ranking title="Quem mais veio" rows={r.customers.top.map((c) => ({ label: c.name, value: c.visits }))} empty="Sem visitas no período" /></div>
          </Card>
        </>
      )}
    </div>
  )
}

function Heatmap({ data }: { data: ReportData['heatmap'] }) {
  const hours = useMemo(() => {
    const hs = data.map((d) => d.hour)
    if (!hs.length) return []
    return Array.from({ length: Math.max(...hs) - Math.min(...hs) + 1 }, (_, i) => Math.min(...hs) + i)
  }, [data])
  const max = Math.max(1, ...data.map((d) => d.count))
  if (!hours.length) return <p className="p-5 text-sm text-ink-500">Sem reservas no período.</p>
  return (
    <div className="overflow-x-auto p-5">
      <div className="inline-grid gap-1" style={{ gridTemplateColumns: `40px repeat(${hours.length}, minmax(30px, 1fr))` }}>
        <span />
        {hours.map((h) => <span key={h} className="text-center text-[10px] text-ink-500">{h}h</span>)}
        {ORDER.map((w) => (
          <Row key={w} label={WEEKDAYS_SHORT[w]}>
            {hours.map((h) => {
              const c = data.find((d) => d.weekday === w && d.hour === h)?.count ?? 0
              return (
                <span key={h} title={`${WEEKDAYS_SHORT[w]} ${h}h: ${c} reserva(s)`}
                  className={cn('grid h-8 place-items-center rounded-md text-[10px] tabular-nums', c ? 'text-ink-950' : 'bg-ink-850 text-ink-600')}
                  style={c ? { background: `rgba(198,244,50,${0.18 + 0.82 * (c / max)})` } : undefined}>{c || ''}</span>
              )
            })}
          </Row>
        ))}
      </div>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <><span className="self-center text-xs text-ink-400">{label}</span>{children}</>
}

function Ranking({ title, rows, empty = 'Sem dados' }: { title?: string; rows: { label: string; value: number; extra?: string }[]; empty?: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value))
  return (
    <div>
      {title && <p className="label">{title}</p>}
      {rows.length === 0 ? <p className="text-sm text-ink-500">{empty}</p> : (
        <ul className="space-y-2.5">
          {rows.map((r) => (
            <li key={r.label}>
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span className="truncate">{r.label}</span>
                <span className="shrink-0 tabular-nums text-ink-300"><b className="text-ink-50">{r.value}</b>{r.extra ? ` · ${r.extra}` : ''}</span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-ink-800"><div className="h-full rounded-full bg-lime" style={{ width: `${(r.value / max) * 100}%` }} /></div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Bar100({ value }: { value: number | null }) {
  if (value == null) return <span className="text-ink-500">—</span>
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-ink-800"><div className="h-full rounded-full bg-lime" style={{ width: `${Math.min(100, value)}%` }} /></div>
      <span className="text-xs tabular-nums">{value}%</span>
    </div>
  )
}

function exportCsv(r: ReportData, slug: string) {
  const lines: (string | number | null)[][] = [
    ['Período', r.period.from, r.period.to],
    [],
    ['Indicador', 'Valor'],
    ...Object.entries(r.summary).map(([k, v]) => [k, v]),
    [],
    ['Dia da semana', 'Hora', 'Reservas'],
    ...r.heatmap.map((h) => [WEEKDAYS_SHORT[h.weekday], h.hour, h.count]),
    [],
    ['Mesa', 'Ambiente', 'Reservas', 'Pessoas', 'Ocupação %'],
    ...r.tables.map((t) => [t.name, t.area, t.reservations, t.guests, t.occupancy]),
    [],
    ['Profissional', 'Atendimentos', 'Concluídos', 'Faltas', 'Receita (R$)'],
    ...r.staff.by_staff.map((s) => [s.name, s.appointments, s.completed, s.no_shows, s.revenue_cents / 100]),
  ]
  const csv = lines.map((l) => l.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(';')).join('\n')
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }))
  a.download = `relatorio-${slug}-${r.period.from}_${r.period.to}.csv`
  a.click()
}
