import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Check, Loader2, Scissors, Sparkles, Store, UtensilsCrossed, X, HeartPulse } from 'lucide-react'
import { createTenant, isSlugAvailable } from '@/api/tenant'
import { useTenant } from '@/hooks/useTenant'
import { useAuth } from '@/hooks/useAuth'
import { Logo } from '@/components/layout/Logo'
import { Button, Field, Input, Select } from '@/components/ui/ui'
import { SEGMENT } from '@/lib/constants'
import { PUBLIC_BASE_URL } from '@/lib/supabase'
import { TIMEZONES } from '@/lib/datetime'
import { errorMessage } from '@/lib/errors'
import { cn, formatPhone, slugify } from '@/lib/utils'
import type { Segment } from '@/types/db'

const OPTIONS: { value: Segment; icon: typeof Store; desc: string }[] = [
  { value: 'restaurant', icon: UtensilsCrossed, desc: 'Reservas por horário e número de pessoas, turnos de almoço e jantar.' },
  { value: 'barbershop', icon: Scissors, desc: 'Agendamentos por horário, duração e cadeiras.' },
  { value: 'salon', icon: Sparkles, desc: 'Serviços de beleza com horários marcados.' },
  { value: 'clinic', icon: HeartPulse, desc: 'Estética, bem-estar e atendimentos agendados.' },
  { value: 'other', icon: Store, desc: 'Qualquer negócio que trabalha com horários.' },
]

