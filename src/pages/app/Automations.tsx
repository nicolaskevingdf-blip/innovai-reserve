import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Cake, HeartHandshake, Info, Lock } from 'lucide-react'
import { useCurrentTenant } from '@/hooks/useTenant'
import { useAutomationPreview, useAutomations, useSaveAutomation } from '@/api/intelligence'
import { usePlanUsage } from '@/api/saas'
import { useNotificationSettings } from '@/api/tenant'
import { Button, Card, Field, Input, Select, Switch, Textarea } from '@/components/ui/ui'
import { useToast } from '@/components/ui/Toast'
import { errorMessage } from '@/lib/errors'
import type { AutomationKind, AutomationRule } from '@/types/db'

const META: Record<AutomationKind, { title: string; icon: typeof Cake; desc: string; message: string }> = {
  win_back: {
    title: 'Reconquista de clientes', icon: HeartHandshake,
    desc: 'Convida quem já veio e não volta há algum tempo. Cada cliente recebe no máximo uma mensagem a cada 90 dias.',
    message: 'Oi {nome}! Faz tempo que você não aparece no {estabelecimento}. Que tal reservar um horário? {link}',
  },
  birthday: {
    title: 'Aniversário', icon: Cake,
    desc: 'Mensagem no dia do aniversário (requer data de aniversário no cadastro do cliente). Uma vez por ano.',
    message: 'Feliz aniversário, {nome}! 🎉 Comemore com a gente no {estabelecimento}: {link}',
  },
}

export default function Automations() {
  const { tenant, isManager } = useCurrentTenant()
  const { data: usage } = usePlanUsage(tenant.id)
  const { data: rules = [] } = useAutomations(tenant.id)
  const { data: ns } = useNotificationSettings(tenant.id)
  const allowed = usage?.features.automations ?? false

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold md:text-3xl">Automações</h1>
        <p className="mt-1 text-sm text-ink-400">Mensagens de relacionamento enviadas automaticamente, uma vez por dia, apenas para clientes que aceitaram receber promoções (LGPD).</p>
      </div>
      {!allowed && (
        <div className="flex items-center gap-2 rounded-2xl border border-ink-700 bg-ink-850 px-4 py-3 text-sm text-ink-300">
          <Lock className="h-4 w-4" /> Automações estão disponíveis a partir do plano Pro. <Link to="/app/plano" className="font-semibold text-lime hover:underline">Ver planos</Link>
        </div>
      )}
      {ns && !ns.whatsapp_enabled && !ns.email_enabled && (
        <div className="flex items-start gap-2 rounded-2xl border border-sky-400/25 bg-sky-400/[0.06] px-4 py-3 text-sm text-sky-100">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <span>Nenhum canal de envio está ativo. Ative WhatsApp ou e-mail em <Link to="/app/configuracoes?tab=notificacoes" className="font-semibold underline">Configurações → Notificações</Link>; sem isso, nada é enviado.</span>
        </div>
      )}
      <div className="grid gap-6 xl:grid-cols-2">
        {(['win_back', 'birthday'] as AutomationKind[]).map((k) => (
          <RuleCard key={k} kind={k} rule={rules.find((r) => r.kind === k)} disabled={!allowed || !isManager} />
        ))}
      </div>
      <p className="text-xs text-ink-500">Variáveis: <code>{'{nome}'}</code> (primeiro nome), <code>{'{estabelecimento}'}</code>, <code>{'{link}'}</code> (sua página de reservas). As mensagens passam pela mesma fila de envio das confirmações e aparecem em Notificações → Mensagens a clientes.</p>
    </div>
  )
}

function RuleCard({ kind, rule, disabled }: { kind: AutomationKind; rule?: AutomationRule; disabled: boolean }) {
  const { tenant } = useCurrentTenant()
  const toast = useToast()
  const save = useSaveAutomation(tenant.id)
  const m = META[kind]
  const [f, setF] = useState({ enabled: false, channel: 'whatsapp' as 'whatsapp' | 'email', days: 60, message: m.message })
  useEffect(() => { if (rule) setF({ enabled: rule.enabled, channel: rule.channel, days: rule.days, message: rule.message }) }, [rule])
  const { data: preview } = useAutomationPreview(tenant.id, kind, f.days, f.channel)

  const submit = async (patch?: Partial<typeof f>) => {
    const next = { ...f, ...patch }
    try { await save.mutateAsync({ kind, ...next }); setF(next); toast('success', next.enabled ? `${m.title} ativada` : 'Automação salva') }
    catch (e) { toast('error', 'Não foi possível salvar', errorMessage(e)) }
  }

  return (
    <Card className="space-y-4 p-5">
      <div className="flex items-start gap-3">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-ink-800 text-lime"><m.icon className="h-5 w-5" /></div>
        <div className="flex-1">
          <p className="font-semibold">{m.title}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-ink-400">{m.desc}</p>
        </div>
        <Switch checked={f.enabled} disabled={disabled} onChange={(v) => void submit({ enabled: v })} />
      </div>
      <fieldset disabled={disabled} className="space-y-3 disabled:opacity-70">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Canal">
            <Select value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value as 'whatsapp' | 'email' })}>
              <option value="whatsapp">WhatsApp</option>
              <option value="email">E-mail</option>
            </Select>
          </Field>
          {kind === 'win_back' && <Field label="Sem voltar há" hint="dias"><Input type="number" min={14} max={365} value={f.days} onChange={(e) => setF({ ...f, days: Number(e.target.value) })} /></Field>}
        </div>
        <Field label="Mensagem"><Textarea value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} maxLength={600} /></Field>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-ink-400">
            {preview ? <>Hoje receberiam: <b className="text-ink-100">{preview.count}</b> cliente(s){preview.sample.length ? ` (${preview.sample.join(', ')}${preview.count > preview.sample.length ? '…' : ''})` : ''}</> : 'Calculando público…'}
            {rule?.last_run_at && <> · última execução {new Date(rule.last_run_at).toLocaleDateString('pt-BR')}</>}
          </p>
          <Button size="sm" variant="secondary" onClick={() => void submit()} loading={save.isPending}>Salvar</Button>
        </div>
      </fieldset>
    </Card>
  )
}
