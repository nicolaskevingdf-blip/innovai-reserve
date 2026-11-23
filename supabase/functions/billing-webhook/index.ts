// =====================================================================
// billing-webhook — Supabase Edge Function (Deno)
//
// Keeps `subscriptions` in sync with Stripe. Nothing is simulated: without
// STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET the function refuses requests.
//
// Stripe setup (Fase 4 — cobrança recorrente):
//   1. Products/Prices in Stripe with metadata  plan_code = starter | pro | business
//   2. Checkout/Subscriptions created with metadata  tenant_id = <uuid do estabelecimento>
//   3. Webhook endpoint → https://<ref>.functions.supabase.co/billing-webhook
//      events: customer.subscription.created|updated|deleted, invoice.paid, invoice.payment_failed
//   4. supabase secrets set STRIPE_SECRET_KEY=... STRIPE_WEBHOOK_SECRET=...
//   5. supabase functions deploy billing-webhook --no-verify-jwt
// =====================================================================
import Stripe from 'npm:stripe@16.12.0'
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'

const env = (k: string) => Deno.env.get(k) ?? ''
const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } })

const STATUS: Record<string, string> = {
  trialing: 'trialing', active: 'active', past_due: 'past_due', unpaid: 'past_due',
  incomplete: 'past_due', incomplete_expired: 'cancelled', canceled: 'cancelled', paused: 'suspended',
}

Deno.serve(async (req) => {
  if (!env('STRIPE_SECRET_KEY') || !env('STRIPE_WEBHOOK_SECRET')) {
    return new Response('Billing not configured (STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET)', { status: 503 })
  }
  const stripe = new Stripe(env('STRIPE_SECRET_KEY'), { apiVersion: '2024-06-20' })
  const signature = req.headers.get('stripe-signature') ?? ''
  let event: Stripe.Event
  try {
    event = await stripe.webhooks.constructEventAsync(await req.text(), signature, env('STRIPE_WEBHOOK_SECRET'))
  } catch (e) {
    return new Response(`Invalid signature: ${e}`, { status: 400 })
  }

  let sub: Stripe.Subscription | null = null
  if (event.type.startsWith('customer.subscription.')) sub = event.data.object as Stripe.Subscription
  if (event.type === 'invoice.paid' || event.type === 'invoice.payment_failed') {
    const inv = event.data.object as Stripe.Invoice
    if (inv.subscription) sub = await stripe.subscriptions.retrieve(String(inv.subscription))
  }
  if (!sub) return Response.json({ ignored: event.type })

  const tenantId = sub.metadata?.tenant_id
  if (!tenantId) return new Response('Subscription without metadata.tenant_id', { status: 422 })

  const price = sub.items.data[0]?.price
  const product = price?.product ? await stripe.products.retrieve(String(price.product)) : null
  const planCode = price?.metadata?.plan_code ?? product?.metadata?.plan_code ?? null
  let planId: string | null = null
  if (planCode) {
    const { data } = await supabase.from('plans').select('id').eq('code', planCode).maybeSingle()
    planId = data?.id ?? null
  }

  const status = event.type === 'customer.subscription.deleted' ? 'cancelled' : STATUS[sub.status] ?? 'past_due'
  const patch: Record<string, unknown> = {
    status,
    provider: 'stripe',
    provider_customer_id: String(sub.customer),
    provider_subscription_id: sub.id,
    current_period_start: new Date(sub.current_period_start * 1000).toISOString(),
    current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
    trial_ends_at: sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null,
    ...(planId ? { plan_id: planId } : {}),
  }
  const { error } = await supabase.from('subscriptions').update(patch).eq('tenant_id', tenantId)
  if (error) return new Response(error.message, { status: 500 })

  // A successful payment re-opens a suspended establishment
  if (status === 'active') await supabase.from('tenants').update({ status: 'active' }).eq('id', tenantId).eq('status', 'suspended')

  await supabase.from('audit_logs').insert({ tenant_id: tenantId, entity: 'billing', entity_id: sub.id, action: event.type, new_data: patch })
  return Response.json({ ok: true, tenant_id: tenantId, status })
})
