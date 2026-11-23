import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, CalendarPlus, CalendarClock, Loader2, MapPin, Phone, Users, XCircle } from 'lucide-react'
import { cancelPublicReservation, getPublicReservation, getRescheduleSlots, reschedulePublicReservation } from '@/api/public'
import { errorMessage } from '@/lib/errors'
import { fmt, fmtTime, keyLabel, shiftKey, todayKey } from '@/lib/datetime'
import { SEGMENT, STATUS } from '@/lib/constants'
import { cn, formatPhone, hexToRgbTriplet, readableOn } from '@/lib/utils'
import { Avatar, Spinner } from '@/components/ui/ui'
import { ConfirmDialog } from '@/components/ui/Sheet'
import { useToast } from '@/components/ui/Toast'
import { Logo } from '@/components/layout/Logo'
import { downloadIcs } from './ics'
import type { PublicReservation } from '@/types/db'

export default function ReservationLookup() {
  const { code: codeParam } = useParams()
  const navigate = useNavigate()
  const [code, setCode] = useState(codeParam ?? '')
  const [phone, setPhone] = useState(() => (codeParam ? sessionStorage.getItem(`innovai.res.${codeParam.toUpperCase()}`) ?? '' : ''))
  const [res, setRes] = useState<PublicReservation | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const lookup = async (c = code, p = phone) => {
    setLoading(true); setError(null)
    try {
      const r = await getPublicReservation(c.trim(), p)
      setRes(r)
      sessionStorage.setItem(`innovai.res.${r.code}`, p)
      if (!codeParam || codeParam.toUpperCase() !== r.code) navigate(`/reserva/${r.code}`, { replace: true })
    } catch (e) { setError(errorMessage(e)); setRes(null) }
    finally { setLoading(false) }
  }

  useEffect(() => { if (codeParam && phone) void lookup(codeParam, phone) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (res) document.documentElement.style.setProperty('--brand-rgb', hexToRgbTriplet(res.tenant.brand_color)) }, [res])

  const submit = (e: FormEvent) => { e.preventDefault(); void lookup() }

  return (
    <div className="min-h-screen bg-ink-950 grid-bg">
      <div className="mx-auto max-w-lg px-4 py-6">
        <div className="flex items-center justify-between">
          {res ? <Link to={`/${SEGMENT[res.tenant.segment].path}/${res.tenant.slug}`} className="flex items-center gap-1.5 text-sm text-ink-300 hover:text-ink-50"><ArrowLeft className="h-4 w-4" /> {res.tenant.name}</Link> : <Link to="/"><Logo /></Link>}
        </div>
        {!res ? (
          <div className="mt-16 animate-fade-up">
            <h1 className="text-3xl font-bold">Consultar reserva</h1>
            <p className="mt-2 text-sm text-ink-400">Use o código recebido na confirmação e o telefone informado.</p>
            <form onSubmit={submit} className="card mt-8 space-y-4 p-5">
              <label className="block">
                <span className="label">Código</span>
                <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={7} placeholder="EX: K7M2QXA" className="field font-mono text-lg tracking-[0.3em]" required />
              </label>
              <label className="block">
                <span className="label">Telefone</span>
                <input value={phone} onChange={(e) => setPhone(formatPhone(e.target.value))} inputMode="tel" placeholder="(11) 98888-7777" className="field" required />
              </label>
              {error && <p className="rounded-xl border border-rose-400/30 bg-rose-400/10 px-3 py-2.5 text-sm text-rose-200">{error}</p>}
              <button type="submit" disabled={loading} className="flex h-12 w-full items-center justify-center rounded-xl bg-lime font-bold text-ink-950 disabled:opacity-50">
                {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : 'Consultar'}
              </button>
            </form>
          </div>
        ) : (
          <ReservationCard res={res} phone={phone} onChange={setRes} />
        )}
      </div>
    </div>
  )
}

