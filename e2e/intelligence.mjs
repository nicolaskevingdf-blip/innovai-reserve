// Phase 5 E2E: reports, insights, automations, AI assistant gating.
// Usage: BASE_URL=... DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres node e2e/intelligence.mjs
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
const { chromium } = createRequire(import.meta.url)('playwright')

const BASE = process.env.BASE_URL ?? 'http://localhost:5173'
const DB = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
const OUT = process.env.SHOTS ?? 'e2e/screenshots'
const stamp = Date.now().toString(36)
const slug = `insights-${stamp}`
const log = (...a) => console.log('✓', ...a)
const sql = (q) => execFileSync('psql', [DB, '-qtAc', q]).toString().trim()

const browser = await chromium.launch()
const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))

await page.goto(`${BASE}/cadastro`)
await page.getByLabel('Seu nome').fill('Ivo Insights')
await page.getByLabel('E-mail').fill(`ivo+${stamp}@example.com`)
await page.getByLabel('Senha').fill('senha-forte-123')
await page.getByRole('button', { name: 'Criar conta' }).click()
await page.waitForURL('**/onboarding')
await page.getByRole('button', { name: /Restaurante/ }).click()
await page.getByRole('button', { name: 'Continuar' }).click()
await page.getByPlaceholder(/Cantina Bella Vista/).fill('Insights Bistrô')
await page.locator('input[placeholder="seu-negocio"]').fill(slug)
await page.waitForSelector('svg.lucide-check')
await page.getByRole('button', { name: 'Criar estabelecimento' }).click()
await page.waitForURL('**/app/dashboard')

// 30 days of history (past data is loaded directly, as an import would)
const tid = sql(`select id from public.tenants where slug = '${slug}'`)
sql(`update public.booking_settings set max_reservations_per_slot = null, max_guests_per_slot = null where tenant_id = '${tid}'`)
sql(`insert into public.reservations (tenant_id, customer_name, customer_phone, starts_at, party_size, status, source)
     select '${tid}', 'Cliente ' || (g % 7), '1198800000' || (g % 7), date_trunc('hour', now() - make_interval(days => 1 + (g % 28))) - interval '1 hour' * (g % 4),
            2 + (g % 4), case when g % 9 = 0 then 'no_show' else 'completed' end::public.reservation_status,
            case when g % 3 = 0 then 'online' else 'phone' end::public.reservation_source
     from generate_series(1, 40) g`)
sql(`insert into public.reservations (tenant_id, customer_name, customer_phone, starts_at, party_size, status, source)
     values ('${tid}', 'Cliente Sumido', '11988776655', now() - interval '80 days', 2, 'completed', 'phone')`)
sql(`update public.customers set marketing_opt_in = true where tenant_id = '${tid}' and name = 'Cliente Sumido'`)
log('restaurant with 30 days of history')

await page.goto(`${BASE}/app/dashboard`)
await page.waitForSelector('text=Horário de pico')
log('dashboard shows data-driven recommendations')

await page.goto(`${BASE}/app/relatorios`)
await page.waitForSelector('text=Mapa de movimento')
await page.waitForSelector('text=Faltas por dia da semana')
await page.waitForSelector('text=O assistente de IA está disponível no plano Business')
await page.screenshot({ path: `${OUT}/i1-reports.png`, fullPage: true })
log('advanced report renders (Pro trial); AI assistant locked outside Business')

// Innovai unlocks the assistant for this customer → the panel calls the Edge Function
sql(`update public.tenants set feature_overrides = '{"features":{"ai_insights":true}}' where id = '${tid}'`)
await page.reload()
await page.getByRole('button', { name: /Quais foram os horários mais movimentados/ }).click()
await page.waitForSelector('text=/não está disponível neste ambiente|não configurado/')
log('assistant reaches the ai-assistant function path and reports missing setup honestly')

await page.goto(`${BASE}/app/automacoes`)
await page.waitForSelector('text=Reconquista de clientes')
await page.waitForSelector('text=/Hoje receberiam: 1 cliente/')
await page.getByRole('switch').first().click()
await page.waitForSelector('text=Reconquista de clientes ativada')
await page.screenshot({ path: `${OUT}/i2-automations.png` })
log('win-back automation enabled; audience preview = 1 opted-in customer')

const queued = sql(`select public.run_automations() ->> 'queued'`)
if (queued !== '0') throw new Error('nothing should be queued while WhatsApp is off, got ' + queued)
sql(`update public.notification_settings set whatsapp_enabled = true where tenant_id = '${tid}'`)
const queued2 = sql(`select count(*) from public.notifications where tenant_id = '${tid}' and template = 'automation_win_back'`)
sql(`select public.run_automations()`)
const queued3 = sql(`select count(*) from public.notifications where tenant_id = '${tid}' and template = 'automation_win_back'`)
if (!(queued2 === '0' && queued3 === '1')) throw new Error(`expected 0→1 automation messages, got ${queued2}→${queued3}`)
await page.goto(`${BASE}/app/notificacoes`)
await page.getByRole('button', { name: 'Mensagens a clientes' }).click()
await page.waitForSelector('text=Sentimos sua falta')
log('daily job queued the message; visible in the outbox')

await browser.close()
if (errors.length) { console.error('Browser errors:\n' + errors.join('\n')); process.exit(1) }
console.log('\nINTELLIGENCE E2E PASSED')
