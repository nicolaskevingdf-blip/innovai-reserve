import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Bell, CheckCheck, Mail, MessageCircle, Send, Smartphone } from 'lucide-react'
import { useCurrentTenant } from '@/hooks/useTenant'
import { useMarkRead, useNotifications } from '@/api/notifications'
import { Button, Card, EmptyState, Segmented } from '@/components/ui/ui'
import { fmt } from '@/lib/datetime'
import { NOTIFICATION_STATUS, TEMPLATE_LABEL } from '@/lib/constants'
import { cn } from '@/lib/utils'

const CHANNEL_ICON = { email: Mail, whatsapp: MessageCircle, push: Smartphone, sms: Send, in_app: Bell }

export default function Notifications() {
  const { tenant } = useCurrentTenant()
  const tz = tenant.timezone
  const [scope, setScope] = useState<'inbox' | 'outbox'>('inbox')
  const { data = [], isLoading } = useNotifications(tenant.id, scope)
  const markRead = useMarkRead(tenant.id)
  const unread = data.filter((n) => !n.read_at).length

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-2xl font-bold md:text-3xl">Notificações</h1>
          <p className="mt-1 text-sm text-ink-400">Avisos da equipe em tempo real e fila de mensagens para clientes.</p>
        </div>
        <div className="flex gap-2">
          <Segmented value={scope} onChange={setScope} options={[{ value: 'inbox', label: 'Painel' }, { value: 'outbox', label: 'Mensagens a clientes' }]} />
          {scope === 'inbox' && unread > 0 && <Button size="sm" variant="secondary" className="h-9" onClick={() => markRead.mutate(undefined)}><CheckCheck className="h-3.5 w-3.5" /> Marcar todas</Button>}
        </div>
      </div>

      {scope === 'outbox' && (
        <div className="rounded-2xl border border-sky-400/20 bg-sky-400/[0.06] px-4 py-3 text-sm text-sky-100">
          Mensagens são enfileiradas automaticamente. O envio real acontece pela Edge Function <code className="text-sky-300">notification-dispatcher</code> com os provedores configurados.
          Ative canais em <Link to="/app/configuracoes?tab=notificacoes" className="font-semibold underline underline-offset-2">Configurações → Notificações</Link>.
        </div>
      )}

      <Card className="divide-y divide-ink-800">
        {isLoading && <div className="space-y-2 p-4">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="skeleton h-14" />)}</div>}
        {!isLoading && data.length === 0 && (
          <EmptyState icon={<Bell className="h-6 w-6" />} title={scope === 'inbox' ? 'Nenhuma notificação' : 'Nenhuma mensagem na fila'}
            description={scope === 'inbox' ? 'Você será avisado aqui quando chegarem reservas online.' : 'Ative e-mail ou WhatsApp para começar a enviar mensagens aos clientes.'} />
        )}
        {data.map((n) => {
          const Icon = CHANNEL_ICON[n.channel]
          return (
            <button key={n.id} onClick={() => scope === 'inbox' && !n.read_at && markRead.mutate(n.id)}
              className={cn('flex w-full items-start gap-3.5 px-4 py-4 text-left transition hover:bg-ink-850 md:px-5', scope === 'inbox' && !n.read_at && 'bg-lime/[0.03]')}>
              <div className={cn('mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl border', scope === 'inbox' && !n.read_at ? 'border-lime/30 bg-lime/10 text-lime' : 'border-ink-700 bg-ink-850 text-ink-400')}>
                <Icon className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-semibold">{n.title ?? TEMPLATE_LABEL[n.template] ?? n.template}</p>
                  {scope === 'outbox' && <span className={cn('chip', NOTIFICATION_STATUS[n.status].chip)}>{NOTIFICATION_STATUS[n.status].label}</span>}
                  {scope === 'outbox' && <span className="text-xs text-ink-500">{TEMPLATE_LABEL[n.template] ?? n.template} · {n.recipient}</span>}
                </div>
                {n.body && <p className="mt-0.5 text-sm text-ink-300">{n.body}</p>}
                {n.error && <p className="mt-1 text-xs text-rose-300">{n.error}</p>}
                <p className="mt-1 text-xs text-ink-500">
                  {scope === 'outbox' && n.status === 'pending' ? `Agendada para ${fmt(n.scheduled_for, tz, "dd/MM 'às' HH:mm")}` : fmt(n.created_at, tz, "dd/MM 'às' HH:mm")}
                </p>
              </div>
              {scope === 'inbox' && !n.read_at && <span className="mt-2 h-2 w-2 rounded-full bg-lime" />}
            </button>
          )
        })}
      </Card>
    </div>
  )
}
