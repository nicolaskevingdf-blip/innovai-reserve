import { useEffect, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Building2, Clock, Copy, ExternalLink, ImagePlus, Bell, Palette, Plus, ShieldCheck, SlidersHorizontal, Trash2, Users, Mail, MessageCircle, Smartphone, Info } from 'lucide-react'
import { useCurrentTenant } from '@/hooks/useTenant'
import {
  uploadTenantAsset, useBookingSettings, useBusinessHours, useInvitations, useNotificationSettings, useSaveBusinessHours, useTeam,
  useTeamMutations, useUpdateBookingSettings, useUpdateNotificationSettings, useUpdateTenant,
} from '@/api/tenant'
import { publicBookingUrl } from '@/components/layout/AppShell'
import { useTables } from '@/api/floor'
import { useStaff } from '@/api/staff'
import { Link } from 'react-router-dom'
import { Avatar, Button, Card, Field, Input, PageLoader, Select, Switch, Textarea } from '@/components/ui/ui'
import { ConfirmDialog } from '@/components/ui/Sheet'
import { useToast } from '@/components/ui/Toast'
import { TIMEZONES, WEEKDAYS } from '@/lib/datetime'
import { ROLE, SEGMENT } from '@/lib/constants'
import { errorMessage } from '@/lib/errors'
import { cn, formatPhone, isValidEmail, readableOn } from '@/lib/utils'
import type { BookingSettings, MemberRole, NotificationSettings, Segment, Tenant } from '@/types/db'

const TABS = [
  { id: 'negocio', label: 'Estabelecimento', icon: Building2 },
  { id: 'marca', label: 'Identidade visual', icon: Palette },
  { id: 'horarios', label: 'Horários', icon: Clock },
  { id: 'regras', label: 'Regras de reserva', icon: SlidersHorizontal },
  { id: 'equipe', label: 'Equipe e acessos', icon: Users },
  { id: 'notificacoes', label: 'Notificações', icon: Bell },
] as const
type TabId = (typeof TABS)[number]['id']

export default function Settings() {
  const [params, setParams] = useSearchParams()
  const tab = (params.get('tab') as TabId) || 'negocio'
  const { isManager } = useCurrentTenant()

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold md:text-3xl">Configurações</h1>
        <p className="mt-1 text-sm text-ink-400">Personalize seu estabelecimento, sua página pública e as regras da agenda.</p>
      </div>
      {!isManager && (
        <div className="flex items-center gap-2 rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-sm text-amber-200">
          <ShieldCheck className="h-4 w-4" /> Você está como funcionário: as configurações são somente leitura.
        </div>
      )}
      <div className="grid gap-6 lg:grid-cols-[220px_1fr]">
        <nav className="-mx-4 flex gap-1 overflow-x-auto px-4 lg:mx-0 lg:flex-col lg:px-0">
          {TABS.map((t) => (
            <button key={t.id} onClick={() => setParams({ tab: t.id })}
              className={cn('flex shrink-0 items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm font-medium transition',
                tab === t.id ? 'bg-ink-800 text-ink-50' : 'text-ink-400 hover:bg-ink-850 hover:text-ink-100')}>
              <t.icon className={cn('h-4 w-4', tab === t.id && 'text-lime')} /> {t.label}
            </button>
          ))}
        </nav>
        <div className="min-w-0">
          <fieldset disabled={!isManager} className="min-w-0 disabled:opacity-80">
            {tab === 'negocio' && <BusinessTab />}
            {tab === 'marca' && <BrandTab />}
            {tab === 'horarios' && <HoursTab />}
            {tab === 'regras' && <RulesTab />}
            {tab === 'equipe' && <TeamTab />}
            {tab === 'notificacoes' && <NotificationsTab />}
          </fieldset>
        </div>
      </div>
    </div>
  )
}

function Section({ title, description, children, footer }: { title: string; description?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <Card className="mb-6">
      <div className="border-b border-ink-800 px-5 py-4 md:px-6">
        <h2 className="text-base font-semibold">{title}</h2>
        {description && <p className="mt-0.5 text-sm text-ink-400">{description}</p>}
      </div>
      <div className="px-5 py-5 md:px-6">{children}</div>
      {footer && <div className="flex justify-end gap-2 border-t border-ink-800 px-5 py-3 md:px-6">{footer}</div>}
    </Card>
  )
}

function useTenantForm() {
  const { tenant } = useCurrentTenant()
  const [form, setForm] = useState<Tenant>(tenant)
  useEffect(() => setForm(tenant), [tenant])
  const set = <K extends keyof Tenant>(k: K, v: Tenant[K]) => setForm((f) => ({ ...f, [k]: v }))
  return { tenant, form, set }
}

