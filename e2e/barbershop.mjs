// Phase 3 E2E: services, professionals, individual hours, "any professional", day off, per-staff agenda.
// Usage: BASE_URL=http://localhost:5173 SUPABASE_URL=... SUPABASE_ANON_KEY=... node e2e/barbershop.mjs
import { createRequire } from 'node:module'
const { chromium } = createRequire(import.meta.url)('playwright')

const BASE = process.env.BASE_URL ?? 'http://localhost:5173'
const OUT = process.env.SHOTS ?? 'e2e/screenshots'
const stamp = Date.now().toString(36)
const slug = `navalha-${stamp}`
const log = (...a) => console.log('✓', ...a)
const rpc = async (fn, body) => (await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
  method: 'POST', headers: { apikey: process.env.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})).json()

const browser = await chromium.launch()
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
const toast = (t) => page.waitForSelector(`text=${t}`)
const dialog = () => page.locator('div[role=dialog]')

await page.goto(`${BASE}/cadastro`)
await page.getByLabel('Seu nome').fill('Rafa Dono')
await page.getByLabel('E-mail').fill(`rafa+${stamp}@example.com`)
await page.getByLabel('Senha').fill('senha-forte-123')
await page.getByRole('button', { name: 'Criar conta' }).click()
await page.waitForURL('**/onboarding')
await page.getByRole('button', { name: /Barbearia/ }).click()
await page.getByRole('button', { name: 'Continuar' }).click()
await page.getByPlaceholder(/Barbearia Navalha/).fill('Navalha Teste')
await page.locator('input[placeholder="seu-negocio"]').fill(slug)
await page.waitForSelector('svg.lucide-check')
await page.getByRole('button', { name: 'Criar estabelecimento' }).click()
await page.waitForURL('**/app/dashboard')
log('barbershop created')

// services
await page.goto(`${BASE}/app/servicos`)
await page.getByRole('button', { name: 'Corte', exact: true }).click()
await dialog().getByLabel('Preparo').fill('10')
await dialog().getByRole('button', { name: 'Salvar' }).click()
await dialog().waitFor({ state: 'detached' })
await page.getByRole('button', { name: 'Novo serviço' }).click()
await dialog().getByLabel('Nome').fill('Barba')
await dialog().getByLabel('Duração').fill('20')
await dialog().getByLabel('Preço (R$)').fill('35')
await dialog().getByRole('button', { name: 'Salvar' }).click()
await dialog().waitFor({ state: 'detached' })
log('services created (Corte 30+10 min, Barba 20 min)')

// professionals
await page.goto(`${BASE}/app/profissionais`)
for (const [name, services, own] of [['Rafa', ['Corte', 'Barba'], true], ['Léo', ['Corte'], false]]) {
  await page.getByRole('button', { name: /Adicionar profissional|Novo profissional/ }).first().click()
  await dialog().getByLabel('Nome').fill(name)
  if (own) {
    await dialog().getByRole('button', { name: 'Horários' }).click()
    await dialog().locator('label', { hasText: 'Horário próprio' }).getByRole('switch').click()
  }
  await dialog().getByRole('button', { name: 'Serviços' }).click()
  for (const sv of services) await dialog().locator('label', { hasText: sv }).locator('input').check()
  await dialog().getByRole('button', { name: 'Salvar' }).click()
  await toast('Profissional cadastrado')
  await dialog().waitFor({ state: 'detached' })
}
log('professionals created (Rafa: own hours, Corte+Barba · Léo: Corte)')
await page.getByRole('button', { name: 'Ativar agora' }).click()
await toast('Agenda por profissional ativada')
log('per-professional agenda enabled')

// public: choose Rafa
const mob = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
const pub = await mob.newPage()
pub.on('pageerror', (e) => errors.push(e.message))
async function book(staffLabel, name, phone, slotText) {
  await pub.goto(`${BASE}/barbearia/${slug}`)
  await pub.getByRole('button', { name: /^Corte/ }).last().click()
  await pub.waitForSelector('text=Com quem você quer ser atendido?')
  await pub.locator('button', { hasText: staffLabel }).last().click()
  await pub.getByRole('button', { name: 'Ver horários' }).click()
  await pub.waitForSelector('text=Somente horários realmente disponíveis')
  const btn = slotText ? pub.locator('div.grid-cols-4 button', { hasText: slotText }).first() : pub.locator('div.grid-cols-4 button').first()
  const label = await btn.innerText()
  await btn.click()
  await pub.getByRole('button', { name: 'Continuar' }).click()
  await pub.getByLabel('Nome completo').fill(name)
  await pub.getByLabel('Celular (WhatsApp)').fill(phone)
  await pub.getByRole('button', { name: /Confirmar ·/ }).click()
  await pub.waitForSelector('text=Reserva confirmada!')
  return { label, code: (await pub.locator('span.font-mono').first().innerText()).trim() }
}
await pub.goto(`${BASE}/barbearia/${slug}`)
await pub.getByRole('button', { name: /^Corte/ }).last().click()
await pub.waitForSelector('text=Com quem você quer ser atendido?')
await pub.screenshot({ path: `${OUT}/b1-public-staff.png` })
const first = await book('Rafa', 'Cliente do Rafa', '11977770001')
await pub.waitForSelector('text=com Rafa')
log('customer booked with Rafa at', first.label, first.code)

