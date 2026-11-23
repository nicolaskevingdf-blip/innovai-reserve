import { useState } from 'react'
import { LifeBuoy, Plus } from 'lucide-react'
import { useCurrentTenant } from '@/hooks/useTenant'
import { TICKET_CATEGORY, TICKET_STATUS, useSupportMutations, useTickets } from '@/api/saas'
import { Button, Card, EmptyState, Field, Input, Select, Textarea } from '@/components/ui/ui'
import { Sheet } from '@/components/ui/Sheet'
import { useToast } from '@/components/ui/Toast'
import { TicketThread } from '@/components/support/TicketThread'
import { errorMessage } from '@/lib/errors'
import { cn } from '@/lib/utils'
import type { SupportTicket, TicketCategory } from '@/types/db'

export default function Support() {
  const { tenant } = useCurrentTenant()
  const { data: tickets = [], isLoading } = useTickets(tenant.id)
  const [open, setOpen] = useState<SupportTicket | null>(null)
  const [creating, setCreating] = useState(false)

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-2xl font-bold md:text-3xl">Suporte</h1>
          <p className="mt-1 text-sm text-ink-400">Fale com a equipe Innovai: dúvidas, problemas, cobrança ou mudança de plano.</p>
        </div>
        <Button size="sm" className="h-9" onClick={() => setCreating(true)}><Plus className="h-3.5 w-3.5" /> Novo chamado</Button>
      </div>
      {isLoading ? <div className="skeleton h-32 rounded-2xl" /> : tickets.length === 0 ? (
        <Card><EmptyState icon={<LifeBuoy className="h-6 w-6" />} title="Nenhum chamado" description="Abra um chamado e a equipe Innovai responde por aqui." /></Card>
      ) : (
        <Card className="divide-y divide-ink-800">
          {tickets.map((t) => (
            <button key={t.id} onClick={() => setOpen(t)} className="flex w-full items-center gap-4 px-5 py-4 text-left hover:bg-ink-850">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{t.subject}</p>
                <p className="text-xs text-ink-400">{TICKET_CATEGORY[t.category]} · atualizado {new Date(t.updated_at).toLocaleDateString('pt-BR')}</p>
              </div>
              <span className={cn('chip', TICKET_STATUS[t.status].chip)}>{TICKET_STATUS[t.status].label}</span>
            </button>
          ))}
        </Card>
      )}
      <Sheet open={!!open} onClose={() => setOpen(null)} wide title={open?.subject ?? ''}>
        {open && <TicketThread ticket={tickets.find((t) => t.id === open.id) ?? open} />}
      </Sheet>
      <NewTicket open={creating} onClose={() => setCreating(false)} onCreated={(t) => { setCreating(false); setOpen(t) }} />
    </div>
  )
}

export function NewTicket({ open, onClose, onCreated, defaults }: {
  open: boolean; onClose: () => void; onCreated?: (t: SupportTicket) => void; defaults?: { subject?: string; category?: TicketCategory; body?: string }
}) {
  const { tenant } = useCurrentTenant()
  const toast = useToast()
  const { open: create } = useSupportMutations()
  const [subject, setSubject] = useState(defaults?.subject ?? '')
  const [category, setCategory] = useState<TicketCategory>(defaults?.category ?? 'question')
  const [body, setBody] = useState(defaults?.body ?? '')
  const save = async () => {
    if (subject.trim().length < 3) return toast('error', 'Descreva o assunto')
    if (!body.trim()) return toast('error', 'Escreva a mensagem')
    try {
      const t = await create.mutateAsync({ tenantId: tenant.id, subject: subject.trim(), category, body: body.trim() })
      toast('success', 'Chamado aberto', 'A equipe Innovai vai responder por aqui.')
      onCreated?.(t)
      onClose()
    } catch (e) { toast('error', 'Erro', errorMessage(e)) }
  }
  return (
    <Sheet open={open} onClose={onClose} title="Novo chamado" footer={<Button className="w-full" onClick={save} loading={create.isPending}>Enviar</Button>}>
      <div className="space-y-4">
        <Field label="Assunto"><Input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={160} /></Field>
        <Field label="Categoria">
          <Select value={category} onChange={(e) => setCategory(e.target.value as TicketCategory)}>
            {(Object.keys(TICKET_CATEGORY) as TicketCategory[]).map((c) => <option key={c} value={c}>{TICKET_CATEGORY[c]}</option>)}
          </Select>
        </Field>
        <Field label="Mensagem"><Textarea value={body} onChange={(e) => setBody(e.target.value)} className="min-h-[140px]" /></Field>
      </div>
    </Sheet>
  )
}