/* ----------------------------- Business ----------------------------- */
function BusinessTab() {
  const { tenant, form, set } = useTenantForm()
  const update = useUpdateTenant()
  const toast = useToast()
  const url = publicBookingUrl(form.segment, tenant.slug)

  const save = async () => {
    if (form.name.trim().length < 2) return toast('error', 'Informe o nome do estabelecimento')
    if (form.email && !isValidEmail(form.email)) return toast('error', 'E-mail inválido')
    try {
      await update.mutateAsync({ id: tenant.id, patch: {
        name: form.name.trim(), segment: form.segment, timezone: form.timezone, description: form.description || null,
        phone: form.phone || null, whatsapp: form.whatsapp || null, email: form.email || null, website: form.website || null,
        instagram: form.instagram?.replace(/^@/, '') || null, facebook: form.facebook || null,
        address_line: form.address_line || null, address_number: form.address_number || null, address_complement: form.address_complement || null,
        neighborhood: form.neighborhood || null, city: form.city || null, state: form.state || null, postal_code: form.postal_code || null,
      } })
      toast('success', 'Informações salvas')
    } catch (e) { toast('error', 'Erro ao salvar', errorMessage(e)) }
  }
  const footer = <Button onClick={save} loading={update.isPending}>Salvar alterações</Button>

  return (
    <>
      <Section title="Link de reservas" description="Compartilhe no Instagram, Google Maps e WhatsApp.">
        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="flex h-11 flex-1 items-center truncate rounded-xl border border-ink-600 bg-ink-850 px-3.5 font-mono text-sm text-lime">{url}</div>
          <Button variant="secondary" onClick={() => { void navigator.clipboard.writeText(url); toast('success', 'Link copiado') }}><Copy className="h-4 w-4" /> Copiar</Button>
          <a href={url} target="_blank" rel="noreferrer" className="inline-flex h-10 items-center justify-center gap-2 rounded-xl border border-ink-600 px-4 text-sm font-semibold hover:border-lime/50"><ExternalLink className="h-4 w-4" /> Abrir</a>
        </div>
        <p className="mt-2 text-xs text-ink-500">O endereço (slug) <b className="text-ink-300">{tenant.slug}</b> é fixo para não quebrar links já divulgados. Para alterar, fale com o suporte Innovai.</p>
      </Section>

      <Section title="Dados do estabelecimento" footer={footer}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nome comercial" className="sm:col-span-2"><Input value={form.name} onChange={(e) => set('name', e.target.value)} /></Field>
          <Field label="Segmento">
            <Select value={form.segment} onChange={(e) => set('segment', e.target.value as Segment)}>
              {(Object.keys(SEGMENT) as Segment[]).map((s) => <option key={s} value={s}>{SEGMENT[s].label}</option>)}
            </Select>
          </Field>
          <Field label="Fuso horário">
            <Select value={form.timezone} onChange={(e) => set('timezone', e.target.value)}>
              {TIMEZONES.map((z) => <option key={z} value={z}>{z.replace('America/', '').replace('_', ' ')}</option>)}
            </Select>
          </Field>
          <Field label="Descrição" hint="aparece na página pública" className="sm:col-span-2">
            <Textarea value={form.description ?? ''} onChange={(e) => set('description', e.target.value)} maxLength={2000} placeholder="Conte sobre a experiência, especialidades, ambiente…" />
          </Field>
        </div>
      </Section>

      <Section title="Contato e redes sociais" footer={footer}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Telefone"><Input value={form.phone ?? ''} onChange={(e) => set('phone', formatPhone(e.target.value))} inputMode="tel" /></Field>
          <Field label="WhatsApp"><Input value={form.whatsapp ?? ''} onChange={(e) => set('whatsapp', formatPhone(e.target.value))} inputMode="tel" /></Field>
          <Field label="E-mail"><Input value={form.email ?? ''} onChange={(e) => set('email', e.target.value)} type="email" /></Field>
          <Field label="Site"><Input value={form.website ?? ''} onChange={(e) => set('website', e.target.value)} placeholder="https://" /></Field>
          <Field label="Instagram"><Input value={form.instagram ?? ''} onChange={(e) => set('instagram', e.target.value)} placeholder="@seuperfil" /></Field>
          <Field label="Facebook"><Input value={form.facebook ?? ''} onChange={(e) => set('facebook', e.target.value)} placeholder="facebook.com/…" /></Field>
        </div>
      </Section>

      <Section title="Endereço" footer={footer}>
        <div className="grid gap-4 sm:grid-cols-6">
          <Field label="CEP" className="sm:col-span-2"><Input value={form.postal_code ?? ''} onChange={(e) => set('postal_code', e.target.value)} inputMode="numeric" /></Field>
          <Field label="Rua / Avenida" className="sm:col-span-4"><Input value={form.address_line ?? ''} onChange={(e) => set('address_line', e.target.value)} /></Field>
          <Field label="Número" className="sm:col-span-2"><Input value={form.address_number ?? ''} onChange={(e) => set('address_number', e.target.value)} /></Field>
          <Field label="Complemento" className="sm:col-span-4"><Input value={form.address_complement ?? ''} onChange={(e) => set('address_complement', e.target.value)} /></Field>
          <Field label="Bairro" className="sm:col-span-2"><Input value={form.neighborhood ?? ''} onChange={(e) => set('neighborhood', e.target.value)} /></Field>
          <Field label="Cidade" className="sm:col-span-3"><Input value={form.city ?? ''} onChange={(e) => set('city', e.target.value)} /></Field>
          <Field label="UF" className="sm:col-span-1"><Input value={form.state ?? ''} maxLength={2} onChange={(e) => set('state', e.target.value.toUpperCase())} /></Field>
        </div>
      </Section>
    </>
  )
}

