import { Link } from 'react-router-dom'
import { ArrowRight, BellRing, CalendarCheck2, LayoutDashboard, ShieldCheck, Smartphone, Users, Zap } from 'lucide-react'
import { Logo } from '@/components/layout/Logo'
import { useAuth } from '@/hooks/useAuth'

const FEATURES = [
  { icon: CalendarCheck2, t: 'Página de reservas própria', d: 'Link personalizado com sua marca. O cliente reserva em segundos, sem criar conta.' },
  { icon: Zap, t: 'Zero conflito de horários', d: 'Disponibilidade revalidada no banco no momento da confirmação, mesmo com acessos simultâneos.' },
  { icon: LayoutDashboard, t: 'Painel que entende seu negócio', d: 'Indicadores adaptados para restaurantes, barbearias e salões.' },
  { icon: Users, t: 'CRM automático', d: 'Histórico, frequência, faltas e clientes que não voltam — sem digitar nada.' },
  { icon: BellRing, t: 'Avisos em tempo real', d: 'Nova reserva online aparece instantaneamente no celular da equipe.' },
  { icon: ShieldCheck, t: 'Seguro e multiempresa', d: 'Cada estabelecimento isolado por políticas de segurança no banco de dados.' },
]

export default function Landing() {
  const { user } = useAuth()
  return (
    <div className="min-h-screen overflow-hidden bg-ink-950">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[640px] grid-bg [mask-image:linear-gradient(to_bottom,black,transparent)]" />
      <div className="pointer-events-none absolute left-1/2 top-24 h-[420px] w-[720px] -translate-x-1/2 rounded-full bg-lime/15 blur-[140px]" />
      <header className="relative mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
        <Logo />
        <div className="flex items-center gap-2">
          <Link to="/reserva" className="hidden px-3 text-sm text-ink-300 hover:text-ink-50 sm:block">Consultar reserva</Link>
          {user ? (
            <Link to="/app" className="inline-flex h-10 items-center gap-2 rounded-xl bg-lime px-4 text-sm font-semibold text-ink-950">Abrir painel <ArrowRight className="h-4 w-4" /></Link>
          ) : (
            <>
              <Link to="/entrar" className="inline-flex h-10 items-center rounded-xl px-4 text-sm font-semibold text-ink-100 hover:bg-ink-850">Entrar</Link>
              <Link to="/cadastro" className="inline-flex h-10 items-center rounded-xl bg-lime px-4 text-sm font-semibold text-ink-950 hover:bg-lime-400">Começar grátis</Link>
            </>
          )}
        </div>
      </header>

      <section className="relative mx-auto max-w-6xl px-6 pb-20 pt-16 text-center md:pt-24">
        <p className="mx-auto inline-flex items-center gap-2 rounded-full border border-ink-700 bg-ink-900/80 px-3 py-1 text-xs text-ink-300">
          <span className="h-1.5 w-1.5 rounded-full bg-lime" /> Reservas e agendamentos inteligentes
        </p>
        <h1 className="mx-auto mt-6 max-w-4xl font-display text-4xl font-extrabold leading-[1.05] tracking-tight md:text-7xl">
          Sua agenda cheia.<br /><span className="text-lime">Sem conflitos.</span>
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-base text-ink-300 md:text-lg">
          A plataforma da Innovai para restaurantes, barbearias e salões receberem reservas online, organizarem a agenda e conhecerem seus clientes.
        </p>
        <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Link to="/cadastro" className="inline-flex h-12 items-center gap-2 rounded-xl bg-lime px-6 font-semibold text-ink-950 shadow-glow hover:bg-lime-400">Criar meu estabelecimento <ArrowRight className="h-4 w-4" /></Link>
          <span className="flex items-center gap-2 text-sm text-ink-400"><Smartphone className="h-4 w-4" /> Funciona no celular, tablet e computador</span>
        </div>
      </section>

      <section className="relative mx-auto grid max-w-6xl gap-4 px-6 pb-24 md:grid-cols-3">
        {FEATURES.map((f) => (
          <div key={f.t} className="card p-6 transition hover:border-ink-600">
            <div className="grid h-10 w-10 place-items-center rounded-xl border border-ink-700 bg-ink-850 text-lime"><f.icon className="h-5 w-5" /></div>
            <h3 className="mt-5 font-semibold">{f.t}</h3>
            <p className="mt-2 text-sm leading-relaxed text-ink-400">{f.d}</p>
          </div>
        ))}
      </section>
      <footer className="border-t border-ink-800 py-8 text-center text-xs text-ink-500">© {new Date().getFullYear()} Innovai · Innovai Reserve</footer>
    </div>
  )
}
