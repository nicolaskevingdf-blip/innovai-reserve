import { useState } from 'react'
import { LifeBuoy } from 'lucide-react'
import { TICKET_CATEGORY, TICKET_STATUS, useAdminTickets } from '@/api/saas'
import { Card, EmptyState, Segmented } from '@/components/ui/ui'
import { Sheet } from '@/components/ui/Sheet'
import { TicketThread } from '@/components/support/TicketThread'
import { cn } from '@/lib/utils'
import type { SupportTicket } from '@/types/db'

export default function AdminSupport() {
  const [status, setStatus] = useState<'' | 'open' | 'answered' | 'closed'>('open')
  const { data: tickets = [], isLoading } = useAdminTickets(status)
  const [open, setOpen] = useState<SupportTicket | null>(null)
  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-2xl font-bold md:text-3xl">Suporte</h1>
          <p className="mt-1 text-sm text-ink-400">Chamados dos estabelecimentos. Respostas aparecem para o cliente em tempo real.</p>
        </div>
        <Segmented value={status} onChange={setStatus} options={[{ value: 'open', label: 'Abertos' }, { value: 'answered', label: 'Respondidos' }, { value: 'closed', label: 'Encerrados' }, { value: '', label: 'Todos' }]} />
      </div>
      {isLoading ? <div className="skeleton h-32 rounded-2xl" /> : tickets.length === 0 ? (
        <Card><EmptyState icon={<LifeBuoy className="h-6 w-6" />} title="Nenhum chamado aqui" /></Card>
      ) : (
        <Card className="divide-y divide-ink-800">
          {tickets.map((t) => (
            <button key={t.id} onClick={() => setOpen(t)} className="flex w-full items-center gap-4 px-5 py-4 text-left hover:bg-ink-850">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{t.subject}</p>
                <p className="truncate text-xs text-ink-400">{t.tenant_name} · {TICKET_CATEGORY[t.category]} · {t.messages} msg · {t.last_message}</p>
              </div>
              <span className={cn('chip', TICKET_STATUS[t.status].chip)}>{TICKET_STATUS[t.status].label}</span>
            </button>
          ))}
        </Card>
      )}
      <Sheet open={!!open} onClose={() => setOpen(null)} wide title={open?.subject ?? ''}>
        {open && <TicketThread ticket={tickets.find((t) => t.id === open.id) ?? open} asStaff />}
      </Sheet>
    </div>
  )
}