/* ------------------------------ Brand ------------------------------- */
const PRESET_COLORS = ['#C6F432', '#22D3EE', '#F59E0B', '#F43F5E', '#A78BFA', '#10B981', '#E5E7EB', '#D4AF37']

function BrandTab() {
  const { tenant, form, set } = useTenantForm()
  const update = useUpdateTenant()
  const toast = useToast()
  const [uploading, setUploading] = useState<'logo' | 'cover' | null>(null)

  const upload = async (kind: 'logo' | 'cover', file?: File) => {
    if (!file) return
    setUploading(kind)
    try {
      const url = await uploadTenantAsset(tenant.id, file, kind)
      await update.mutateAsync({ id: tenant.id, patch: kind === 'logo' ? { logo_url: url } : { cover_url: url } })
      toast('success', kind === 'logo' ? 'Logo atualizado' : 'Capa atualizada')
    } catch (e) { toast('error', 'Falha no upload', errorMessage(e)) }
    finally { setUploading(null) }
  }

  return (
    <>
      <Section title="Logo e capa" description="PNG, JPG, WEBP ou SVG até 5 MB. Armazenados no Supabase Storage.">
        <div className="grid gap-5 sm:grid-cols-[160px_1fr]">
          <label className="group relative grid aspect-square cursor-pointer place-items-center overflow-hidden rounded-2xl border border-dashed border-ink-600 bg-ink-850 hover:border-lime/50">
            {form.logo_url ? <img src={form.logo_url} alt="Logo" className="h-full w-full object-cover" /> : (
              <span className="flex flex-col items-center gap-2 text-xs text-ink-400"><ImagePlus className="h-6 w-6" /> Logo</span>
            )}
            {uploading === 'logo' && <span className="absolute inset-0 grid place-items-center bg-black/60 text-xs">Enviando…</span>}
            <input type="file" accept="image/*" className="hidden" onChange={(e) => upload('logo', e.target.files?.[0])} />
          </label>
          <label className="group relative grid aspect-[3/1] cursor-pointer place-items-center overflow-hidden rounded-2xl border border-dashed border-ink-600 bg-ink-850 hover:border-lime/50 sm:aspect-auto">
            {form.cover_url ? <img src={form.cover_url} alt="Capa" className="h-full w-full object-cover" /> : (
              <span className="flex flex-col items-center gap-2 text-xs text-ink-400"><ImagePlus className="h-6 w-6" /> Imagem de capa (1600×600 recomendado)</span>
            )}
            {uploading === 'cover' && <span className="absolute inset-0 grid place-items-center bg-black/60 text-xs">Enviando…</span>}
            <input type="file" accept="image/*" className="hidden" onChange={(e) => upload('cover', e.target.files?.[0])} />
          </label>
        </div>
        {(form.logo_url || form.cover_url) && (
          <div className="mt-3 flex gap-3 text-xs">
            {form.logo_url && <button className="text-ink-400 hover:text-rose-300" onClick={() => update.mutate({ id: tenant.id, patch: { logo_url: null } })}>Remover logo</button>}
            {form.cover_url && <button className="text-ink-400 hover:text-rose-300" onClick={() => update.mutate({ id: tenant.id, patch: { cover_url: null } })}>Remover capa</button>}
          </div>
        )}
      </Section>

      <Section title="Cor da marca" description="Usada nos botões e destaques da sua página de reservas."
        footer={<Button loading={update.isPending} onClick={async () => {
          try { await update.mutateAsync({ id: tenant.id, patch: { brand_color: form.brand_color } }); toast('success', 'Cor atualizada') }
          catch (e) { toast('error', 'Erro', errorMessage(e)) }
        }}>Salvar cor</Button>}>
        <div className="flex flex-wrap items-center gap-3">
          {PRESET_COLORS.map((c) => (
            <button key={c} onClick={() => set('brand_color', c)} style={{ background: c }}
              className={cn('h-10 w-10 rounded-xl ring-offset-2 ring-offset-ink-900 transition', form.brand_color.toUpperCase() === c && 'ring-2 ring-white')} />
          ))}
          <label className="flex h-10 items-center gap-2 rounded-xl border border-ink-600 bg-ink-850 px-2">
            <input type="color" value={form.brand_color} onChange={(e) => set('brand_color', e.target.value.toUpperCase())} className="h-7 w-7 cursor-pointer rounded bg-transparent" />
            <span className="font-mono text-xs">{form.brand_color}</span>
          </label>
        </div>
        <div className="mt-6 overflow-hidden rounded-2xl border border-ink-700">
          <div className="h-24 bg-cover bg-center" style={{ backgroundImage: form.cover_url ? `url(${form.cover_url})` : `linear-gradient(135deg, ${form.brand_color}33, #0B0B0D)` }} />
          <div className="flex items-center gap-3 bg-ink-900 p-4">
            <Avatar name={form.name} src={form.logo_url} size={44} className="-mt-10 rounded-xl border-2 border-ink-900" />
            <p className="flex-1 font-semibold">{form.name}</p>
            <span className="rounded-xl px-4 py-2 text-sm font-semibold" style={{ background: form.brand_color, color: readableOn(form.brand_color) }}>Reservar</span>
          </div>
        </div>
      </Section>
    </>
  )
}