export default function Onboarding() {
  const navigate = useNavigate()
  const { user, signOut } = useAuth()
  const { memberships, refresh, switchTenant } = useTenant()
  const [step, setStep] = useState(1)
  const [segment, setSegment] = useState<Segment>('restaurant')
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugTouched, setSlugTouched] = useState(false)
  const [phone, setPhone] = useState('')
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Sao_Paulo')
  const [slugState, setSlugState] = useState<'idle' | 'checking' | 'ok' | 'taken'>('idle')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { if (!slugTouched) setSlug(slugify(name)) }, [name, slugTouched])
  useEffect(() => {
    if (slug.length < 3) { setSlugState('idle'); return }
    setSlugState('checking')
    const t = setTimeout(async () => {
      try { setSlugState((await isSlugAvailable(slug)) ? 'ok' : 'taken') } catch { setSlugState('idle') }
    }, 350)
    return () => clearTimeout(t)
  }, [slug])

  const submit = async () => {
    setError(null)
    if (name.trim().length < 2) return setError('Informe o nome do estabelecimento.')
    if (slugState !== 'ok') return setError('Escolha um link disponível.')
    setLoading(true)
    try {
      const t = await createTenant({ name: name.trim(), slug, segment, timezone: TIMEZONES.includes(timezone) ? timezone : 'America/Sao_Paulo', phone })
      await refresh()
      switchTenant(t.id)
      navigate('/app/dashboard', { replace: true })
    } catch (e) {
      setError(errorMessage(e))
    } finally { setLoading(false) }
  }

  return (
    <div className="min-h-screen bg-ink-950 grid-bg">
      <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-6">
        <Logo />
        <div className="flex items-center gap-3 text-xs text-ink-400">
          {memberships.length > 0 && <button onClick={() => navigate('/app')} className="hover:text-ink-100">Voltar ao painel</button>}
          <button onClick={() => void signOut()} className="hover:text-ink-100">Sair ({user?.email})</button>
        </div>
      </div>
      <div className="mx-auto max-w-3xl px-6 pb-16 pt-6">
        <div className="mb-8 flex items-center gap-2">
          {[1, 2].map((s) => <div key={s} className={cn('h-1 flex-1 rounded-full', s <= step ? 'bg-lime' : 'bg-ink-700')} />)}
        </div>

        {step === 1 && (
          <div className="animate-fade-up">
            <h1 className="text-3xl font-bold">Qual é o seu tipo de negócio?</h1>
            <p className="mt-2 text-ink-400">Configuramos horários, duração e indicadores ideais para o seu segmento. Tudo pode ser ajustado depois.</p>
            <div className="mt-8 grid gap-3 sm:grid-cols-2">
              {OPTIONS.map((o) => (
                <button key={o.value} onClick={() => setSegment(o.value)}
                  className={cn('flex items-start gap-4 rounded-2xl border p-5 text-left transition',
                    segment === o.value ? 'border-lime bg-lime/[0.06] shadow-glow' : 'border-ink-700 bg-ink-900 hover:border-ink-500')}>
                  <div className={cn('grid h-11 w-11 shrink-0 place-items-center rounded-xl', segment === o.value ? 'bg-lime text-ink-950' : 'bg-ink-800 text-ink-300')}>
                    <o.icon className="h-5 w-5" />
                  </div>
                  <div>
                    <p className="font-semibold">{SEGMENT[o.value].label}</p>
                    <p className="mt-1 text-sm text-ink-400">{o.desc}</p>
                  </div>
                </button>
              ))}
            </div>
            <Button size="lg" className="mt-8 w-full sm:w-auto" onClick={() => setStep(2)}>Continuar</Button>
          </div>
        )}

        {step === 2 && (
          <div className="animate-fade-up">
            <button onClick={() => setStep(1)} className="mb-4 flex items-center gap-1.5 text-sm text-ink-400 hover:text-ink-100"><ArrowLeft className="h-4 w-4" /> Voltar</button>
            <h1 className="text-3xl font-bold">Sobre o estabelecimento</h1>
            <p className="mt-2 text-ink-400">Esses dados aparecem na sua página pública de reservas.</p>
            <div className="mt-8 space-y-5">
              <Field label="Nome comercial"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder={segment === 'restaurant' ? 'Ex.: Cantina Bella Vista' : 'Ex.: Barbearia Navalha'} autoFocus /></Field>
              <Field label="Seu link de reservas">
                <div className="flex h-11 items-center overflow-hidden rounded-xl border border-ink-600 bg-ink-850 focus-within:border-lime/60 focus-within:ring-4 focus-within:ring-lime/10">
                  <span className="hidden shrink-0 pl-3.5 text-sm text-ink-500 sm:block">{PUBLIC_BASE_URL.replace(/^https?:\/\//, '')}/{SEGMENT[segment].path}/</span>
                  <input value={slug} onChange={(e) => { setSlugTouched(true); setSlug(slugify(e.target.value)) }}
                    className="h-full min-w-0 flex-1 bg-transparent px-3.5 text-sm outline-none sm:pl-0.5" placeholder="seu-negocio" />
                  <span className="pr-3.5">
                    {slugState === 'checking' && <Loader2 className="h-4 w-4 animate-spin text-ink-400" />}
                    {slugState === 'ok' && <Check className="h-4 w-4 text-lime" />}
                    {slugState === 'taken' && <X className="h-4 w-4 text-rose-400" />}
                  </span>
                </div>
                {slugState === 'taken' && <p className="mt-1.5 text-xs text-rose-300">Este link já está em uso. Tente outra variação.</p>}
              </Field>
              <div className="grid gap-5 sm:grid-cols-2">
                <Field label="Telefone / WhatsApp" hint="opcional"><Input value={phone} onChange={(e) => setPhone(formatPhone(e.target.value))} inputMode="tel" placeholder="(11) 99999-9999" /></Field>
                <Field label="Fuso horário">
                  <Select value={timezone} onChange={(e) => setTimezone(e.target.value)}>
                    {!TIMEZONES.includes(timezone) && <option value={timezone}>{timezone}</option>}
                    {TIMEZONES.map((z) => <option key={z} value={z}>{z.replace('America/', '').replace('_', ' ')}</option>)}
                  </Select>
                </Field>
              </div>
              {error && <p className="rounded-xl border border-rose-400/30 bg-rose-400/10 px-3.5 py-2.5 text-sm text-rose-200">{error}</p>}
              <Button size="lg" className="w-full" onClick={submit} loading={loading}>Criar estabelecimento</Button>
              <p className="text-center text-xs text-ink-500">Você começa com 14 dias de teste do plano Starter.</p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
