import { useEffect, useRef, useState } from 'react'
import { Send } from 'lucide-react'
import { TICKET_CATEGORY, TICKET_STATUS, useSupportMutations, useTicketMessages } from '@/api/saas'
import { Button, Spinner, Textarea } from '@/components/ui/ui'
import { useToast } from '@/components/ui/Toast'
import { Logo } from '@/components/layout/Logo'
import { errorMessage } from '@/lib/errors'
import { cn } from '@/lib/utils'
import type { SupportTicket } from '@/types/db'

const fmtDate = (iso: string) => new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })

/** Conversation view shared by establishments and the Innovai support team. */
export function TicketThread({ ticket, asStaff }: { ticket: SupportTicket; asStaff?: boolean }) {
  const { data: messages = [], isLoading } = useTicketMessages(ticket.id)
  const { reply, setStatus } = useSupportMutations()
  const toast = useToast()
  const [body, setBody] = useState('')
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }) }, [messages.length])

  const send = async () => {
    if (!body.trim()) return
    try { await reply.mutateAsync({ ticketId: ticket.id, body: body.trim() }); setBody('') }
    catch (e) { toast('error', 'Não foi possível enviar', errorMessage(e)) }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 pb-4 text-xs">
        <span className={cn('chip', TICKET_STATUS[ticket.status].chip)}>{TICKET_STATUS[ticket.status].label}</span>
        <span className="chip border-ink-600 text-ink-300">{TICKET_CATEGORY[ticket.category]}</span>
        {ticket.tenant_name && <span className="text-ink-400">{ticket.tenant_name}</span>}
        <span className="ml-auto text-ink-500">Aberto em {fmtDate(ticket.created_at)}</span>
      </div>
      <div className="flex-1 space-y-3">
        {isLoading && <Spinner />}
        {messages.map((m) => {
          const mine = asStaff ? m.is_staff : !m.is_staff
          return (
            <div key={m.id} className={cn('flex', mine ? 'justify-end' : 'justify-start')}>
              <div className={cn('max-w-[85%] rounded-2xl px-4 py-3 text-sm', mine ? 'rounded-br-md bg-lime/15 text-ink-50' : 'rounded-bl-md border border-ink-700 bg-ink-850')}>
                {m.is_staff && !asStaff && <Logo className="mb-1.5 scale-75 origin-left" />}
                <p className="whitespace-pre-wrap leading-relaxed">{m.body}</p>
                <p className="mt-1.5 text-[10px] text-ink-500">{m.is_staff ? 'Suporte Innovai' : 'Estabelecimento'} · {fmtDate(m.created_at)}</p>
              </div>
            </div>
          )
        })}
        <div ref={end} />
      </div>
      {ticket.status !== 'closed' ? (
        <div className="mt-4 space-y-2 border-t border-ink-800 pt-4">
          <Textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Escreva sua mensagem…" maxLength={5000}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send() }} />
          <div className="flex items-center justify-between gap-2">
            <button onClick={() => setStatus.mutate({ ticketId: ticket.id, status: 'closed' })} className="text-xs text-ink-400 hover:text-ink-100">Encerrar chamado</button>
            <Button size="sm" onClick={send} loading={reply.isPending} disabled={!body.trim()}><Send className="h-3.5 w-3.5" /> Enviar</Button>
          </div>
        </div>
      ) : (
        <button onClick={() => setStatus.mutate({ ticketId: ticket.id, status: 'open' })} className="mt-4 text-xs text-ink-400 hover:text-lime">Reabrir chamado</button>
      )}
    </div>
  )
}