/* ------------------------------ Hours ------------------------------- */
interface Shift { weekday: number; opens_at: string; closes_at: string; label: string }

function HoursTab() {
  const { tenant } = useCurrentTenant()
  const { data, isLoading } = useBusinessHours(tenant.id)
  const save = useSaveBusinessHours(tenant.id)
  const toast = useToast()
  const [shifts, setShifts] = useState<Shift[]>([])
  useEffect(() => { if (data) setShifts(data.map((h) => ({ weekday: h.weekday, opens_at: h.opens_at.slice(0, 5), closes_at: h.closes_at.slice(0, 5), label: h.label ?? '' }))) }, [data])
  if (isLoading) return <PageLoader />

  const order = [1, 2, 3, 4, 5, 6, 0]
  const update = (idx: number, patch: Partial<Shift>) => setShifts((s) => s.map((x, i) => (i === idx ? { ...x, ...patch } : x)))
  const copyToAll = (weekday: number) => {
    const src = shifts.filter((s) => s.weekday === weekday)
    setShifts(order.flatMap((d) => src.map((s) => ({ ...s, weekday: d }))))
  }

  return (
    <Section title="Horário de funcionamento" description="Adicione mais de um turno por dia (ex.: almoço e jantar). As reservas online só aparecem dentro destes horários."
      footer={<Button loading={save.isPending} onClick={async () => {
        try { await save.mutateAsync(shifts); toast('success', 'Horários salvos') } catch (e) { toast('error', 'Não foi possível salvar', errorMessage(e)) }
      }}>Salvar horários</Button>}>
      <div className="divide-y divide-ink-800">
        {order.map((d) => {
          const dayShifts = shifts.map((s, i) => ({ s, i })).filter(({ s }) => s.weekday === d)
          return (
            <div key={d} className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 md:flex-row md:items-start">
              <div className="flex w-36 items-center justify-between md:block">
                <p className="text-sm font-semibold">{WEEKDAYS[d]}</p>
                <p className={cn('text-xs', dayShifts.length ? 'text-lime' : 'text-ink-500')}>{dayShifts.length ? 'Aberto' : 'Fechado'}</p>
              </div>
              <div className="flex-1 space-y-2">
                {dayShifts.map(({ s, i }) => (
                  <div key={i} className="flex flex-wrap items-center gap-2">
                    <Input type="time" value={s.opens_at} onChange={(e) => update(i, { opens_at: e.target.value })} className="h-9 w-[120px]" />
                    <span className="text-ink-500">até</span>
                    <Input type="time" value={s.closes_at} onChange={(e) => update(i, { closes_at: e.target.value })} className="h-9 w-[120px]" />
                    <Input value={s.label} onChange={(e) => update(i, { label: e.target.value })} placeholder="Turno (opcional)" className="h-9 w-40 flex-1 md:flex-none" />
                    <button onClick={() => setShifts((all) => all.filter((_, j) => j !== i))} className="rounded-lg p-2 text-ink-400 hover:bg-ink-800 hover:text-rose-300" title="Remover turno"><Trash2 className="h-4 w-4" /></button>
                  </div>
                ))}
                <div className="flex gap-3">
                  <button onClick={() => setShifts((s) => [...s, { weekday: d, opens_at: dayShifts.length ? '19:00' : '09:00', closes_at: dayShifts.length ? '23:00' : '18:00', label: '' }])}
                    className="flex items-center gap-1 text-xs font-medium text-ink-300 hover:text-lime"><Plus className="h-3.5 w-3.5" /> Adicionar turno</button>
                  {dayShifts.length > 0 && <button onClick={() => copyToAll(d)} className="text-xs text-ink-500 hover:text-ink-200">Copiar para todos os dias</button>}
                </div>
              </div>
            </div>
          )
        })}
      </div>
      <p className="mt-4 flex items-start gap-2 text-xs text-ink-500"><Info className="mt-0.5 h-3.5 w-3.5 shrink-0" /> Para feriados e eventos pontuais use “Bloquear” na Agenda. Turnos que passam da meia-noite ainda não são suportados.</p>
    </Section>
  )
}

