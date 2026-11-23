// End-to-end smoke test against a running app + Supabase.
// Usage: BASE_URL=http://localhost:5173 SUPABASE_URL=... SUPABASE_ANON_KEY=... node e2e/smoke.mjs   (requires `playwright`)
import { createRequire } from 'node:module'
const { chromium } = createRequire(import.meta.url)('playwright')

const BASE = process.env.BASE_URL ?? 'http://localhost:5173'
const OUT = process.env.SHOTS ?? 'e2e/screenshots'
const stamp = Date.now().toString(36)
const email = `owner+${stamp}@example.com`
const slug = `cantina-${stamp}`
const log = (...a) => console.log('✓', ...a)

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await ctx.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => { if (m.type() === 'error' && !/realtime|websocket|WebSocket/i.test(m.text())) errors.push(m.text()) })

// 1. Sign up
await page.goto(`${BASE}/cadastro`)
await page.getByLabel('Seu nome').fill('Marina Proprietária')
await page.getByLabel('E-mail').fill(email)
await page.getByLabel('Senha').fill('senha-forte-123')
await page.getByRole('button', { name: 'Criar conta' }).click()
await page.waitForURL('**/onboarding')
log('signup →', page.url())

// 2. Onboarding (restaurant)
await page.getByRole('button', { name: /Restaurante/ }).click()
await page.getByRole('button', { name: 'Continuar' }).click()
await page.getByPlaceholder(/Cantina Bella Vista/).fill('Cantina Teste')
await page.locator('input[placeholder="seu-negocio"]').fill(slug)
await page.waitForSelector('svg.lucide-check', { timeout: 10000 })
await page.getByRole('button', { name: 'Criar estabelecimento' }).click()
await page.waitForURL('**/app/dashboard')
await page.waitForSelector('text=Agenda de hoje')
await page.screenshot({ path: `${OUT}/01-dashboard-empty.png` })
log('tenant created, dashboard loaded')

// 3. Public booking (mobile, anonymous)
const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
const pub = await mobile.newPage()
pub.on('pageerror', (e) => errors.push(e.message))
await pub.goto(`${BASE}/restaurante/${slug}`)
await pub.waitForSelector('text=Reserve sua mesa')
await pub.screenshot({ path: `${OUT}/02-public-page.png` })
await pub.getByRole('button', { name: 'Continuar' }).click()            // party = 2
await pub.getByRole('button', { name: 'Ver horários' }).click()          // first available day auto-selected
await pub.waitForSelector('text=Somente horários realmente disponíveis')
const firstSlot = pub.locator('div.grid-cols-4 button').first()
const slotLabel = await firstSlot.innerText()
await firstSlot.click()
await pub.screenshot({ path: `${OUT}/03-public-slots.png` })
await pub.getByRole('button', { name: 'Continuar' }).click()
await pub.getByLabel('Nome completo').fill('João da Silva')
await pub.getByLabel('Celular (WhatsApp)').fill('11988887777')
await pub.getByLabel('E-mail (opcional)').fill('joao@example.com')
await pub.getByRole('button', { name: /Confirmar ·/ }).click()
await pub.waitForSelector('text=Reserva confirmada!')
const code = (await pub.locator('span.font-mono').first().innerText()).trim()
// read back through the public RPC to get the local date of the reservation
const rpc = async (fn, body) => (await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
  method: 'POST', headers: { apikey: process.env.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})).json()
const booked = await rpc('get_public_reservation', { p_code: code, p_phone: '11988887777' })
const publicDay = new Intl.DateTimeFormat('en-CA', { timeZone: booked.tenant.timezone }).format(new Date(booked.starts_at))
await pub.screenshot({ path: `${OUT}/04-public-confirmed.png` })
log('public reservation', code, 'at', slotLabel)

// 4. Same customer tries to book the same slot again → must be blocked
await pub.goto(`${BASE}/restaurante/${slug}`)
await pub.getByRole('button', { name: 'Continuar' }).click()
await pub.getByRole('button', { name: 'Ver horários' }).click()
await pub.waitForSelector('text=Somente horários realmente disponíveis')
await pub.locator('div.grid-cols-4 button', { hasText: slotLabel }).first().click()
await pub.getByRole('button', { name: 'Continuar' }).click()
await pub.getByLabel('Nome completo').fill('João da Silva')
await pub.getByLabel('Celular (WhatsApp)').fill('11988887777')
await pub.getByRole('button', { name: /Confirmar ·/ }).click()
await pub.waitForSelector('text=já tem uma reserva que coincide')
log('duplicate booking blocked for same customer')

