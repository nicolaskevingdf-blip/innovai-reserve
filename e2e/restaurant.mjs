// Phase 2 E2E: floor map, areas, table allocation, walk-in, waitlist.
// Usage: BASE_URL=http://localhost:5173 SUPABASE_URL=... SUPABASE_ANON_KEY=... node e2e/restaurant.mjs
import { createRequire } from 'node:module'
const { chromium } = createRequire(import.meta.url)('playwright')

const BASE = process.env.BASE_URL ?? 'http://localhost:5173'
const OUT = process.env.SHOTS ?? 'e2e/screenshots'
const stamp = Date.now().toString(36)
const slug = `bistro-${stamp}`
const log = (...a) => console.log('✓', ...a)
const rpc = async (fn, body) => (await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
  method: 'POST', headers: { apikey: process.env.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})).json()

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await ctx.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
const toast = (t) => page.waitForSelector(`text=${t}`)

// owner + restaurant
await page.goto(`${BASE}/cadastro`)
await page.getByLabel('Seu nome').fill('Bia Bistrô')
await page.getByLabel('E-mail').fill(`bia+${stamp}@example.com`)
await page.getByLabel('Senha').fill('senha-forte-123')
await page.getByRole('button', { name: 'Criar conta' }).click()
await page.waitForURL('**/onboarding')
await page.getByRole('button', { name: /Restaurante/ }).click()
await page.getByRole('button', { name: 'Continuar' }).click()
await page.getByPlaceholder(/Cantina Bella Vista/).fill('Bistrô Teste')
await page.locator('input[placeholder="seu-negocio"]').fill(slug)
await page.waitForSelector('svg.lucide-check')
await page.getByRole('button', { name: 'Criar estabelecimento' }).click()
await page.waitForURL('**/app/dashboard')
log('restaurant created')

// areas
await page.goto(`${BASE}/app/mesas`)
await page.waitForSelector('text=Monte seu salão')
await page.getByRole('button', { name: 'Editar salão' }).click()
await page.getByRole('button', { name: 'Ambientes e uniões' }).click()
for (const a of ['Salão', 'Varanda']) {
  await page.getByPlaceholder('Nome do ambiente').fill(a)
  await page.getByRole('button', { name: 'Adicionar', exact: true }).click()
  await page.locator('div[role=dialog]').getByText(`${a} · 0 mesas`).waitFor()
}
await page.keyboard.press('Escape')
log('areas created')

// tables
for (const [name, area, max] of [['S1', 'Salão', 2], ['S2', 'Salão', 4], ['V1', 'Varanda', 4]]) {
  await page.getByRole('button', { name: 'Mesa', exact: true }).click()
  const d = page.locator('div[role=dialog]')
  await d.getByLabel('Nome / número').fill(name)
  await d.getByLabel('Ambiente').selectOption({ label: area })
  await d.getByLabel('Máx. pessoas').fill(String(max))
  await d.getByRole('button', { name: 'Salvar' }).click()
  await toast('Mesa criada')
  await page.locator('div[role=dialog]').waitFor({ state: 'detached' })
}
log('3 tables created')

// drag S2 and save layout
const s2 = page.locator('button', { hasText: /^S2/ }).first()
const box = await s2.boundingBox()
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
await page.mouse.down()
await page.mouse.move(box.x + 260, box.y + 180, { steps: 10 })
await page.mouse.up()
await page.getByRole('button', { name: 'Salvar layout' }).click()
await toast('Layout do salão salvo')
log('layout dragged and saved')

// joined tables S1 + S2
await page.getByRole('button', { name: 'Editar salão' }).click()
await page.getByRole('button', { name: 'Ambientes e uniões' }).click()
const dlg = page.locator('div[role=dialog]')
await dlg.getByRole('button', { name: /^S1/ }).click()
await dlg.getByRole('button', { name: /^S2/ }).click()
await dlg.getByRole('button', { name: 'Criar união' }).click()
await toast('União criada')
await page.keyboard.press('Escape')
await page.getByRole('button', { name: 'Concluir' }).click()
log('joined tables S1+S2 configured')

// enable table allocation
await page.goto(`${BASE}/app/configuracoes?tab=regras`)
await page.getByRole('button', { name: /^Por mesa/ }).click()
await page.getByRole('button', { name: 'Salvar regras' }).first().click()
await toast('Regras atualizadas')
log('table allocation enabled')

