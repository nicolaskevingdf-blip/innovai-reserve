import { useParams, Link } from 'react-router-dom'
import { BarChart3, Check, type LucideIcon } from 'lucide-react'
import { Card } from '@/components/ui/ui'

const MODULES: Record<string, { title: string; phase: string; icon: LucideIcon; intro: string; items: string[]; ready: string[] }> = {
  relatorios: {
    title: 'Relatórios', phase: 'Fase 5 · Inteligência', icon: BarChart3,
    intro: 'Relatórios por período com exportação e uma camada de IA que responde perguntas usando apenas dados reais.',
    items: ['Ocupação por mesa / profissional', 'Origem das reservas e conversão', 'Padrões de cancelamento e faltas', 'Perguntas em linguagem natural (“Qual profissional mais atendeu?”)'],
    ready: ['Função dashboard_metrics com séries por dia, hora, dia da semana e origem', 'customer_insights para CRM', 'Exportação CSV na tela de Reservas'],
  },
}

export default function Roadmap() {
  const { module = '' } = useParams()
  const m = MODULES[module]
  if (!m) return <p className="text-ink-400">Módulo não encontrado.</p>
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-center gap-4">
        <div className="grid h-12 w-12 place-items-center rounded-2xl border border-ink-700 bg-ink-850 text-lime"><m.icon className="h-6 w-6" /></div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-lime">{m.phase}</p>
          <h1 className="text-2xl font-bold">{m.title}</h1>
        </div>
      </div>
      <p className="text-ink-300">{m.intro}</p>
      <Card className="p-6">
        <h2 className="font-semibold">O que este módulo vai entregar</h2>
        <ul className="mt-4 space-y-2.5">{m.items.map((i) => <li key={i} className="flex gap-2.5 text-sm text-ink-200"><span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-ink-500" />{i}</li>)}</ul>
      </Card>
      <Card className="p-6">
        <h2 className="font-semibold">Já preparado na base (Fase 1)</h2>
        <ul className="mt-4 space-y-2.5">{m.ready.map((i) => <li key={i} className="flex gap-2.5 text-sm text-ink-200"><Check className="mt-0.5 h-4 w-4 shrink-0 text-lime" />{i}</li>)}</ul>
      </Card>
      <p className="text-sm text-ink-400">Enquanto isso, a capacidade é controlada pelas <Link to="/app/configuracoes?tab=regras" className="text-lime hover:underline">regras de reserva</Link>.</p>
    </div>
  )
}