/* ------------------------------ Rules ------------------------------- */
function RulesTab() {
  const { tenant } = useCurrentTenant()
  const { data } = useBookingSettings(tenant.id)
  const update = useUpdateBookingSettings(tenant.id)
  const toast = useToast()
  const [f, setF] = useState<BookingSettings | null>(null)
  const { data: tables = [] } = useTables(tenant.id)
  const { data: staffList = [] } = useStaff(tenant.id)
  useEffect(() => { if (data) setF(data) }, [data])
  if (!f) return <PageLoader />
  const set = <K extends keyof BookingSettings>(k: K, v: BookingSettings[K]) => setF((s) => (s ? { ...s, [k]: v } : s))
  const activeTables = tables.filter((t) => t.is_active).length
  const activeStaff = staffList.filter((t) => t.is_active).length
  const num = (v: string) => (v === '' ? null : Math.max(0, Number(v)))
  const isRestaurant = tenant.segment === 'restaurant'

  const save = async () => {
    try {
      const { tenant_id: _t, ...patch } = f
      void _t
      await update.mutateAsync(patch)
      toast('success', 'Regras atualizadas', 'A disponibilidade já reflete as novas regras.')
    } catch (e) { toast('error', 'Erro ao salvar', errorMessage(e)) }
  }
  const footer = <Button onClick={save} loading={update.isPending}>Salvar regras</Button>

  return (
    <>
      <Section title="Reservas online" footer={footer}>
        <div className="space-y-4">
          <Switch checked={f.booking_enabled} onChange={(v) => set('booking_enabled', v)} label="Aceitar reservas pela página pública" description="Desative temporariamente sem tirar a página do ar." />
          <Switch checked={f.require_confirmation} onChange={(v) => set('require_confirmation', v)} label="Exigir confirmação manual" description="Novas reservas online entram como “Pendente” até você confirmar." />
          <Field label="Mensagem na página de reserva" hint="opcional"><Textarea value={f.booking_message ?? ''} onChange={(e) => set('booking_message', e.target.value)} placeholder="Ex.: Tolerância de 15 minutos. Para grupos acima de 12 pessoas, ligue." /></Field>
        </div>
      </Section>

      <Section title="Como a agenda é organizada" description="Define o que limita cada horário. Pode ser alterado a qualquer momento." footer={footer}>
        <div className="grid gap-3 md:grid-cols-3">
          {([
            { mode: 'capacity', title: 'Por capacidade', desc: 'Limite de reservas e/ou pessoas simultâneas. Ideal para começar.', ok: true, hint: '' },
            { mode: 'tables', title: 'Por mesa', desc: 'Cada reserva recebe a menor mesa (ou união) que comporta o grupo, no ambiente preferido.', ok: activeTables > 0, hint: `${activeTables} mesa(s) ativa(s)`, link: '/app/mesas', linkLabel: 'Gerenciar salão' },
            { mode: 'staff', title: 'Por profissional', desc: 'Horários calculados por serviço, duração, preparo e agenda de cada profissional.', ok: activeStaff > 0, hint: `${activeStaff} profissional(is) ativo(s)`, link: '/app/profissionais', linkLabel: 'Gerenciar profissionais' },
          ] as const).map((o) => (
            <button key={o.mode} type="button" disabled={!o.ok && f.allocation_mode !== o.mode} onClick={() => set('allocation_mode', o.mode)}
              className={cn('flex flex-col rounded-2xl border p-4 text-left transition disabled:cursor-not-allowed disabled:opacity-50',
                f.allocation_mode === o.mode ? 'border-lime/60 bg-lime/[0.06] shadow-glow' : 'border-ink-700 hover:border-ink-500')}>
              <span className="flex items-center justify-between">
                <span className="font-semibold">{o.title}</span>
                <span className={cn('h-4 w-4 rounded-full border-2', f.allocation_mode === o.mode ? 'border-lime bg-lime' : 'border-ink-500')} />
              </span>
              <span className="mt-1.5 text-xs leading-relaxed text-ink-400">{o.desc}</span>
              {'link' in o && (
                <span className="mt-3 text-[11px] text-ink-500">{o.ok ? o.hint : 'Cadastre antes de ativar'} · <Link to={o.link} onClick={(e) => e.stopPropagation()} className="text-lime hover:underline">{o.linkLabel}</Link></span>
              )}
            </button>
          ))}
        </div>
      </Section>

      <Section title="Agenda e capacidade" description="Estas regras valem para reservas online e manuais e são validadas no banco de dados." footer={footer}>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Intervalo entre horários" hint="min">
            <Select value={f.slot_interval_min} onChange={(e) => set('slot_interval_min', Number(e.target.value))}>
              {[10, 15, 20, 30, 45, 60, 90, 120].map((v) => <option key={v} value={v}>{v} minutos</option>)}
            </Select>
          </Field>
          <Field label={isRestaurant ? 'Tempo médio de ocupação' : 'Duração padrão'} hint="min">
            <Input type="number" min={5} max={720} value={f.default_duration_min} onChange={(e) => set('default_duration_min', Number(e.target.value))} />
          </Field>
          <Field label="Intervalo entre reservas" hint="min (limpeza/preparo)">
            <Input type="number" min={0} max={240} value={f.buffer_min} onChange={(e) => set('buffer_min', Number(e.target.value))} />
          </Field>
          <Field label="Reservas simultâneas (máx.)" hint={f.allocation_mode !== 'capacity' ? (f.allocation_mode === 'tables' ? 'definido pelas mesas' : 'definido pelos profissionais') : 'vazio = ilimitado'}>
            <Input type="number" min={1} disabled={f.allocation_mode !== 'capacity'} value={f.max_reservations_per_slot ?? ''} onChange={(e) => set('max_reservations_per_slot', num(e.target.value))} placeholder="Ilimitado" />
          </Field>
          {isRestaurant && (
            <Field label="Pessoas simultâneas (máx.)" hint="lotação">
              <Input type="number" min={1} value={f.max_guests_per_slot ?? ''} onChange={(e) => set('max_guests_per_slot', num(e.target.value))} placeholder="Ilimitado" />
            </Field>
          )}
          <Field label="Pessoas por reserva" hint="mín – máx">
            <div className="flex items-center gap-2">
              <Input type="number" min={1} value={f.min_party_size} onChange={(e) => set('min_party_size', Number(e.target.value))} />
              <span className="text-ink-500">–</span>
              <Input type="number" min={1} value={f.max_party_size} onChange={(e) => set('max_party_size', Number(e.target.value))} />
            </div>
          </Field>
        </div>
        <p className="mt-4 text-xs text-ink-500">
          {isRestaurant
            ? 'No modo por mesa, a lotação vem das mesas; “Pessoas simultâneas” continua valendo como limite da cozinha. No modo por capacidade, o horário some quando qualquer limite é atingido.'
            : 'Ex.: com 2 cadeiras, use “Reservas simultâneas = 2”. Na Fase 3, a disponibilidade passa a ser calculada por profissional e serviço.'}
        </p>
      </Section>

      <Section title="Antecedência e cancelamento" footer={footer}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Antecedência mínima" hint="minutos"><Input type="number" min={0} value={f.min_advance_min} onChange={(e) => set('min_advance_min', Number(e.target.value))} /></Field>
          <Field label="Antecedência máxima" hint="dias"><Input type="number" min={1} max={365} value={f.max_advance_days} onChange={(e) => set('max_advance_days', Number(e.target.value))} /></Field>
          <Field label="Prazo para cancelar/remarcar online" hint="minutos antes"><Input type="number" min={0} value={f.cancellation_min_notice_min} onChange={(e) => set('cancellation_min_notice_min', Number(e.target.value))} /></Field>
          <Field label="Reservas ativas por telefone" hint="anti-abuso"><Input type="number" min={1} max={50} value={f.max_active_per_phone} onChange={(e) => set('max_active_per_phone', Number(e.target.value))} /></Field>
          <div className="space-y-3 sm:col-span-2">
            <Switch checked={f.allow_online_cancel} onChange={(v) => set('allow_online_cancel', v)} label="Cliente pode cancelar online" />
            <Switch checked={f.allow_online_reschedule} onChange={(v) => set('allow_online_reschedule', v)} label="Cliente pode remarcar online" />
          </div>
          <Field label="Política de cancelamento" className="sm:col-span-2"><Textarea value={f.cancellation_policy ?? ''} onChange={(e) => set('cancellation_policy', e.target.value)} placeholder="Texto exibido ao cliente na confirmação e na consulta da reserva." /></Field>
        </div>
      </Section>
    </>
  )
}