// public booking with preferred area
const mob = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
const pub = await mob.newPage()
pub.on('pageerror', (e) => errors.push(e.message))
await pub.goto(`${BASE}/restaurante/${slug}`)
await pub.getByRole('button', { name: 'Continuar' }).click()
await pub.waitForSelector('text=Ambiente preferido')
await pub.screenshot({ path: `${OUT}/r1-public-area.png` })
await pub.getByRole('button', { name: /^Varanda/ }).click()
await pub.getByRole('button', { name: 'Ver horários' }).click()
await pub.waitForSelector('text=Somente horários realmente disponíveis')
await pub.locator('div.grid-cols-4 button').first().click()
await pub.getByRole('button', { name: 'Continuar' }).click()
await pub.getByLabel('Nome completo').fill('Carla Varanda')
await pub.getByLabel('Celular (WhatsApp)').fill('11966665555')
await pub.getByRole('button', { name: /Confirmar ·/ }).click()
await pub.waitForSelector('text=Reserva confirmada!')
await pub.waitForSelector('text=Varanda')
const code = (await pub.locator('span.font-mono').first().innerText()).trim()
const booked = await rpc('get_public_reservation', { p_code: code, p_phone: '11966665555' })
const tz = booked.tenant.timezone
const day = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(booked.starts_at))
const hhmm = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(new Date(booked.starts_at))
log('public booking in Varanda', code, day, hhmm)

// staff sees the allocated table
await page.goto(`${BASE}/app/reservas`)
await page.locator('tr', { hasText: code }).click()
await page.locator('div[role=dialog]').getByText('V1').waitFor()
await page.keyboard.press('Escape')
log('reservation allocated to table V1 (best fit in Varanda)')

// floor at reservation time → V1 "chegada aguardada"
await page.goto(`${BASE}/app/mesas`)
await page.locator('input[type=date]').fill(day)
await page.locator('input[type=time]').fill(hhmm)
const v1 = page.locator('button', { hasText: /^V1/ }).first()
await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent?.startsWith('V1') && b.className.includes('sky')))
await page.screenshot({ path: `${OUT}/r2-floor-arriving.png` })
log('floor map shows V1 as arrival expected (blue)')
await v1.click()
await page.locator('div[role=dialog]').getByText('Carla Varanda').first().waitFor()
await page.keyboard.press('Escape')

// walk-in now on S1, then free it
await page.getByRole('button', { name: 'Agora' }).click()
await page.locator('button', { hasText: /^S1/ }).first().click()
await page.getByRole('button', { name: /Sentar cliente agora/ }).click()
const ws = page.locator('div[role=dialog]')
await ws.getByPlaceholder('Nome').fill('Cliente Balcão')
await ws.getByPlaceholder('Telefone (para o CRM)').fill('11955554444')
await ws.getByRole('button', { name: 'Ocupar mesa' }).click()
await toast('Mesa S1 ocupada')
await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent?.startsWith('S1') && b.className.includes('rose')))
await page.screenshot({ path: `${OUT}/r3-floor-occupied.png` })
log('walk-in seated: S1 occupied (red)')
await page.locator('button', { hasText: /^S1/ }).first().click()
await page.getByRole('button', { name: 'Liberar mesa' }).click()
await toast('Mesa S1 liberada')
log('table freed')

// waitlist from the public page
await pub.goto(`${BASE}/restaurante/${slug}`)
await pub.getByRole('button', { name: 'Continuar' }).click()
await pub.getByRole('button', { name: /^Sem preferência/ }).click()
await pub.getByText('Entrar na lista de espera').first().click()
await pub.locator('input[type=date]').fill(day)
await pub.getByLabel('Nome completo').fill('Diego Espera')
await pub.getByLabel('Celular (WhatsApp)').fill('11944443333')
await pub.getByRole('button', { name: 'Entrar na lista de espera' }).click()
await pub.waitForSelector('text=Você está na lista!')
log('customer joined the waitlist')

await page.goto(`${BASE}/app/lista-espera`)
await page.locator('input[type=date]').fill(day)
await page.waitForSelector('text=Diego Espera')
const popup = page.waitForEvent('popup')
await page.getByRole('button', { name: 'Avisar' }).click()
await (await popup).close()
await page.waitForSelector('text=Avisado')
await page.screenshot({ path: `${OUT}/r4-waitlist.png` })
log('staff notified waitlist customer (WhatsApp link, entry marked)')

await page.goto(`${BASE}/app/dashboard`)
await page.waitForSelector('text=Salão agora')
await page.screenshot({ path: `${OUT}/r5-dashboard.png` })
log('dashboard shows live floor summary')

await browser.close()
if (errors.length) { console.error('Browser errors:\n' + errors.join('\n')); process.exit(1) }
console.log('\nRESTAURANT E2E PASSED')
