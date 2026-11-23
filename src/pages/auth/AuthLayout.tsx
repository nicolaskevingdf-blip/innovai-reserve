import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { CalendarCheck2, ShieldCheck, Zap } from 'lucide-react'
import { Logo } from '@/components/layout/Logo'

export function AuthLayout({ title, subtitle, children, footer }: { title: string; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="grid min-h-screen bg-ink-950 lg:grid-cols-[1fr_1.1fr]">
      <div className="flex flex-col px-6 py-8 md:px-12">
        <Link to="/"><Logo /></Link>
        <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center py-10 animate-fade-up">
          <h1 className="text-3xl font-bold">{title}</h1>
          {subtitle && <p className="mt-2 text-sm text-ink-400">{subtitle}</p>}
          <div className="mt-8">{children}</div>
          {footer && <div className="mt-6 text-center text-sm text-ink-400">{footer}</div>}
        </div>
        <p className="text-center text-xs text-ink-600">© {new Date().getFullYear()} Innovai</p>
      </div>
      <div className="relative hidden overflow-hidden border-l border-ink-800 bg-ink-900 lg:block">
        <div className="absolute inset-0 grid-bg" />
        <div className="absolute -left-20 top-1/3 h-96 w-96 rounded-full bg-lime/20 blur-[120px]" />
        <div className="relative flex h-full flex-col justify-center px-16">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-lime">Innovai Reserve</p>
          <h2 className="mt-4 max-w-md font-display text-4xl font-extrabold leading-tight">A agenda do seu negócio, cheia e sob controle.</h2>
          <div className="mt-10 space-y-5">
            {[
              { icon: CalendarCheck2, t: 'Reservas online 24h', d: 'Link próprio, sem o cliente precisar criar conta.' },
              { icon: Zap, t: 'Disponibilidade em tempo real', d: 'Sem conflitos: o sistema revalida cada horário no momento da confirmação.' },
              { icon: ShieldCheck, t: 'Dados isolados e seguros', d: 'Cada estabelecimento enxerga apenas os próprios dados.' },
            ].map((f) => (
              <div key={f.t} className="flex gap-4">
                <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-ink-700 bg-ink-850 text-lime"><f.icon className="h-5 w-5" /></div>
                <div><p className="font-semibold">{f.t}</p><p className="text-sm text-ink-400">{f.d}</p></div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