/* ------------------------------- Team ------------------------------- */
function TeamTab() {
  const { tenant, role, isManager } = useCurrentTenant()
  const { data: team = [] } = useTeam(tenant.id)
  const { data: invites = [] } = useInvitations(tenant.id, isManager)
  const { invite, revokeInvite, updateMember, removeMember } = useTeamMutations(tenant.id)
  const toast = useToast()
  const [email, setEmail] = useState('')
  const [newRole, setNewRole] = useState<MemberRole>('staff')
  const [removing, setRemoving] = useState<string | null>(null)

  return (
    <>
      <Section title="Convidar pessoa" description="A pessoa cria a conta com este e-mail e ganha acesso automaticamente ao entrar.">
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email@exemplo.com" type="email" className="flex-1" />
          <Select value={newRole} onChange={(e) => setNewRole(e.target.value as MemberRole)} className="sm:w-44">
            <option value="staff">Funcionário</option>
            <option value="manager">Gerente</option>
          </Select>
          <Button loading={invite.isPending} onClick={async () => {
            if (!isValidEmail(email)) return toast('error', 'E-mail inválido')
            try { await invite.mutateAsync({ email, role: newRole }); setEmail(''); toast('success', 'Convite criado', 'Peça para a pessoa se cadastrar com este e-mail.') }
            catch (e) { toast('error', 'Erro', errorMessage(e)) }
          }}>Convidar</Button>
        </div>
        <div className="mt-4 grid gap-2 text-xs text-ink-400 sm:grid-cols-3">
          <p><b className="text-ink-200">Proprietário:</b> acesso total, plano e equipe.</p>
          <p><b className="text-ink-200">Gerente:</b> configurações, equipe e relatórios.</p>
          <p><b className="text-ink-200">Funcionário:</b> agenda, reservas e clientes.</p>
        </div>
        <p className="mt-3 text-xs text-ink-500">O envio do convite por e-mail depende da integração de e-mail (veja Notificações). Por enquanto, avise a pessoa diretamente.</p>
      </Section>

      <Section title="Equipe">
        <div className="divide-y divide-ink-800">
          {team.map((m) => (
            <div key={m.member_id} className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0">
              <Avatar name={m.full_name || m.email} size={38} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">{m.full_name || m.email.split('@')[0]}</p>
                <p className="truncate text-xs text-ink-400">{m.email}</p>
              </div>
              {isManager && m.role !== 'owner' ? (
                <Select value={m.role} className="h-9 w-40" onChange={async (e) => {
                  try { await updateMember.mutateAsync({ memberId: m.member_id, patch: { role: e.target.value as MemberRole } }); toast('success', 'Função atualizada') }
                  catch (err) { toast('error', 'Erro', errorMessage(err)) }
                }}>
                  <option value="staff">Funcionário</option>
                  <option value="manager">Gerente</option>
                  {role === 'owner' && <option value="owner">Proprietário</option>}
                </Select>
              ) : <span className="chip border-lime/30 bg-lime/10 text-lime">{ROLE[m.role]}</span>}
              {isManager && m.role !== 'owner' && (
                <button onClick={() => setRemoving(m.member_id)} className="rounded-lg p-2 text-ink-400 hover:bg-ink-800 hover:text-rose-300" title="Remover acesso"><Trash2 className="h-4 w-4" /></button>
              )}
            </div>
          ))}
        </div>
        {invites.length > 0 && (
          <div className="mt-5">
            <p className="label">Convites pendentes</p>
            <div className="space-y-2">
              {invites.map((i) => (
                <div key={i.id} className="flex items-center gap-3 rounded-xl border border-dashed border-ink-700 px-3 py-2.5">
                  <Mail className="h-4 w-4 text-ink-400" />
                  <span className="flex-1 truncate text-sm">{i.email}</span>
                  <span className="text-xs text-ink-400">{ROLE[i.role]}</span>
                  <button onClick={() => revokeInvite.mutate(i.id)} className="text-xs text-ink-400 hover:text-rose-300">Revogar</button>
                </div>
              ))}
            </div>
          </div>
        )}
      </Section>
      <ConfirmDialog open={!!removing} danger title="Remover acesso?" confirmLabel="Remover" description="A pessoa perde o acesso imediatamente a este estabelecimento."
        onClose={() => setRemoving(null)}
        onConfirm={async () => {
          try { await removeMember.mutateAsync(removing!); toast('success', 'Acesso removido') } catch (e) { toast('error', 'Erro', errorMessage(e)) }
          setRemoving(null)
        }} />
    </>
  )
}

