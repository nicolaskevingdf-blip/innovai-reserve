// =====================================================================
// ai-assistant — Supabase Edge Function (Deno)
//
// Answers questions about ONE establishment's data ("Quais foram os
// horários mais movimentados esta semana?") with Claude + tool use.
//
// Guarantees:
//  * Every tool calls an existing SQL function with the *user's* JWT, so
//    Row Level Security limits the assistant to data that person can see.
//  * The model only receives numbers returned by those tools and is told
//    never to estimate or invent figures.
//  * Requires the `ai_insights` plan feature and ANTHROPIC_API_KEY; without
//    the key it answers 503 AI_NOT_CONFIGURED (nothing is simulated).
//
// Setup:  supabase secrets set ANTHROPIC_API_KEY=...
//         supabase functions deploy ai-assistant
// =====================================================================
import Anthropic from 'npm:@anthropic-ai/sdk@1.13.0'
import { betaTool } from 'npm:@anthropic-ai/sdk@1.13.0/helpers/beta/json-schema'
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'

const env = (k: string) => Deno.env.get(k) ?? ''
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

const MODEL = 'claude-opus-5-5'
const DATE = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Data local no formato AAAA-MM-DD' } as const

function systemPrompt(name: string, segment: string) {
  return `Você é o assistente de dados do estabelecimento "${name}" (segmento: ${segment}) na plataforma Innovai Reserve.

Regras obrigatórias:
- Use SOMENTE números retornados pelas ferramentas. Nunca estime, arredonde para "cerca de" nem invente dados. Se a informação não estiver nos resultados, diga claramente que esse dado não está disponível.
- Sempre informe o período considerado. Quando a pergunta não disser o período, use os últimos 30 dias. Converta expressões como "esta semana" ou "este mês" a partir da data de hoje informada na mensagem.
- Responda em português do Brasil, de forma direta e curta, com listas quando ajudar. Valores em dinheiro vêm em centavos nas ferramentas: converta para reais.
- Você pode sugerir ações práticas, mas apenas quando forem baseadas nos dados obtidos; separe-as como "Sugestão".
- Os dados são privados deste estabelecimento. Não fale de outros estabelecimentos.`
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)
  const authorization = req.headers.get('Authorization')
  if (!authorization) return json({ error: 'unauthorized' }, 401)

  let body: { tenant_id?: string; question?: string; history?: { role: 'user' | 'assistant'; content: string }[] }
  try { body = await req.json() } catch { return json({ error: 'invalid_json' }, 400) }
  const tenantId = body.tenant_id ?? ''
  const question = (body.question ?? '').trim()
  if (!/^[0-9a-f-]{36}$/i.test(tenantId) || question.length < 3 || question.length > 1000) {
    return json({ error: 'invalid_request' }, 400)
  }

  // Database client acting as the signed-in user (RLS applies to every call)
  const db = createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false },
  })
  const usage = await db.rpc('get_plan_usage', { p_tenant: tenantId })
  if (usage.error) return json({ error: 'forbidden' }, 403)
  if (!usage.data?.features?.ai_insights) {
    return json({ code: 'FEATURE_LOCKED', error: 'O assistente de IA está disponível no plano Business.' }, 403)
  }
  if (!env('ANTHROPIC_API_KEY')) {
    return json({ code: 'AI_NOT_CONFIGURED', error: 'Assistente não configurado: defina o secret ANTHROPIC_API_KEY na Edge Function ai-assistant.' }, 503)
  }
  const { data: tenant } = await db.from('tenants').select('name, segment, timezone').eq('id', tenantId).single()
  if (!tenant) return json({ error: 'forbidden' }, 403)
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: tenant.timezone }).format(new Date())

  const used: string[] = []
  const call = async (name: string, fn: string, args: Record<string, unknown>) => {
    used.push(name)
    const { data, error } = await db.rpc(fn, { p_tenant: tenantId, ...args })
    return JSON.stringify(error ? { error: error.message } : data)
  }

  const tools = [
    betaTool({
      name: 'get_period_summary',
      description: 'Totais de um período: reservas, status (pendentes, confirmadas, concluídas, canceladas, faltas), pessoas, novos clientes, ocupação, movimento por dia, por hora e por dia da semana, origem das reservas e comparação com o período anterior de mesmo tamanho.',
      inputSchema: { type: 'object', properties: { from: DATE, to: DATE }, required: ['from', 'to'], additionalProperties: false },
      run: (i) => call('get_period_summary', 'dashboard_metrics', { p_from: i.from, p_to: i.to }),
    }),
    betaTool({
      name: 'get_detailed_report',
      description: 'Relatório detalhado de um período: taxas de cancelamento e falta, média de pessoas, antecedência das reservas online, mapa dia da semana × hora, faltas por dia da semana, motivos de cancelamento, uso e ocupação de cada mesa, clientes novos e recorrentes, clientes que mais vieram, e métricas por profissional e serviço.',
      inputSchema: { type: 'object', properties: { from: DATE, to: DATE }, required: ['from', 'to'], additionalProperties: false },
      run: (i) => call('get_detailed_report', 'report_data', { p_from: i.from, p_to: i.to }),
    }),
    betaTool({
      name: 'get_staff_and_services',
      description: 'Atendimentos, concluídos, faltas e receita por profissional; serviços mais realizados; ocupação da agenda dos profissionais no período.',
      inputSchema: { type: 'object', properties: { from: DATE, to: DATE }, required: ['from', 'to'], additionalProperties: false },
      run: (i) => call('get_staff_and_services', 'staff_service_metrics', { p_from: i.from, p_to: i.to }),
    }),
    betaTool({
      name: 'get_customer_overview',
      description: 'Visão geral do CRM: total de clientes, novos em 30 dias, recorrentes, sem voltar há 60 dias, com faltas, total de cancelamentos e faltas, intervalo médio entre visitas.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: () => call('get_customer_overview', 'customer_insights', {}),
    }),
    betaTool({
      name: 'get_inactive_customers',
      description: 'Lista de clientes que já vieram e estão sem voltar há pelo menos N dias (sem reserva futura), com número de visitas, data da última visita e se aceitam mensagens.',
      inputSchema: {
        type: 'object',
        properties: { days: { type: 'integer', minimum: 1, maximum: 365 }, limit: { type: 'integer', minimum: 1, maximum: 100 } },
        required: ['days', 'limit'], additionalProperties: false,
      },
      run: (i) => call('get_inactive_customers', 'inactive_customers', { p_days: i.days, p_limit: i.limit }),
    }),
    betaTool({
      name: 'get_insights',
      description: 'Recomendações já calculadas a partir dos últimos 30 dias: tendência, horário de pico, dia mais vazio, faltas, cancelamentos, clientes inativos e participação das reservas online.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: () => call('get_insights', 'tenant_insights', {}),
    }),
  ]

  const history = (body.history ?? [])
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-6)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }))
  if (history.length && history[0].role !== 'user') history.shift()

  const client = new Anthropic({ apiKey: env('ANTHROPIC_API_KEY') })
  try {
    const final = await client.beta.messages.toolRunner({
      model: MODEL,
      max_tokens: 16000,
      max_iterations: 8,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium' },
      system: [{ type: 'text', text: systemPrompt(tenant.name, tenant.segment), cache_control: { type: 'ephemeral' } }],
      tools,
      messages: [...history, { role: 'user', content: `Hoje é ${today} (fuso ${tenant.timezone}).\n\nPergunta: ${question}` }],
    })
    if (final.stop_reason === 'refusal') {
      return json({ answer: 'Não posso responder a essa pergunta. Tente perguntar sobre reservas, clientes ou horários.', tools_used: used })
    }
    const answer = final.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n').trim()
    return json({ answer: answer || 'Não encontrei dados para responder a essa pergunta.', tools_used: [...new Set(used)] })
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) return json({ code: 'RATE_LIMITED', error: 'Muitas perguntas seguidas. Tente em instantes.' }, 429)
    if (e instanceof Anthropic.AuthenticationError) return json({ code: 'AI_NOT_CONFIGURED', error: 'Chave da API Anthropic inválida.' }, 503)
    if (e instanceof Anthropic.APIError) return json({ code: 'AI_ERROR', error: `Falha no serviço de IA (${e.status}).` }, 502)
    return json({ code: 'AI_ERROR', error: 'Falha ao consultar o assistente.' }, 500)
  }
})
