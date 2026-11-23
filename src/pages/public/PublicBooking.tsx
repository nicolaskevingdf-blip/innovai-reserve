import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  ArrowLeft, CalendarDays, CalendarPlus, Check, ChevronRight, Clock, Globe, Instagram, Loader2, MapPin, MessageCircle, Minus, Phone, Plus, Search, Users,
} from 'lucide-react'
import { createPublicReservation, getAvailableDays, getAvailableSlots, getPublicPage, joinWaitlist } from '@/api/public'
import { errorHint, errorMessage } from '@/lib/errors'
import { fmt, fmtTime, keyLabel, shiftKey, todayKey, WEEKDAYS } from '@/lib/datetime'
import { SEGMENT } from '@/lib/constants'
import { cn, formatMoney, formatPhone, hexToRgbTriplet, isValidEmail, isValidPhone, readableOn, whatsappLink } from '@/lib/utils'
import { Avatar, Spinner } from '@/components/ui/ui'
import { Logo } from '@/components/layout/Logo'
import NotFound from '../NotFound'
import { downloadIcs } from './ics'
import type { PublicPage } from '@/types/db'

type Step = 'service' | 'staff' | 'party' | 'area' | 'date' | 'time' | 'details' | 'done' | 'waitlist' | 'waitlisted'

export default function PublicBooking() {
  const { slug = '' } = useParams()
  const { data: page, isLoading, error } = useQuery({ queryKey: ['public', slug], queryFn: () => getPublicPage(slug), retry: false, staleTime: 60_000 })

  useEffect(() => {
    if (!page) return
    document.title = `${page.tenant.name} · Reservas`
    document.documentElement.style.setProperty('--brand-rgb', hexToRgbTriplet(page.tenant.brand_color))
  }, [page])

  if (isLoading) return <div className="grid min-h-screen place-items-center bg-ink-950"><Spinner className="h-7 w-7" /></div>
  if (error || !page) return <NotFound />
  return <PublicPageView page={page} />
}