/* -------------------------- Notifications --------------------------- */
function NotificationsTab() {
  const { tenant } = useCurrentTenant()
  const { data } = useNotificationSettings(tenant.id)
  const update = useUpdateNotificationSettings(tenant.id)
  const toast = useToast()
  const [f, setF] = useState<NotificationSettings | null>(null)
  useEffect(() => { if (data) setF(data) }, [data])
  if (!f) return <PageLoader />
  const set = <K extends keyof NotificationSettings>(k: K, v: NotificationSettings[K]) => setF((s) => (s ? { ...s, [k]: v } : s))

  const channels = [
    { key: 'email_enabled' as const, icon: Mail, title: 'E-mail', desc: 'Confirmações, lembretes e cancelamentos para clientes que informarem e-mail.', setup: 'Requer RESEND_API_KEY na Edge Function notification-dispatcher.' },
    { key: 'whatsapp_enabled' as const, icon: MessageCircle, title: 'WhatsApp', desc: 'Mensagens automáticas via WhatsApp Business Cloud API (Meta).', setup: 'Requer número aprovado na Meta, WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID e templates aprovados.' },
    { key: 'push_enabled' as const, icon: Smartphone, title: 'Push', desc: 'Notificações no celular da equipe.', setup: 'Planejado: requer app/PWA com Web Push (VAPID). Ainda não disponível.' },
  ]

  return (
    <>
      <Section title="Canais para clientes"
        description="As mensagens entram em uma fila (outbox) assim que algo acontece. Um despachante no servidor envia pelo provedor configurado. Nada é simulado: sem provedor, as mensagens ficam marcadas como “Requer configuração”."
        footer={<Button loading={update.isPending} onClick={async () => { try { const { tenant_id: _t, ...p } = f; void _t; await update.mutateAsync(p); toast('success', 'Notificações salvas') } catch (e) { toast('error', 'Erro', errorMessage(e)) } }}>Salvar</Button>}>
        <div className="space-y-4">
          {channels.map((c) => (
            <div key={c.key} className="rounded-2xl border border-ink-700 bg-ink-850 p-4">
              <div className="flex items-start gap-3">
                <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-ink-800 text-lime"><c.icon className="h-4 w-4" /></div>
                <div className="flex-1"><Switch checked={f[c.key]} onChange={(v) => set(c.key, v)} disabled={c.key === 'push_enabled'} label={c.title} description={c.desc} /></div>
              </div>
              <p className="ml-12 mt-2 flex items-start gap-1.5 text-[11px] text-sky-300/80"><Info className="mt-0.5 h-3 w-3 shrink-0" /> {c.setup}</p>
            </div>
          ))}
          <div className="grid gap-4 pt-2 sm:grid-cols-2">
            <div className="space-y-3">
              <Switch checked={f.reminder_enabled} onChange={(v) => set('reminder_enabled', v)} label="Lembrete antes da reserva" />
              <Switch checked={f.review_request_enabled} onChange={(v) => set('review_request_enabled', v)} label="Pedir avaliação após o atendimento" description="Enviado 2h após marcar como concluída." />
            </div>
            <Field label="Enviar lembrete" hint="horas antes">
              <Select value={f.reminder_hours_before} onChange={(e) => set('reminder_hours_before', Number(e.target.value))}>
                {[2, 3, 6, 12, 24, 48].map((h) => <option key={h} value={h}>{h} horas antes</option>)}
              </Select>
            </Field>
          </div>
        </div>
      </Section>
      <Section title="Avisos para a equipe">
        <Switch checked={f.notify_owner_new_reservation} onChange={async (v) => { set('notify_owner_new_reservation', v); await update.mutateAsync({ notify_owner_new_reservation: v }) }}
          label="Avisar sobre novas reservas online, cancelamentos e remarcações" description="Aparece em tempo real no painel (sino) para todos da equipe." />
      </Section>
    </>
  )
}