function ReservationCard({ res, phone, onChange }: { res: PublicReservation; phone: string; onChange: (r: PublicReservation) => void }) {
  const tz = res.tenant.timezone
  const brand = res.tenant.brand_color
  const onBrand = readableOn(brand)
  const toast = useToast()
  const [cancelOpen, setCancelOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [rescheduling, setRescheduling] = useState(false)
  const st = STATUS[res.status]

  const cancel = async () => {
    setBusy(true)
    try { onChange(await cancelPublicReservation(res.code, phone)); toast('success', 'Reserva cancelada'); setCancelOpen(false) }
    catch (e) { toast('error', 'Não foi possível cancelar', errorMessage(e)) }
    finally { setBusy(false) }
  }

  return (
    <div className="mt-6 space-y-4 animate-fade-up">
      <div className="card overflow-hidden">
        <div className="flex items-center gap-3 border-b border-ink-800 p-5">
          <Avatar name={res.tenant.name} src={res.tenant.logo_url} size={44} className="rounded-xl" />
          <div className="flex-1">
            <p className="font-semibold">{res.tenant.name}</p>
            <p className="font-mono text-xs text-ink-400">#{res.code}</p>
          </div>
          <span className={cn('chip', st.chip)}><span className={cn('h-1.5 w-1.5 rounded-full', st.dot)} />{st.label}</span>
        </div>
        <div className="p-5">
          <p className="text-sm first-letter:uppercase text-ink-300">{fmt(res.starts_at, tz, "EEEE, d 'de' MMMM 'de' yyyy")}</p>
          <p className={cn('mt-1 font-display text-4xl font-extrabold', res.status === 'cancelled' && 'line-through opacity-50')}>{fmtTime(res.starts_at, tz)}</p>
          <div className="mt-4 space-y-2 text-sm text-ink-300">
            <p className="flex items-center gap-2"><Users className="h-4 w-4 text-ink-500" /> {res.party_size} pessoa(s){res.service_name ? ` · ${res.service_name}` : ''}{res.staff_name ? ` · com ${res.staff_name}` : ''}</p>
            {res.tenant.address_line && <p className="flex items-center gap-2"><MapPin className="h-4 w-4 text-ink-500" /> {[res.tenant.address_line, res.tenant.address_number, res.tenant.city].filter(Boolean).join(', ')}</p>}
            {res.tenant.phone && <p className="flex items-center gap-2"><Phone className="h-4 w-4 text-ink-500" /> {res.tenant.phone}</p>}
          </div>
          {res.status === 'pending' && <p className="mt-4 rounded-xl border border-amber-400/30 bg-amber-400/10 px-3 py-2.5 text-xs text-amber-200">Aguardando confirmação do estabelecimento.</p>}
        </div>
        {(res.status === 'pending' || res.status === 'confirmed') && (
          <div className="grid gap-2 border-t border-ink-800 p-4 sm:grid-cols-3">
            <button onClick={() => downloadIcs({ title: `Reserva · ${res.tenant.name}`, start: res.starts_at, end: res.ends_at, description: `Código: ${res.code}` })}
              className="flex h-11 items-center justify-center gap-2 rounded-xl border border-ink-600 text-sm font-semibold hover:border-ink-400"><CalendarPlus className="h-4 w-4" /> Agenda</button>
            <button disabled={!res.can_reschedule} onClick={() => setRescheduling((v) => !v)}
              className="flex h-11 items-center justify-center gap-2 rounded-xl border border-ink-600 text-sm font-semibold hover:border-ink-400 disabled:opacity-40"><CalendarClock className="h-4 w-4" /> Remarcar</button>
            <button disabled={!res.can_cancel} onClick={() => setCancelOpen(true)}
              className="flex h-11 items-center justify-center gap-2 rounded-xl border border-rose-400/30 text-sm font-semibold text-rose-300 hover:bg-rose-400/10 disabled:opacity-40"><XCircle className="h-4 w-4" /> Cancelar</button>
          </div>
        )}
        {(res.status === 'pending' || res.status === 'confirmed') && !res.can_cancel && (
          <p className="px-5 pb-4 text-xs text-ink-500">Alterações online são permitidas até {Math.round(res.cancellation_min_notice_min / 60)}h antes. Fale com o estabelecimento.</p>
        )}
      </div>

      {rescheduling && <Reschedule res={res} phone={phone} brand={brand} onBrand={onBrand} onDone={(r) => { onChange(r); setRescheduling(false) }} />}
      {res.cancellation_policy && <p className="px-1 text-xs leading-relaxed text-ink-500">{res.cancellation_policy}</p>}

      <ConfirmDialog open={cancelOpen} danger title="Cancelar sua reserva?" confirmLabel="Sim, cancelar" loading={busy}
        description="O horário será liberado para outras pessoas." onClose={() => setCancelOpen(false)} onConfirm={cancel} />
    </div>
  )
}

function Reschedule({ res, phone, brand, onBrand, onDone }: { res: PublicReservation; phone: string; brand: string; onBrand: string; onDone: (r: PublicReservation) => void }) {
  const tz = res.tenant.timezone
  const toast = useToast()
  const today = todayKey(tz)
  const days = useMemo(() => Array.from({ length: 30 }, (_, i) => shiftKey(today, i)), [today])
  const [dateKey, setDateKey] = useState(today)
  const [slot, setSlot] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const { data: slots, isLoading } = useQuery({ queryKey: ['resched', res.code, dateKey], queryFn: () => getRescheduleSlots(res.code, phone, dateKey) })

  const save = async () => {
    if (!slot) return
    setBusy(true)
    try { onDone(await reschedulePublicReservation(res.code, phone, slot)); toast('success', 'Reserva remarcada') }
    catch (e) { toast('error', 'Não foi possível remarcar', errorMessage(e)) }
    finally { setBusy(false) }
  }

  return (
    <div className="card space-y-4 p-5 animate-fade-up">
      <p className="text-sm font-semibold">Escolha a nova data e horário</p>
      <div className="-mx-5 flex gap-2 overflow-x-auto px-5 pb-1">
        {days.map((d) => (
          <button key={d} onClick={() => { setDateKey(d); setSlot(null) }} className={cn('flex w-[58px] shrink-0 flex-col items-center rounded-2xl border py-2.5', d === dateKey ? 'border-transparent' : 'border-ink-700')}
            style={d === dateKey ? { background: brand, color: onBrand } : undefined}>
            <span className="text-[11px] uppercase">{keyLabel(d, 'EEE')}</span><span className="text-lg font-bold">{keyLabel(d, 'dd')}</span>
          </button>
        ))}
      </div>
      {isLoading ? <Spinner /> : !slots?.length ? <p className="text-sm text-ink-400">Sem horários neste dia.</p> : (
        <div className="grid grid-cols-4 gap-2">
          {slots.map((s) => (
            <button key={s.slot_start} onClick={() => setSlot(s.slot_start)} className={cn('h-10 rounded-xl border text-sm font-semibold', slot === s.slot_start ? 'border-transparent' : 'border-ink-700')}
              style={slot === s.slot_start ? { background: brand, color: onBrand } : undefined}>{fmtTime(s.slot_start, tz)}</button>
          ))}
        </div>
      )}
      <button disabled={!slot || busy} onClick={save} className="flex h-12 w-full items-center justify-center rounded-xl font-bold disabled:opacity-40" style={{ background: brand, color: onBrand }}>
        {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : 'Confirmar nova data'}
      </button>
    </div>
  )
}
