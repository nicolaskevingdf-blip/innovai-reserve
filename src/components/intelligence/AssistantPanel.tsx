import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Bot, Lock, Send, Sparkles } from 'lucide-react'
import { askAssistant, AssistantError, type AssistantTurn } from '@/api/intelligence'
import { usePlanUsage } from '@/api/saas'
import { Button, Card, CardHeader, Spinner } from '@/components/ui/ui'
import { cn } from '@/lib/utils'
import type { Segment } from '@/types/db'

const SUGGESTIONS: Record<'restaurant' | 'services', string[]> = {
  restaurant: ['Quais foram os horários mais movimentados esta semana?', 'Quantos clientes cancelaram neste mês?', 'Quais mesas tiveram maior ocupação?', 'Quais clientes deixaram de voltar?'],
  services: ['Qual profissional teve mais atendimentos este mês?', 'Quais serviços foram mais realizados?', 'Quantos clientes faltaram nos últimos 30 dias?', 'Quais clientes deixaram de voltar?'],
}

/** Q&A over the establishment's own data. The AI only sees numbers returned by
 *  database functions executed with the user's permissions. */
export function AssistantPanel({ tenantId, segment }: { tenantId: string; segment: Segment }) {
  const { data: usage } = usePlanUsage(tenantId)
  const [turns, setTurns] = useState<AssistantTurn[]>([])
  const [question, setQuestion] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<AssistantError | null>(null)
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }) }, [turns.length, loading])

  const allowed = usage?.features.ai_insights ?? false
  const ask = async (q: string) => {
    const text = q.trim()
    if (!text || loading) return
    setError(null)
    setQuestion('')
    const history = turns
    setTurns([...history, { role: 'user', content: text }])
    setLoading(true)
    try {
      const r = await askAssistant(tenantId, text, history)
      setTurns((t) => [...t, { role: 'assistant', content: r.answer }])
    } catch (e) {
      setError(e instanceof AssistantError ? e : new AssistantError('Falha ao consultar o assistente.'))
      setTurns(history)
      setQuestion(text)
    } finally { setLoading(false) }
  }

  return (
    <Card className="flex flex-col">
      <CardHeader title="Assistente de dados" subtitle="Pergunte sobre suas reservas e clientes. Respostas usam apenas os dados reais do seu estabelecimento."
        icon={<Bot className="h-4 w-4" />} />
      {!allowed ? (
        <div className="m-5 flex items-start gap-3 rounded-2xl border border-ink-700 bg-ink-850 p-4 text-sm text-ink-300">
          <Lock className="mt-0.5 h-4 w-4 shrink-0 text-ink-400" />
          <span>O assistente de IA está disponível no plano Business. <Link to="/app/plano" className="font-semibold text-lime hover:underline">Ver planos</Link></span>
        </div>
      ) : (
        <div className="flex flex-1 flex-col p-5">
          <div className="max-h-[420px] min-h-[120px] flex-1 space-y-3 overflow-y-auto pr-1">
            {turns.length === 0 && (
              <div className="flex flex-wrap gap-2">
                {SUGGESTIONS[segment === 'restaurant' ? 'restaurant' : 'services'].map((s) => (
                  <button key={s} onClick={() => void ask(s)} className="chip border-ink-600 px-3 py-1.5 text-left text-xs text-ink-200 hover:border-lime/50 hover:text-lime">
                    <Sparkles className="h-3 w-3" /> {s}
                  </button>
                ))}
              </div>
            )}
            {turns.map((t, i) => (
              <div key={i} className={cn('flex', t.role === 'user' ? 'justify-end' : 'justify-start')}>
                <div className={cn('max-w-[88%] whitespace-pre-wrap rounded-2xl px-4 py-3 text-sm leading-relaxed',
                  t.role === 'user' ? 'rounded-br-md bg-lime/15 text-ink-50' : 'rounded-bl-md border border-ink-700 bg-ink-850 text-ink-100')}>
                  {t.content}
                </div>
              </div>
            ))}
            {loading && <div className="flex items-center gap-2 text-xs text-ink-400"><Spinner className="h-4 w-4" /> Consultando seus dados…</div>}
            <div ref={end} />
          </div>
          {error && (
            <p className={cn('mt-3 rounded-xl border px-3 py-2.5 text-xs', error.code === 'AI_NOT_CONFIGURED' || error.code === 'AI_UNAVAILABLE'
              ? 'border-sky-400/30 bg-sky-400/10 text-sky-100' : 'border-rose-400/30 bg-rose-400/10 text-rose-200')}>
              {error.message}
            </p>
          )}
          <form onSubmit={(e) => { e.preventDefault(); void ask(question) }} className="mt-3 flex gap-2">
            <input value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={1000} placeholder="Ex.: Quantas reservas tivemos no sábado?"
              className="field flex-1" aria-label="Pergunta para o assistente" />
            <Button type="submit" disabled={!question.trim() || loading} aria-label="Enviar pergunta"><Send className="h-4 w-4" /></Button>
          </form>
        </div>
      )}
    </Card>
  )
}
