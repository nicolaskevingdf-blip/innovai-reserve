// =====================================================================
// notification-dispatcher — Supabase Edge Function (Deno)
//
// Drains the `notifications` outbox and delivers e-mail (Resend) and
// WhatsApp (Meta WhatsApp Business Cloud API) messages.
//
// Nothing is simulated: if a provider is not configured, the message is
// marked `requires_setup` with an explicit reason and is NOT reported as
// sent.
//
// Required secrets (supabase secrets set ...):
//   DISPATCH_SECRET              shared secret expected in the x-dispatch-secret header
//   RESEND_API_KEY               e-mail provider key (https://resend.com)
//   EMAIL_FROM                   e.g. "Innovai Reserve <reservas@seudominio.com>" (verified domain)
//   WHATSAPP_TOKEN               Meta permanent access token
//   WHATSAPP_PHONE_NUMBER_ID     WhatsApp Business phone number id
//   WHATSAPP_TEMPLATE_LANG       optional, default "pt_BR"
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected by Supabase.
//
// Schedule it every minute with pg_cron + pg_net (see README).
// =====================================================================
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'

interface Notification {
  id: string
  tenant_id: string
  channel: 'email' | 'whatsapp' | 'push' | 'sms'
  template: string
  recipient: string | null
  title: string | null
  body: string | null
  payload: Record<string, unknown>
}

type Outcome = { status: 'sent' | 'failed' | 'requires_setup' | 'skipped'; error?: string }

const env = (k: string) => Deno.env.get(k) ?? ''
const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } })

async function sendEmail(n: Notification, tenantName: string): Promise<Outcome> {
  if (!env('RESEND_API_KEY') || !env('EMAIL_FROM')) return { status: 'requires_setup', error: 'E-mail não configurado: defina RESEND_API_KEY e EMAIL_FROM.' }
  if (!n.recipient) return { status: 'skipped', error: 'Cliente sem e-mail.' }
  const html = `<div style="font-family:Inter,Arial,sans-serif;max-width:520px;margin:auto;padding:24px;color:#111">
    <p style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#6b6b76;margin:0">${escapeHtml(tenantName)}</p>
    <h2 style="margin:8px 0 16px">${escapeHtml(n.title ?? '')}</h2>
    <p style="font-size:15px;line-height:1.6">${escapeHtml(n.body ?? '')}</p>
    <p style="font-size:12px;color:#9c9ca6;margin-top:32px">Enviado por Innovai Reserve</p></div>`
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env('RESEND_API_KEY')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env('EMAIL_FROM'), to: [n.recipient], subject: `${n.title} · ${tenantName}`, html, text: n.body }),
  })
  return res.ok ? { status: 'sent' } : { status: 'failed', error: `Resend ${res.status}: ${(await res.text()).slice(0, 300)}` }
}

async function sendWhatsApp(n: Notification): Promise<Outcome> {
  if (!env('WHATSAPP_TOKEN') || !env('WHATSAPP_PHONE_NUMBER_ID')) {
    return { status: 'requires_setup', error: 'WhatsApp não configurado: defina WHATSAPP_TOKEN e WHATSAPP_PHONE_NUMBER_ID e aprove os templates na Meta.' }
  }
  if (!n.recipient) return { status: 'skipped', error: 'Cliente sem telefone.' }
  const to = n.recipient.length <= 11 ? `55${n.recipient}` : n.recipient
  // Business-initiated messages require pre-approved templates. Create templates in
  // Meta Business Manager with the same names as `n.template` and one body parameter.
  const res = await fetch(`https://graph.facebook.com/v20.0/${env('WHATSAPP_PHONE_NUMBER_ID')}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env('WHATSAPP_TOKEN')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp', to, type: 'template',
      template: {
        name: n.template, language: { code: env('WHATSAPP_TEMPLATE_LANG') || 'pt_BR' },
        components: [{ type: 'body', parameters: [{ type: 'text', text: n.body ?? '' }] }],
      },
    }),
  })
  return res.ok ? { status: 'sent' } : { status: 'failed', error: `WhatsApp ${res.status}: ${(await res.text()).slice(0, 300)}` }
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

Deno.serve(async (req) => {
  if (!env('DISPATCH_SECRET') || req.headers.get('x-dispatch-secret') !== env('DISPATCH_SECRET')) {
    return new Response('unauthorized', { status: 401 })
  }
  const { data, error } = await supabase.rpc('claim_due_notifications', { p_limit: 50 })
  if (error) return Response.json({ error: error.message }, { status: 500 })
  const batch = (data ?? []) as Notification[]

  const tenantIds = [...new Set(batch.map((n) => n.tenant_id))]
  const { data: tenants } = tenantIds.length
    ? await supabase.from('tenants').select('id, name').in('id', tenantIds)
    : { data: [] as { id: string; name: string }[] }
  const nameOf = new Map((tenants ?? []).map((t) => [t.id, t.name]))

  const results: Record<string, number> = {}
  for (const n of batch) {
    let outcome: Outcome
    try {
      outcome = n.channel === 'email' ? await sendEmail(n, nameOf.get(n.tenant_id) ?? '')
        : n.channel === 'whatsapp' ? await sendWhatsApp(n)
        : { status: 'requires_setup', error: `Canal ${n.channel} ainda não implementado.` }
    } catch (e) {
      outcome = { status: 'failed', error: String(e) }
    }
    await supabase.rpc('complete_notification', { p_id: n.id, p_status: outcome.status, p_error: outcome.error ?? null })
    results[outcome.status] = (results[outcome.status] ?? 0) + 1
  }
  return Response.json({ processed: batch.length, results })
})