function PublicPageView({ page }: { page: PublicPage }) {
  const t = page.tenant
  const brand = t.brand_color
  const onBrand = readableOn(brand)
  const bookingRef = useRef<HTMLDivElement>(null)
  const [widgetInView, setWidgetInView] = useState(false)
  useEffect(() => {
    const el = bookingRef.current
    if (!el) return
    const io = new IntersectionObserver(([e]) => setWidgetInView(e.isIntersecting), { threshold: 0.05 })
    io.observe(el)
    return () => io.disconnect()
  }, [])
  const address = [t.address_line && `${t.address_line}${t.address_number ? `, ${t.address_number}` : ''}`, t.neighborhood, t.city && `${t.city}${t.state ? ` - ${t.state}` : ''}`].filter(Boolean).join(' · ')
  const mapsUrl = address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${t.name} ${address}`)}` : null
  const hoursByDay = useMemo(() => [1, 2, 3, 4, 5, 6, 0].map((d) => ({ d, shifts: page.hours.filter((h) => h.weekday === d) })), [page.hours])
  const todayDow = Number(fmt(new Date(), t.timezone, 'i')) % 7

  return (
    <div className="min-h-screen overflow-x-hidden bg-ink-950 pb-24 lg:pb-0">
      {/* Cover */}
      <div className="relative h-56 overflow-hidden md:h-80">
        {t.cover_url ? <img src={t.cover_url} alt="" className="h-full w-full object-cover" /> : (
          <div className="h-full w-full" style={{ background: `radial-gradient(ellipse at 20% 0%, ${brand}55, transparent 60%), radial-gradient(ellipse at 100% 100%, ${brand}22, transparent 50%), #0B0B0D` }} />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-ink-950 via-ink-950/40 to-transparent" />
      </div>

      <div className="relative mx-auto -mt-20 max-w-6xl px-4 md:-mt-24 md:px-8">
        <div className="grid gap-8 lg:grid-cols-[1fr_440px]">
          {/* Info */}
          <div className="min-w-0 animate-fade-up">
            <div className="flex items-end gap-4">
              <Avatar name={t.name} src={t.logo_url} size={88} className="rounded-3xl border-4 border-ink-950 shadow-2xl" />
              <div className="pb-1">
                <p className="text-xs font-semibold uppercase tracking-[0.18em]" style={{ color: brand }}>{SEGMENT[t.segment].label}</p>
                <h1 className="mt-1 text-3xl font-extrabold md:text-4xl">{t.name}</h1>
              </div>
            </div>
            {t.description && <p className="mt-6 max-w-2xl whitespace-pre-line text-[15px] leading-relaxed text-ink-200">{t.description}</p>}

            <div className="mt-6 flex flex-wrap gap-2">
              {mapsUrl && <a href={mapsUrl} target="_blank" rel="noreferrer" className="chip border-ink-700 bg-ink-900 px-3 py-1.5 text-ink-200 hover:border-ink-500"><MapPin className="h-3.5 w-3.5" /> Como chegar</a>}
              {t.whatsapp && <a href={whatsappLink(t.whatsapp)} target="_blank" rel="noreferrer" className="chip border-ink-700 bg-ink-900 px-3 py-1.5 text-ink-200 hover:border-ink-500"><MessageCircle className="h-3.5 w-3.5" /> WhatsApp</a>}
              {t.phone && <a href={`tel:${t.phone.replace(/\D/g, '')}`} className="chip border-ink-700 bg-ink-900 px-3 py-1.5 text-ink-200 hover:border-ink-500"><Phone className="h-3.5 w-3.5" /> {t.phone}</a>}
              {t.instagram && <a href={`https://instagram.com/${t.instagram.replace(/^@/, '')}`} target="_blank" rel="noreferrer" className="chip border-ink-700 bg-ink-900 px-3 py-1.5 text-ink-200 hover:border-ink-500"><Instagram className="h-3.5 w-3.5" /> @{t.instagram.replace(/^@/, '')}</a>}
              {t.website && <a href={t.website} target="_blank" rel="noreferrer" className="chip border-ink-700 bg-ink-900 px-3 py-1.5 text-ink-200 hover:border-ink-500"><Globe className="h-3.5 w-3.5" /> Site</a>}
            </div>

            <div className="mt-8 grid gap-4 md:grid-cols-2">
              <div className="card p-5">
                <h2 className="flex items-center gap-2 text-sm font-semibold"><Clock className="h-4 w-4" style={{ color: brand }} /> Horário de funcionamento</h2>
                <ul className="mt-4 space-y-2 text-sm">
                  {hoursByDay.map(({ d, shifts }) => (
                    <li key={d} className={cn('flex justify-between gap-4', d === todayDow ? 'font-semibold text-ink-50' : 'text-ink-300')}>
                      <span>{WEEKDAYS[d]}</span>
                      <span className="text-right tabular-nums">{shifts.length ? shifts.map((s) => `${s.opens_at}–${s.closes_at}`).join(' · ') : <span className="text-ink-500">Fechado</span>}</span>
                    </li>
                  ))}
                </ul>
              </div>
              {address && (
                <div className="card p-5">
                  <h2 className="flex items-center gap-2 text-sm font-semibold"><MapPin className="h-4 w-4" style={{ color: brand }} /> Endereço</h2>
                  <p className="mt-4 text-sm leading-relaxed text-ink-300">{address}{t.address_complement ? ` · ${t.address_complement}` : ''}</p>
                  {mapsUrl && <a href={mapsUrl} target="_blank" rel="noreferrer" className="mt-4 inline-flex items-center gap-1 text-sm font-semibold" style={{ color: brand }}>Abrir no mapa <ChevronRight className="h-4 w-4" /></a>}
                </div>
              )}
            </div>

            {page.services.length > 0 && (
              <div className="mt-8">
                <h2 className="text-lg font-bold">Serviços</h2>
                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  {page.services.map((s) => (
                    <div key={s.id} className="card flex items-start justify-between gap-4 p-4">
                      <div><p className="font-semibold">{s.name}</p>{s.description && <p className="mt-1 text-sm text-ink-400">{s.description}</p>}<p className="mt-1 text-xs text-ink-500">{s.duration_min} min</p></div>
                      {s.price_cents != null && <p className="font-semibold">{formatMoney(s.price_cents)}</p>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="mt-10 hidden items-center justify-between border-t border-ink-800 py-6 text-xs text-ink-500 lg:flex">
              <Link to="/reserva" className="flex items-center gap-1.5 hover:text-ink-200"><Search className="h-3.5 w-3.5" /> Consultar ou cancelar uma reserva</Link>
              <span className="flex items-center gap-2">Reservas por <Logo compact className="scale-75" /></span>
            </div>
          </div>

          {/* Booking */}
          <div ref={bookingRef} className="min-w-0 scroll-mt-4 lg:sticky lg:top-6 lg:self-start">
            <BookingWidget page={page} />
            <div className="mt-6 flex items-center justify-between text-xs text-ink-500 lg:hidden">
              <Link to="/reserva" className="flex items-center gap-1.5"><Search className="h-3.5 w-3.5" /> Consultar reserva</Link>
              <span>Innovai Reserve</span>
            </div>
          </div>
        </div>
      </div>

      {/* Mobile sticky CTA */}
      <div className={cn('pb-safe fixed inset-x-0 bottom-0 z-30 border-t border-ink-800 bg-ink-950/90 px-4 pt-3 backdrop-blur-xl transition-transform duration-300 lg:hidden',
        widgetInView && 'pointer-events-none translate-y-full')}>
        <button onClick={() => bookingRef.current?.scrollIntoView({ behavior: 'smooth' })} className="h-12 w-full rounded-2xl text-[15px] font-bold" style={{ background: brand, color: onBrand }}>
          {t.segment === 'restaurant' ? 'Reservar mesa' : 'Agendar horário'}
        </button>
      </div>
    </div>
  )
}

/* =================================================================== */

function BookingWidget({ page }: { page: PublicPage }) {
  const t = page.tenant
  const s = page.settings
  const tz = t.timezone
  const brand = t.brand_color
  const onBrand = readableOn(brand)
  const hasServices = page.services.length > 0
  const askParty = s.max_party_size > 1
  const hasAreas = (page.areas ?? []).length > 0
  const staffMode = page.settings.allocation_mode === 'staff' && (page.staff ?? []).length > 0
  const firstStep: Step = hasServices ? 'service' : askParty ? 'party' : hasAreas ? 'area' : 'date'

  const [step, setStep] = useState<Step>(firstStep)
  const [serviceId, setServiceId] = useState<string | null>(null)
  const [areaId, setAreaId] = useState<string | null>(null)
  const [staffId, setStaffId] = useState<string | null>(null)
  const [wlTime, setWlTime] = useState('')
  const [wlPosition, setWlPosition] = useState<number | null>(null)
  const [party, setParty] = useState(Math.min(Math.max(2, s.min_party_size), s.max_party_size))
  const [dateKey, setDateKey] = useState<string | null>(null)
  const [slot, setSlot] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [notes, setNotes] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<Awaited<ReturnType<typeof createPublicReservation>> | null>(null)

  const today = todayKey(tz)
  const horizon = Math.min(s.max_advance_days, 60)
  const days = useMemo(() => Array.from({ length: horizon + 1 }, (_, i) => shiftKey(today, i)), [today, horizon])

  const availableDays = useQuery({
    queryKey: ['public-days', t.slug, party, serviceId, areaId, staffId, today, horizon],
    enabled: step === 'date' || step === 'time',
    queryFn: () => getAvailableDays(t.slug, today, shiftKey(today, horizon), party, serviceId, areaId, staffId),
  })
  const slots = useQuery({
    queryKey: ['public-slots', t.slug, dateKey, party, serviceId, areaId, staffId],
    enabled: !!dateKey,
    queryFn: () => getAvailableSlots(t.slug, dateKey!, party, serviceId, areaId, staffId),
  })

  useEffect(() => {
    if (step === 'date' && !dateKey && availableDays.data?.size) {
      const first = days.find((d) => availableDays.data!.has(d))
      if (first) setDateKey(first)
    }
  }, [step, dateKey, availableDays.data, days])

  const groups = useMemo(() => {
    const g: Record<string, string[]> = { Manhã: [], Tarde: [], Noite: [] }
    for (const sl of slots.data ?? []) {
      const h = Number(fmt(sl.slot_start, tz, 'H'))
      g[h < 12 ? 'Manhã' : h < 18 ? 'Tarde' : 'Noite'].push(sl.slot_start)
    }
    return Object.entries(g).filter(([, v]) => v.length)
  }, [slots.data, tz])

  const service = page.services.find((x) => x.id === serviceId)

  const confirm = async () => {
    setError(null)
    if (name.trim().length < 2) return setError('Informe seu nome.')
    if (!isValidPhone(phone)) return setError('Informe um telefone válido com DDD.')
    if (email && !isValidEmail(email)) return setError('E-mail inválido.')
    setSubmitting(true)
    try {
      const r = await createPublicReservation({ slug: t.slug, startsAt: slot!, party, name: name.trim(), phone, email, notes, serviceId, areaId, staffId })
      sessionStorage.setItem(`innovai.res.${r.code}`, phone)
      setResult(r)
      setStep('done')
    } catch (e) {
      const hint = errorHint(e)
      setError(errorMessage(e))
      if (hint === 'SLOT_UNAVAILABLE') { setSlot(null); void slots.refetch(); void availableDays.refetch(); setStep('time') }
    } finally { setSubmitting(false) }
  }

  const joinList = async () => {
    setError(null)
    if (name.trim().length < 2) return setError('Informe seu nome.')
    if (!isValidPhone(phone)) return setError('Informe um telefone válido com DDD.')
    setSubmitting(true)
    try {
      const r = await joinWaitlist({ slug: t.slug, dateKey: dateKey ?? today, time: wlTime || null, party, name: name.trim(), phone, email, notes, areaId })
      setWlPosition(r.position)
      setStep('waitlisted')
    } catch (e) { setError(errorMessage(e)) } finally { setSubmitting(false) }
  }
  const area = page.areas?.find((a) => a.id === areaId)

  if (!s.booking_enabled) {
    return (
      <div className="card p-6 text-center">
        <CalendarDays className="mx-auto h-8 w-8 text-ink-500" />
        <h2 className="mt-3 font-semibold">Reservas online pausadas</h2>
        <p className="mt-1 text-sm text-ink-400">Entre em contato diretamente com o estabelecimento.</p>
        {t.whatsapp && <a href={whatsappLink(t.whatsapp)} className="mt-4 inline-flex h-11 items-center gap-2 rounded-xl px-5 text-sm font-semibold" style={{ background: brand, color: onBrand }}><MessageCircle className="h-4 w-4" /> WhatsApp</a>}
      </div>
    )
  }

  if (step === 'waitlisted') {
    return (
      <div className="card p-6 text-center animate-fade-up">
        <div className="mx-auto grid h-16 w-16 place-items-center rounded-full" style={{ background: brand, color: onBrand }}><Check className="h-8 w-8" strokeWidth={3} /></div>
        <h2 className="mt-4 text-2xl font-bold">Você está na lista!</h2>
        <p className="mt-2 text-sm text-ink-300">
          Posição <b className="text-ink-50">{wlPosition}</b> para <span className="first-letter:uppercase">{keyLabel(dateKey ?? today, "EEEE, d 'de' MMMM")}</span>{wlTime ? ` por volta de ${wlTime}` : ''}.
        </p>
        <p className="mt-1 text-sm text-ink-400">Se abrir uma vaga, {t.name} entra em contato pelo telefone informado.</p>
        <button onClick={() => { setStep(firstStep); setWlPosition(null) }} className="mt-6 text-sm font-semibold" style={{ color: brand }}>Voltar</button>
      </div>
    )
  }

  if (step === 'done' && result) {
    const pending = result.status === 'pending'
    return (
      <div className="card overflow-hidden animate-fade-up">
        <div className="p-6 text-center" style={{ background: `linear-gradient(180deg, ${brand}22, transparent)` }}>
          <div className="mx-auto grid h-16 w-16 place-items-center rounded-full" style={{ background: brand, color: onBrand }}><Check className="h-8 w-8" strokeWidth={3} /></div>
          <h2 className="mt-4 text-2xl font-bold">{pending ? 'Pedido recebido!' : 'Reserva confirmada!'}</h2>
          <p className="mt-1 text-sm text-ink-300">{pending ? 'O estabelecimento vai confirmar seu horário em breve.' : `Te esperamos, ${name.split(' ')[0]}!`}</p>
        </div>
        <div className="space-y-3 px-6 pb-6">
          <div className="rounded-2xl border border-ink-700 bg-ink-850 p-4">
            <p className="text-sm first-letter:uppercase text-ink-300">{fmt(result.starts_at, tz, "EEEE, d 'de' MMMM")}</p>
            <p className="mt-1 font-display text-3xl font-extrabold">{fmtTime(result.starts_at, tz)}</p>
            <p className="mt-1 text-sm text-ink-400">{service ? `${service.name} · ` : ''}{result.party_size} pessoa{result.party_size > 1 ? 's' : ''}{result.area_name ? ` · ${result.area_name}` : ''}{result.staff_name ? ` · com ${result.staff_name}` : ''}</p>
            <div className="mt-4 flex items-center justify-between border-t border-ink-700 pt-3">
              <span className="text-xs text-ink-400">Código da reserva</span>
              <span className="font-mono text-lg font-bold tracking-widest" style={{ color: brand }}>{result.code}</span>
            </div>
          </div>
          <button onClick={() => downloadIcs({ title: `${service?.name ?? 'Reserva'} · ${t.name}`, start: result.starts_at, end: result.ends_at, location: [t.address_line, t.address_number, t.city].filter(Boolean).join(', '), description: `Código: ${result.code}` })}
            className="flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-ink-600 text-sm font-semibold hover:border-ink-400">
            <CalendarPlus className="h-4 w-4" /> Adicionar à agenda
          </button>
          <Link to={`/reserva/${result.code}`} className="flex h-11 w-full items-center justify-center rounded-xl text-sm font-semibold" style={{ background: brand, color: onBrand }}>
            Ver, remarcar ou cancelar
          </Link>
          {s.cancellation_policy && <p className="pt-1 text-xs leading-relaxed text-ink-500">{s.cancellation_policy}</p>}
        </div>
      </div>
    )
  }

  const pre: Step[] = [...(hasServices ? ['service' as Step] : []), ...(staffMode ? ['staff' as Step] : [])]
  const steps: Step[] = step === 'waitlist'
    ? [...pre, ...(askParty ? ['party' as Step] : []), ...(hasAreas ? ['area' as Step] : []), 'date', 'waitlist']
    : [...pre, ...(askParty ? ['party' as Step] : []), ...(hasAreas ? ['area' as Step] : []), 'date', 'time', 'details']
  const idx = steps.indexOf(step)
  const back = () => idx > 0 && setStep(steps[idx - 1])

  const Summary = () => (
    <div className="flex flex-wrap gap-1.5">
      {service && <Pill>{service.name}</Pill>}
      {staffMode && idx > steps.indexOf('staff') && <Pill>{page.staff.find((x) => x.id === staffId)?.name ?? 'Qualquer profissional'}</Pill>}
      {askParty && idx > steps.indexOf('party') && <Pill><Users className="h-3 w-3" /> {party}</Pill>}
      {hasAreas && idx > steps.indexOf('area') && <Pill>{area?.name ?? 'Qualquer ambiente'}</Pill>}
      {dateKey && idx > steps.indexOf('date') && <Pill><CalendarDays className="h-3 w-3" /> {keyLabel(dateKey, 'EEE, dd/MM')}</Pill>}
      {slot && idx > steps.indexOf('time') && <Pill><Clock className="h-3 w-3" /> {fmtTime(slot, tz)}</Pill>}
    </div>
  )

  return (
    <div className="card overflow-hidden">
      <div className="border-b border-ink-800 p-5">
        <div className="flex items-center gap-3">
          {idx > 0 && <button onClick={back} className="-ml-1 rounded-lg p-1.5 text-ink-300 hover:bg-ink-800" aria-label="Voltar"><ArrowLeft className="h-4 w-4" /></button>}
          <div className="flex-1">
            <h2 className="text-lg font-bold">{step === 'waitlist' ? 'Lista de espera' : t.segment === 'restaurant' ? 'Reserve sua mesa' : 'Agende seu horário'}</h2>
            <p className="text-xs text-ink-400">Passo {idx + 1} de {steps.length} · sem precisar criar conta</p>
          </div>
        </div>
        <div className="mt-4 flex gap-1">{steps.map((st, i) => <div key={st} className="h-1 flex-1 rounded-full transition-all" style={{ background: i <= idx ? brand : '#2C2C33' }} />)}</div>
        {idx > 0 && <div className="mt-3"><Summary /></div>}
      </div>

      <div className="p-5" key={step}>
        <div className="animate-fade-up">
          {step === 'service' && (
            <div className="space-y-2">
              <p className="mb-3 text-sm font-semibold">Escolha o serviço</p>
              {page.services.map((sv) => (
                <button key={sv.id} onClick={() => { setServiceId(sv.id); setStaffId(null); setDateKey(null); setSlot(null); setStep(staffMode ? 'staff' : askParty ? 'party' : hasAreas ? 'area' : 'date') }}
                  className={cn('flex w-full items-center justify-between gap-3 rounded-2xl border p-4 text-left transition hover:border-ink-500', serviceId === sv.id ? 'border-[color:var(--b)]' : 'border-ink-700')}
                  style={{ ['--b' as string]: brand }}>
                  <div><p className="font-semibold">{sv.name}</p><p className="text-xs text-ink-400">{sv.duration_min} min</p></div>
                  {sv.price_cents != null && <span className="text-sm font-semibold">{formatMoney(sv.price_cents)}</span>}
                </button>
              ))}
            </div>
          )}

          {step === 'party' && (
            <div>
              <p className="text-sm font-semibold">Quantas pessoas?</p>
              <div className="mt-5 flex items-center justify-center gap-6">
                <button onClick={() => setParty((p) => Math.max(s.min_party_size, p - 1))} className="grid h-14 w-14 place-items-center rounded-2xl border border-ink-600 hover:border-ink-400 disabled:opacity-30" disabled={party <= s.min_party_size}><Minus className="h-5 w-5" /></button>
                <div className="w-20 text-center"><p className="font-display text-5xl font-extrabold tabular-nums">{party}</p><p className="text-xs text-ink-400">pessoa{party > 1 ? 's' : ''}</p></div>
                <button onClick={() => setParty((p) => Math.min(s.max_party_size, p + 1))} className="grid h-14 w-14 place-items-center rounded-2xl border border-ink-600 hover:border-ink-400 disabled:opacity-30" disabled={party >= s.max_party_size}><Plus className="h-5 w-5" /></button>
              </div>
              <div className="mt-5 grid grid-cols-6 gap-1.5">
                {Array.from({ length: Math.min(s.max_party_size - s.min_party_size + 1, 12) }, (_, i) => s.min_party_size + i).map((n) => (
                  <button key={n} onClick={() => setParty(n)} className={cn('h-10 rounded-xl border text-sm font-semibold', party === n ? 'border-transparent' : 'border-ink-700 text-ink-300')}
                    style={party === n ? { background: brand, color: onBrand } : undefined}>{n}</button>
                ))}
              </div>
              <p className="mt-4 text-center text-xs text-ink-500">Para grupos acima de {s.max_party_size} pessoas, fale com o estabelecimento.</p>
              <CTA brand={brand} onBrand={onBrand} onClick={() => { setDateKey(null); setSlot(null); setStep(hasAreas ? 'area' : 'date') }}>Continuar</CTA>
            </div>
          )}

          {step === 'staff' && (() => {
            const linked = page.staff.filter((p) => p.service_ids.includes(serviceId ?? ''))
            const options = serviceId && linked.length ? linked : page.staff
            return (
              <div className="space-y-2">
                <p className="mb-3 text-sm font-semibold">Com quem você quer ser atendido?</p>
                {[{ id: null as string | null, name: 'Qualquer profissional', specialty: 'Mais horários disponíveis', photo_url: null as string | null }, ...options].map((p) => (
                  <button key={p.id ?? 'any'} onClick={() => { setStaffId(p.id); setDateKey(null); setSlot(null); setStep(askParty ? 'party' : hasAreas ? 'area' : 'date') }}
                    className={cn('flex w-full items-center gap-3 rounded-2xl border p-3 text-left transition hover:border-ink-500', staffId === p.id ? 'border-ink-400' : 'border-ink-700')}>
                    {p.id ? <Avatar name={p.name} src={p.photo_url} size={44} /> : <div className="grid h-11 w-11 place-items-center rounded-full border border-dashed border-ink-500"><Users className="h-5 w-5 text-ink-400" /></div>}
                    <div className="min-w-0 flex-1"><p className="font-semibold">{p.name}</p>{p.specialty && <p className="truncate text-xs text-ink-400">{p.specialty}</p>}</div>
                    <ChevronRight className="h-4 w-4 text-ink-500" />
                  </button>
                ))}
              </div>
            )
          })()}

          {step === 'area' && (
            <div className="space-y-2">
              <p className="mb-3 text-sm font-semibold">Ambiente preferido</p>
              {[{ id: null as string | null, name: 'Sem preferência', description: 'Mais horários disponíveis' }, ...page.areas.map((a) => ({ ...a, id: a.id as string | null }))].map((a) => (
                <button key={a.id ?? 'any'} onClick={() => { setAreaId(a.id); setDateKey(null); setSlot(null); setStep('date') }}
                  className={cn('flex w-full items-center justify-between gap-3 rounded-2xl border p-4 text-left transition hover:border-ink-500', areaId === a.id ? 'border-ink-400' : 'border-ink-700')}>
                  <div><p className="font-semibold">{a.name}</p>{a.description && <p className="text-xs text-ink-400">{a.description}</p>}</div>
                  <ChevronRight className="h-4 w-4 text-ink-500" />
                </button>
              ))}
            </div>
          )}

          {step === 'waitlist' && (
            <div className="space-y-3">
              <p className="text-sm text-ink-300">Sem mesa disponível? Entre na lista de espera para <b className="text-ink-50 first-letter:uppercase">{keyLabel(dateKey ?? today, "EEE, d 'de' MMM")}</b>. Avisamos se abrir uma vaga.</p>
              <label className="block">
                <span className="mb-1.5 block text-xs text-ink-400">Data</span>
                <input type="date" value={dateKey ?? today} min={today} max={shiftKey(today, horizon)} onChange={(e) => setDateKey(e.target.value || today)}
                  className="h-12 w-full rounded-xl border border-ink-600 bg-ink-850 px-3.5 text-[15px] outline-none focus:border-ink-400" />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-xs text-ink-400">Horário desejado (opcional)</span>
                <input type="time" value={wlTime} onChange={(e) => setWlTime(e.target.value)} className="h-12 w-full rounded-xl border border-ink-600 bg-ink-850 px-3.5 text-[15px] outline-none focus:border-ink-400" />
              </label>
              <PublicInput label="Nome completo" value={name} onChange={setName} autoComplete="name" />
              <PublicInput label="Celular (WhatsApp)" value={phone} onChange={(v) => setPhone(formatPhone(v))} inputMode="tel" autoComplete="tel" placeholder="(11) 98888-7777" />
              {error && <p className="rounded-xl border border-rose-400/30 bg-rose-400/10 px-3 py-2.5 text-sm text-rose-200">{error}</p>}
              <CTA brand={brand} onBrand={onBrand} onClick={joinList} disabled={submitting}>{submitting ? <Loader2 className="h-5 w-5 animate-spin" /> : 'Entrar na lista de espera'}</CTA>
            </div>
          )}

          {step === 'date' && (
            <div>
              <p className="mb-3 text-sm font-semibold">Escolha a data</p>
              {availableDays.isLoading ? <div className="grid h-24 place-items-center"><Spinner /></div> : (
                <>
                  <div className="-mx-5 flex snap-x gap-2 overflow-x-auto px-5 pb-2">
                    {days.map((d) => {
                      const ok = availableDays.data?.has(d)
                      const sel = d === dateKey
                      return (
                        <button key={d} disabled={!ok} onClick={() => { setDateKey(d); setSlot(null) }}
                          className={cn('flex w-[62px] shrink-0 snap-start flex-col items-center rounded-2xl border py-3 transition', sel ? 'border-transparent' : 'border-ink-700', !ok && 'opacity-30')}
                          style={sel ? { background: brand, color: onBrand } : undefined}>
                          <span className="text-[11px] font-medium uppercase">{d === today ? 'Hoje' : keyLabel(d, 'EEE')}</span>
                          <span className="mt-0.5 text-xl font-bold">{keyLabel(d, 'dd')}</span>
                          <span className="text-[10px] opacity-70">{keyLabel(d, 'MMM')}</span>
                        </button>
                      )
                    })}
                  </div>
                  {availableDays.data?.size === 0 && <p className="mt-3 rounded-xl border border-dashed border-ink-700 p-4 text-center text-sm text-ink-400">Sem horários disponíveis nos próximos dias para {party} pessoa(s).</p>}
                  <button onClick={() => { setError(null); setStep('waitlist') }} className="mt-3 w-full text-center text-xs font-semibold text-ink-300 hover:text-ink-50">
                    Não achou a data? <span style={{ color: brand }}>Entrar na lista de espera</span>
                  </button>
                </>
              )}
              <CTA brand={brand} onBrand={onBrand} disabled={!dateKey} onClick={() => setStep('time')}>Ver horários</CTA>
            </div>
          )}

          {step === 'time' && dateKey && (
            <div>
              <p className="mb-1 text-sm font-semibold first-letter:uppercase">{keyLabel(dateKey, "EEEE, d 'de' MMMM")}</p>
              <p className="mb-4 text-xs text-ink-400">Somente horários realmente disponíveis</p>
              {error && <p className="mb-3 rounded-xl border border-amber-400/30 bg-amber-400/10 px-3 py-2.5 text-sm text-amber-200">{error}</p>}
              {slots.isLoading ? <div className="grid h-24 place-items-center"><Spinner /></div> : groups.length === 0 ? (
                <div className="rounded-xl border border-dashed border-ink-700 p-4 text-center text-sm text-ink-400">
                  Este dia está lotado.
                  <button onClick={() => { setError(null); setStep('waitlist') }} className="mt-2 block w-full font-semibold" style={{ color: brand }}>Entrar na lista de espera</button>
                </div>
              ) : (
                <div className="space-y-4">
                  {groups.map(([label, list]) => (
                    <div key={label}>
                      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-500">{label}</p>
                      <div className="grid grid-cols-4 gap-2">
                        {list.map((iso) => (
                          <button key={iso} onClick={() => { setSlot(iso); setError(null) }}
                            className={cn('h-11 rounded-xl border text-sm font-semibold tabular-nums transition', slot === iso ? 'border-transparent' : 'border-ink-700 hover:border-ink-500')}
                            style={slot === iso ? { background: brand, color: onBrand } : undefined}>{fmtTime(iso, tz)}</button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <CTA brand={brand} onBrand={onBrand} disabled={!slot} onClick={() => { setError(null); setStep('details') }}>Continuar</CTA>
              {page.settings.allocation_mode === 'tables' && groups.length > 0 && (
                <button onClick={() => { setError(null); setStep('waitlist') }} className="mt-3 w-full text-center text-xs text-ink-400 hover:text-ink-100">
                  Horário desejado lotado? <span className="font-semibold" style={{ color: brand }}>Lista de espera</span>
                </button>
              )}
            </div>
          )}

          {step === 'details' && (
            <div className="space-y-3">
              <p className="text-sm font-semibold">Seus dados</p>
              <PublicInput label="Nome completo" value={name} onChange={setName} autoComplete="name" />
              <PublicInput label="Celular (WhatsApp)" value={phone} onChange={(v) => setPhone(formatPhone(v))} inputMode="tel" autoComplete="tel" placeholder="(11) 98888-7777" />
              <PublicInput label="E-mail (opcional)" value={email} onChange={setEmail} type="email" autoComplete="email" />
              <label className="block">
                <span className="mb-1.5 block text-xs text-ink-400">Observações (opcional)</span>
                <textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} rows={2} placeholder={t.segment === 'restaurant' ? 'Aniversário, cadeirinha, restrições…' : 'Alguma preferência?'}
                  className="w-full rounded-xl border border-ink-600 bg-ink-850 px-3.5 py-3 text-sm outline-none focus:border-ink-400" />
              </label>
              {s.booking_message && <p className="rounded-xl bg-ink-850 p-3 text-xs leading-relaxed text-ink-300">{s.booking_message}</p>}
              {error && <p className="rounded-xl border border-rose-400/30 bg-rose-400/10 px-3 py-2.5 text-sm text-rose-200">{error}</p>}
              <CTA brand={brand} onBrand={onBrand} onClick={confirm} disabled={submitting}>
                {submitting ? <Loader2 className="h-5 w-5 animate-spin" /> : `Confirmar · ${slot ? `${keyLabel(dateKey!, 'dd/MM')} às ${fmtTime(slot, tz)}` : ''}`}
              </CTA>
              <p className="text-center text-[11px] leading-relaxed text-ink-500">Ao confirmar, você concorda em ser contatado sobre esta reserva. Seus dados são usados apenas por {t.name}.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function Pill({ children }: { children: React.ReactNode }) {
  return <span className="inline-flex items-center gap-1 rounded-full border border-ink-700 bg-ink-850 px-2.5 py-1 text-xs font-medium capitalize text-ink-200">{children}</span>
}

function CTA({ children, onClick, disabled, brand, onBrand }: { children: React.ReactNode; onClick: () => void; disabled?: boolean; brand: string; onBrand: string }) {
  return (
    <button onClick={onClick} disabled={disabled} className="mt-6 flex h-12 w-full items-center justify-center rounded-2xl text-[15px] font-bold transition active:scale-[0.98] disabled:opacity-40"
      style={{ background: brand, color: onBrand }}>{children}</button>
  )
}

function PublicInput({ label, value, onChange, ...rest }: { label: string; value: string; onChange: (v: string) => void } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'>) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs text-ink-400">{label}</span>
      <input value={value} onChange={(e) => onChange(e.target.value)} className="h-12 w-full rounded-xl border border-ink-600 bg-ink-850 px-3.5 text-[15px] outline-none focus:border-ink-400" {...rest} />
    </label>
  )
}
