import { createContext, useCallback, useContext, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import {
  Bell, CalendarDays, ChevronsUpDown, CreditCard, ExternalLink, LayoutDashboard, ListChecks, LogOut, Menu, Plus,
  Settings, Users, Armchair, Scissors, BarChart3, Check, UserRound, Sparkles, ListOrdered,
} from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { useCurrentTenant } from '@/hooks/useTenant'
import { useTenantRealtime } from '@/hooks/useRealtime'
import { useUnreadCount } from '@/api/notifications'
import { useWaitlistCount } from '@/api/waitlist'
import { todayKey } from '@/lib/datetime'
import { useToast } from '@/components/ui/Toast'
import { Sheet } from '@/components/ui/Sheet'
import { Avatar } from '@/components/ui/ui'
import { ReservationForm, type ReservationPrefill } from '@/components/reservations/ReservationForm'
import { ROLE, SEGMENT, newUnit } from '@/lib/constants'
import { PUBLIC_BASE_URL } from '@/lib/supabase'
import { cn } from '@/lib/utils'
import { Logo } from './Logo'

interface ShellActions { newReservation: (prefill?: ReservationPrefill) => void }
const ShellCtx = createContext<ShellActions>({ newReservation: () => undefined })
export const useShell = () => useContext(ShellCtx)

export const publicBookingUrl = (segment: keyof typeof SEGMENT, slug: string) => `${PUBLIC_BASE_URL}/${SEGMENT[segment].path}/${slug}`

export function AppShell() {
  const { tenant, role, memberships, switchTenant } = useCurrentTenant()
  const { user, signOut } = useAuth()
  const toast = useToast()
  const navigate = useNavigate()
  const loc = useLocation()
  const [formOpen, setFormOpen] = useState(false)
  const [prefill, setPrefill] = useState<ReservationPrefill | undefined>()
  const [moreOpen, setMoreOpen] = useState(false)
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const { data: unread = 0 } = useUnreadCount(tenant.id)
  const { data: waiting = 0 } = useWaitlistCount(tenant.id, todayKey(tenant.timezone))

  const onRealtimeNotification = useCallback((title: string, body: string) => toast('info', title, body), [toast])
  useTenantRealtime(tenant.id, onRealtimeNotification)

  const newReservation = useCallback((p?: ReservationPrefill) => { setPrefill(p); setFormOpen(true) }, [])
  const isRestaurant = tenant.segment === 'restaurant'

  const nav = [
    { to: '/app/dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { to: '/app/agenda', label: 'Agenda', icon: CalendarDays },
    { to: '/app/reservas', label: SEGMENT[tenant.segment].unitPlural.replace(/^./, (c) => c.toUpperCase()), icon: ListChecks },
    { to: '/app/clientes', label: 'Clientes', icon: Users },
  ]
  const modules = isRestaurant
    ? [
        { to: '/app/mesas', label: 'Salão e mesas', icon: Armchair },
        { to: '/app/lista-espera', label: 'Lista de espera', icon: ListOrdered, badge: waiting },
      ]
    : [
        { to: '/app/servicos', label: 'Serviços', icon: Scissors },
        { to: '/app/profissionais', label: 'Profissionais', icon: UserRound },
      ]
  const secondary = [
    { to: '/app/modulos/relatorios', label: 'Relatórios', icon: BarChart3, tag: 'Fase 5' },
    { to: '/app/notificacoes', label: 'Notificações', icon: Bell, badge: unread },
    { to: '/app/configuracoes', label: 'Configurações', icon: Settings },
    { to: '/app/plano', label: 'Meu plano', icon: CreditCard },
  ]

  const NavItem = ({ to, label, icon: Icon, tag, badge, onClick }: { to: string; label: string; icon: typeof Bell; tag?: string; badge?: number; onClick?: () => void }) => (
    <NavLink
      to={to}
      onClick={onClick}
      className={({ isActive }) => cn(
        'group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all',
        isActive ? 'bg-ink-800 text-ink-50' : 'text-ink-300 hover:bg-ink-850 hover:text-ink-100',
      )}
    >
      {({ isActive }) => (
        <>
          {isActive && <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-lime" />}
          <Icon className={cn('h-[18px] w-[18px]', isActive ? 'text-lime' : 'text-ink-400 group-hover:text-ink-200')} />
          <span className="flex-1 truncate">{label}</span>
          {tag && <span className="rounded-md border border-ink-700 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-ink-400">{tag}</span>}
          {!!badge && <span className="grid h-5 min-w-5 place-items-center rounded-full bg-lime px-1.5 text-[11px] font-bold text-ink-950">{badge > 99 ? '99+' : badge}</span>}
        </>
      )}
    </NavLink>
  )

  const TenantSwitcher = () => (
    <div className="relative">
      <button
        onClick={() => setSwitcherOpen((v) => !v)}
        className="flex w-full items-center gap-3 rounded-2xl border border-ink-700 bg-ink-850 p-2.5 text-left transition hover:border-ink-600"
      >
        <Avatar name={tenant.name} src={tenant.logo_url} size={36} className="rounded-xl" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-ink-50">{tenant.name}</p>
          <p className="truncate text-xs text-ink-400">{SEGMENT[tenant.segment].label} · {role ? ROLE[role] : ''}</p>
        </div>
        <ChevronsUpDown className="h-4 w-4 text-ink-400" />
      </button>
      {switcherOpen && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setSwitcherOpen(false)} />
          <div className="absolute inset-x-0 top-full z-40 mt-2 rounded-2xl border border-ink-700 bg-ink-850 p-1.5 shadow-2xl animate-fade-up">
            {memberships.map((m) => (
              <button
                key={m.id}
                onClick={() => { switchTenant(m.tenant_id); setSwitcherOpen(false); navigate('/app/dashboard') }}
                className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-sm hover:bg-ink-800"
              >
                <Avatar name={m.tenant.name} src={m.tenant.logo_url} size={26} className="rounded-lg" />
                <span className="flex-1 truncate">{m.tenant.name}</span>
                {m.tenant_id === tenant.id && <Check className="h-4 w-4 text-lime" />}
              </button>
            ))}
            <button
              onClick={() => { setSwitcherOpen(false); navigate('/onboarding') }}
              className="mt-1 flex w-full items-center gap-2.5 rounded-xl border-t border-ink-700 px-2.5 py-2 text-left text-sm text-ink-300 hover:bg-ink-800 hover:text-ink-100"
            >
              <Plus className="h-4 w-4" /> Novo estabelecimento
            </button>
          </div>
        </>
      )}
    </div>
  )

  const publicUrl = publicBookingUrl(tenant.segment, tenant.slug)

  return (
    <ShellCtx.Provider value={{ newReservation }}>
      <div className="min-h-screen bg-ink-950">
        {/* Desktop sidebar */}
        <aside className="fixed inset-y-0 left-0 z-30 hidden w-[264px] flex-col border-r border-ink-800 bg-ink-900/60 backdrop-blur-xl lg:flex">
          <div className="px-5 pb-4 pt-6"><Logo /></div>
          <div className="px-3"><TenantSwitcher /></div>
          <div className="px-3 pt-4">
            <button
              onClick={() => newReservation()}
              className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-lime text-sm font-semibold text-ink-950 transition hover:bg-lime-400 hover:shadow-glow active:scale-[0.98]"
            >
              <Plus className="h-4 w-4" strokeWidth={2.6} /> {newUnit(tenant.segment)}
            </button>
          </div>
          <nav className="flex-1 space-y-6 overflow-y-auto px-3 py-5">
            <div className="space-y-0.5">{nav.map((n) => <NavItem key={n.to} {...n} />)}</div>
            <div className="space-y-0.5">
              <p className="px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-500">Operação</p>
              {modules.map((n) => <NavItem key={n.to} {...n} />)}
            </div>
            <div className="space-y-0.5">
              <p className="px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-500">Gestão</p>
              {secondary.map((n) => <NavItem key={n.to} {...n} />)}
            </div>
          </nav>
          <div className="space-y-2 border-t border-ink-800 p-3">
            <a href={publicUrl} target="_blank" rel="noreferrer"
              className="flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-medium text-ink-300 transition hover:bg-ink-850 hover:text-lime">
              <ExternalLink className="h-3.5 w-3.5" /> Ver página de reservas
            </a>
            <div className="flex items-center gap-2.5 rounded-xl px-2 py-1.5">
              <Avatar name={user?.user_metadata?.full_name ?? user?.email ?? '?'} size={30} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium text-ink-100">{user?.user_metadata?.full_name ?? 'Minha conta'}</p>
                <p className="truncate text-[11px] text-ink-400">{user?.email}</p>
              </div>
              <button onClick={() => void signOut()} className="rounded-lg p-1.5 text-ink-400 hover:bg-ink-800 hover:text-ink-100" title="Sair">
                <LogOut className="h-4 w-4" />
              </button>
            </div>
          </div>
        </aside>

        {/* Mobile top bar */}
        <header className="sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-ink-800 bg-ink-950/85 px-4 py-3 backdrop-blur-xl lg:hidden">
          <div className="flex min-w-0 items-center gap-2.5">
            <Avatar name={tenant.name} src={tenant.logo_url} size={32} className="rounded-xl" />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold leading-tight">{tenant.name}</p>
              <p className="text-[11px] leading-tight text-ink-400">{SEGMENT[tenant.segment].label}</p>
            </div>
          </div>
          <button onClick={() => navigate('/app/notificacoes')} className="relative rounded-xl border border-ink-700 p-2 text-ink-200">
            <Bell className="h-[18px] w-[18px]" />
            {unread > 0 && <span className="absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-lime px-1 text-[10px] font-bold text-ink-950">{unread}</span>}
          </button>
        </header>

        <main className="lg:pl-[264px]">
          <div key={loc.pathname} className="mx-auto max-w-[1400px] px-4 pb-28 pt-5 animate-fade-up md:px-8 md:pt-8 lg:pb-12">
            <Outlet />
          </div>
        </main>

        {/* Mobile bottom navigation */}
        <nav className="pb-safe fixed inset-x-0 bottom-0 z-40 border-t border-ink-800 bg-ink-950/90 px-2 pt-1.5 backdrop-blur-xl lg:hidden">
          <div className="grid grid-cols-5 items-end">
            {[nav[0], nav[1]].map((n) => <MobileTab key={n.to} {...n} />)}
            <div className="flex justify-center">
              <button onClick={() => newReservation()} aria-label="Nova reserva"
                className="-mt-6 grid h-14 w-14 place-items-center rounded-2xl bg-lime text-ink-950 shadow-glow active:scale-95">
                <Plus className="h-6 w-6" strokeWidth={2.6} />
              </button>
            </div>
            <MobileTab {...nav[3]} />
            <button onClick={() => setMoreOpen(true)} className="flex flex-col items-center gap-1 py-1.5 text-[10px] font-medium text-ink-400">
              <Menu className="h-5 w-5" /> Mais
            </button>
          </div>
        </nav>

        <Sheet open={moreOpen} onClose={() => setMoreOpen(false)} title="Menu">
          <div className="space-y-5">
            <TenantSwitcher />
            <div className="space-y-0.5">{[nav[2], ...modules, ...secondary].map((n) => <NavItem key={n.to} {...n} onClick={() => setMoreOpen(false)} />)}</div>
            <a href={publicUrl} target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded-xl border border-ink-700 px-3 py-3 text-sm text-ink-200">
              <ExternalLink className="h-4 w-4 text-lime" /> Ver página de reservas
            </a>
            <button onClick={() => void signOut()} className="flex w-full items-center gap-2 rounded-xl px-3 py-3 text-sm text-rose-300 hover:bg-ink-850">
              <LogOut className="h-4 w-4" /> Sair da conta
            </button>
            <p className="flex items-center justify-center gap-1.5 pt-2 text-[11px] text-ink-500"><Sparkles className="h-3 w-3" /> Innovai Reserve</p>
          </div>
        </Sheet>

        <ReservationForm open={formOpen} onClose={() => setFormOpen(false)} prefill={prefill} />
      </div>
    </ShellCtx.Provider>
  )
}

function MobileTab({ to, label, icon: Icon }: { to: string; label: string; icon: typeof Bell }) {
  return (
    <NavLink to={to} className={({ isActive }) => cn('flex flex-col items-center gap-1 py-1.5 text-[10px] font-medium', isActive ? 'text-lime' : 'text-ink-400')}>
      <Icon className="h-5 w-5" />
      {label}
    </NavLink>
  )
}