// 5. Lookup + reschedule-ready view
// a fresh device must use code + phone (the booking device remembers it via sessionStorage)
const fresh = await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })).newPage()
await fresh.goto(`${BASE}/reserva`)
await fresh.getByPlaceholder('EX: K7M2QXA').fill(code)
await fresh.getByPlaceholder('(11) 98888-7777').fill('11900000000')
await fresh.getByRole('button', { name: 'Consultar' }).click()
await fresh.waitForSelector('text=Reserva não encontrada')
log('wrong phone cannot open the reservation')
await fresh.getByPlaceholder('(11) 98888-7777').fill('(11) 98888-7777')
await fresh.getByRole('button', { name: 'Consultar' }).click()
await fresh.waitForSelector(`text=#${code}`)
await pub.goto(`${BASE}/reserva/${code}`)
await pub.waitForSelector(`text=#${code}`)
await pub.screenshot({ path: `${OUT}/05-lookup.png` })
log('lookup by code + phone works')

// 6. Back office sees it (dashboard, agenda, reservations, CRM)
await page.goto(`${BASE}/app/reservas`)
await page.waitForSelector(`text=${code}`)
await page.screenshot({ path: `${OUT}/06-reservations.png` })
log('reservation listed in back office')
await page.locator('tr', { hasText: code }).click()
await page.waitForSelector('text=Histórico')
await page.waitForSelector('text=Reserva criada')
await page.screenshot({ path: `${OUT}/07-reservation-detail.png` })
await page.keyboard.press('Escape')
log('detail + history visible')

await page.goto(`${BASE}/app/clientes`)
await page.waitForSelector('text=João da Silva')
log('CRM customer auto-created')

// 7. Manual reservation from the panel (on the same day/slot grid the customer used)
await page.goto(`${BASE}/app/agenda`)
await page.getByRole('button', { name: /Nova reserva/ }).first().click()
const dialog = page.locator('div[role=dialog]')
await dialog.getByPlaceholder('Nome do cliente').fill('Paula Souza')
await dialog.getByPlaceholder('(11) 98888-7777').fill('11977776666')
await dialog.getByLabel('Data').fill(publicDay)
await dialog.locator('div.grid-cols-4 button').last().waitFor()
await dialog.locator('div.grid-cols-4 button').last().click()
await dialog.getByRole('button', { name: 'Criar reserva' }).click()
await page.waitForSelector('text=Reserva criada')
log('manual reservation created from the panel')

await page.goto(`${BASE}/app/agenda?view=week`)
await page.waitForSelector('text=Semana')
await page.screenshot({ path: `${OUT}/08-agenda-week.png` })
await page.goto(`${BASE}/app/dashboard`)
await page.waitForSelector('text=Agenda de hoje')
await page.waitForTimeout(800)
await page.screenshot({ path: `${OUT}/09-dashboard.png` })
await page.goto(`${BASE}/app/configuracoes?tab=horarios`)
await page.waitForSelector('text=Horário de funcionamento')
await page.getByRole('button', { name: 'Adicionar turno' }).first().click()   // Monday: add 09:00–18:00
await page.getByRole('button', { name: 'Salvar horários' }).click()
await page.waitForSelector('text=Horários salvos')
await page.screenshot({ path: `${OUT}/10-settings-hours.png` })
log('weekly schedule saved (atomic RPC)')

// logo upload → Supabase Storage (tenant-scoped policy)
await page.goto(`${BASE}/app/configuracoes?tab=marca`)
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64')
await page.locator('input[type=file]').first().setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: png })
await page.waitForSelector('text=Logo atualizado')
log('logo uploaded to storage')

// 8. Customer cancels online → status cancelled
await pub.getByRole('button', { name: 'Cancelar' }).click()
await pub.getByRole('button', { name: 'Sim, cancelar' }).click()
await pub.waitForSelector('text=Cancelada')
log('customer cancelled online')

await page.goto(`${BASE}/app/notificacoes`)
await page.waitForSelector('text=Reserva cancelada pelo cliente')
log('owner notified in-app (new + cancelled)')

await browser.close()
if (errors.length) { console.error('Browser errors:\n' + errors.join('\n')); process.exit(1) }
console.log('\nE2E SMOKE PASSED')