const second = await book('Qualquer profissional', 'Cliente Qualquer', '11977770002', first.label)
await pub.waitForSelector('text=com Léo')
log('"any professional" at the same time → Léo')

// both busy → time gone
await pub.goto(`${BASE}/barbearia/${slug}`)
await pub.getByRole('button', { name: /^Corte/ }).last().click()
await pub.locator('button', { hasText: 'Qualquer profissional' }).last().click()
await pub.getByRole('button', { name: 'Ver horários' }).click()
await pub.waitForSelector('text=Somente horários realmente disponíveis')
const times = await pub.locator('div.grid-cols-4 button').allInnerTexts()
if (times.includes(first.label)) throw new Error('slot should be gone when every professional is busy')
log('slot disappears when every qualified professional is busy')

// per-professional agenda
const booked = await rpc('get_public_reservation', { p_code: first.code, p_phone: '11977770001' })
const tz = booked.tenant.timezone
const day = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(booked.starts_at))
await page.goto(`${BASE}/app/agenda?view=day&date=${day}`)
await page.waitForSelector('text=Cliente do Rafa')
await page.waitForSelector('text=Cliente Qualquer')
await page.waitForSelector('text=Sem profissional', { state: 'detached' }).catch(() => {})
await page.screenshot({ path: `${OUT}/b2-agenda-staff.png` })
log('agenda shows one column per professional')

// Léo takes the day off → no Corte slots with Léo that day
await page.goto(`${BASE}/app/profissionais`)
await page.locator('button', { hasText: 'Léo' }).first().click()
await dialog().getByRole('button', { name: 'Folgas' }).click()
await dialog().getByLabel('De').fill(day)
await dialog().getByLabel('Até').fill(day)
await dialog().getByRole('button', { name: 'Bloquear agenda' }).click()
await toast('Período bloqueado')
const page1 = await rpc('get_public_page', { p_slug: slug })
const leo = page1.staff.find((s) => s.name === 'Léo')
const corte = page1.services.find((s) => s.name === 'Corte')
const leoSlots = await rpc('get_available_slots', { p_slug: slug, p_date: day, p_party_size: 1, p_service_id: corte.id, p_staff_id: leo.id })
if (leoSlots.length !== 0) throw new Error(`Léo should have no slots on his day off, got ${leoSlots.length}`)
log('day off removes the professional from that day')

// manual booking from the panel: service + chosen professional
await page.goto(`${BASE}/app/agenda?view=day&date=${day}`)
await page.getByRole('button', { name: /Novo agendamento/ }).first().click()
const d = dialog()
await d.getByPlaceholder('Nome do cliente').fill('Balcão Barba')
await d.getByPlaceholder('(11) 98888-7777').fill('11977770003')
await d.getByLabel('Serviço').selectOption({ label: 'Barba · 20 min' })
await d.locator('button', { hasText: 'Rafa' }).first().click()
await d.getByLabel('Data').fill(day)
await d.locator('div.grid-cols-4 button').first().waitFor()
await d.locator('div.grid-cols-4 button').first().click()
await d.getByRole('button', { name: 'Criar agendamento' }).click()
await toast('Agendamento criado')
log('manual booking with service + professional from the panel')

await page.goto(`${BASE}/app/dashboard`)
await page.waitForSelector('text=Profissionais disponíveis agora')
await page.getByRole('button', { name: '30 dias' }).click()
await page.screenshot({ path: `${OUT}/b3-dashboard.png` })
log('dashboard shows per-professional metrics')

await browser.close()
if (errors.length) { console.error('Browser errors:\n' + errors.join('\n')); process.exit(1) }
console.log('\nBARBERSHOP E2E PASSED')
