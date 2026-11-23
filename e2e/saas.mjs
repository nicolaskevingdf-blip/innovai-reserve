// Phase 4 E2E: Innovai admin sells a customer, plan limits in the UI, support round-trip.
// Needs DATABASE_URL (to grant the first platform admin, as an operator would do once).
// Usage: BASE_URL=... DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres node e2e/saas.mjs
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
const { chromium } = createRequire(import.meta.url)('playwright')

const BASE = process.env.BASE_URL ?? 'http://localhost:5173'
const DB = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
const OUT = process.env.SHOTS ?? 'e2e/screenshots'
const stamp = Date.now().toString(36)
const adminEmail = `ops+${stamp}@innovai.test`
const ownerEmail = `dono+${stamp}@cliente.test`
const log = (...a) => console.log('✓', ...a)
const sql = (q) => execFileSync('psql', [DB, '-qtAc', q]).toString().trim()

const browser = await chromium.launch()
const errors = []
async function signup(email, name) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(`${BASE}/cadastro`)
  await page.getByLabel('Seu nome').fill(name)
  await page.getByLabel('E-mail').fill(email)
  await page.getByLabel('Senha').fill('senha-forte-123')
  await page.getByRole('button', { name: 'Criar conta' }).click()
  return page
}

// 1. Innovai operator account, promoted once via SQL (documented in the README)
const admin = await signup(adminEmail, 'Operações Innovai')
await admin.waitForURL('**/onboarding')
sql(`insert into public.platform_admins (user_id) select id from auth.users where email = '${adminEmail}'`)
await admin.goto(`${BASE}/admin`)
await admin.waitForSelector('text=Visão geral da plataforma')
await admin.screenshot({ path: `${OUT}/s1-admin-overview.png` })
log('Innovai admin panel opens')

// 2. Innovai sells a Starter plan to a restaurant
await admin.goto(`${BASE}/admin/empresas`)
await admin.getByRole('button', { name: 'Nova empresa' }).click()
const d = admin.locator('div[role=dialog]')
await d.getByLabel('Nome comercial').fill(`Trattoria ${stamp}`)
await d.getByLabel('E-mail do proprietário').fill(ownerEmail)
await d.getByLabel('Plano', { exact: true }).selectOption('starter')
await d.getByLabel('Dias de teste').fill('0')
await d.getByRole('button', { name: 'Criar empresa' }).click()
await admin.waitForSelector('text=Empresa criada')
await admin.waitForSelector(`text=Trattoria ${stamp}`)
await admin.screenshot({ path: `${OUT}/s2-admin-tenants.png` })
log('admin created the establishment with an owner invitation')

// 3. Customer signs up with the invited e-mail → lands straight in the panel
const owner = await signup(ownerEmail, 'Dona Trattoria')
await owner.waitForURL('**/app/dashboard')
await owner.waitForSelector(`text=Trattoria ${stamp}`)
log('owner joined automatically (no onboarding)')

// 4. Plan usage + feature gate
await owner.goto(`${BASE}/app/plano`)
await owner.waitForSelector('text=Plano atual')
await owner.waitForSelector('text=Mesas + profissionais')
await owner.screenshot({ path: `${OUT}/s3-plan.png` })
await owner.goto(`${BASE}/app/configuracoes?tab=regras`)
await owner.waitForSelector('text=Disponível a partir do plano Pro')
if (await owner.getByRole('button', { name: /^Por mesa/ }).isEnabled()) throw new Error('table mode should be locked on Starter')
log('Starter: table/professional modes locked in the UI')

// 5. Upgrade request → support ticket → Innovai replies → upgrade applied
await owner.goto(`${BASE}/app/plano`)
await owner.getByRole('button', { name: 'Solicitar upgrade' }).first().click()
await owner.locator('div[role=dialog]').getByRole('button', { name: 'Enviar' }).click()
await owner.waitForSelector('text=Chamado aberto')
log('owner requested an upgrade (support ticket)')

await admin.goto(`${BASE}/admin/suporte`)
await admin.locator('button', { hasText: `Trattoria ${stamp}` }).first().click()
await admin.locator('div[role=dialog] textarea').fill('Upgrade liberado! Bom proveito.')
await admin.getByRole('button', { name: 'Enviar' }).click()
await admin.waitForSelector('p.whitespace-pre-wrap:has-text("Upgrade liberado! Bom proveito.")')
await admin.keyboard.press('Escape')
await admin.goto(`${BASE}/admin/empresas`)
await admin.getByText(`Trattoria ${stamp}`).click()
await admin.locator('div[role=dialog]').getByLabel('Plano', { exact: true }).selectOption('pro')
await admin.getByRole('button', { name: 'Salvar alterações' }).click()
await admin.waitForSelector('text=Empresa atualizada')
log('Innovai replied and moved the customer to Pro')

await owner.goto(`${BASE}/app/suporte`)
await owner.getByRole('button', { name: /Mudança para o plano/ }).first().click()
await owner.waitForSelector('p.whitespace-pre-wrap:has-text("Upgrade liberado! Bom proveito.")')
await owner.keyboard.press('Escape')
await owner.goto(`${BASE}/app/configuracoes?tab=regras`)
await owner.waitForSelector('text=Por mesa')
await owner.waitForFunction(() => ![...document.querySelectorAll('span')].some((s) => s.textContent?.includes('Disponível a partir do plano Pro')))
log('customer sees the reply and the unlocked features')

await browser.close()
if (errors.length) { console.error('Browser errors:\n' + errors.join('\n')); process.exit(1) }
console.log('\nSAAS E2E PASSED')
