import { NavLink, Navigate, Outlet, Link } from 'react-router-dom'
import { BarChart3, Building2, CreditCard, LifeBuoy, ArrowLeft, LogOut } from 'lucide-react'
import { useIsPlatformAdmin } from '@/api/saas'
import { useAuth } from '@/hooks/useAuth'
import { Logo } from '@/components/layout/Logo'
import { PageLoader } from '@/components/ui/ui'
import { cn } from '@/lib/utils'

const NAV = [
  { to: '/admin', label: 'Visão geral', icon: BarChart3, end: true },
  { to: '/admin/empresas', label: 'Empresas', icon: Building2 },
  { to: '/admin/planos', label: 'Planos', icon: CreditCard },
  { to: '/admin/suporte', label: 'Suporte', icon: LifeBuoy },
]

export default function AdminLayout() {
  const { data: isAdmin, isLoading } = useIsPlatformAdmin()
  const { user, signOut } = useAuth()
  if (isLoading) return <PageLoader />
  if (!isAdmin) return <Navigate to="/app" replace />
  return (
    <div className="min-h-screen bg-ink-950">
      <header className="sticky top-0 z-30 border-b border-ink-800 bg-ink-950/90 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1400px] items-center gap-4 px-4 py-3 md:px-8">
          <Logo />
          <span className="chip border-lime/40 bg-lime/10 text-lime">Painel Innovai</span>
          <nav className="ml-4 hidden gap-1 md:flex">
            {NAV.map((n) => (
              <NavLink key={n.to} to={n.to} end={n.end}
                className={({ isActive }) => cn('flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium', isActive ? 'bg-ink-800 text-ink-50' : 'text-ink-400 hover:text-ink-100')}>
                <n.icon className="h-4 w-4" /> {n.label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2 text-xs text-ink-400">
            <span className="hidden sm:inline">{user?.email}</span>
            <Link to="/app" className="flex items-center gap-1 rounded-lg px-2 py-1.5 hover:bg-ink-850 hover:text-ink-100"><ArrowLeft className="h-3.5 w-3.5" /> App</Link>
            <button onClick={() => void signOut()} className="rounded-lg p-1.5 hover:bg-ink-850 hover:text-ink-100" title="Sair"><LogOut className="h-4 w-4" /></button>
          </div>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-4 pb-2 md:hidden">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end}
              className={({ isActive }) => cn('flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium', isActive ? 'bg-ink-800 text-ink-50' : 'text-ink-400')}>
              <n.icon className="h-3.5 w-3.5" /> {n.label}
            </NavLink>
          ))}
        </nav>
      </header>
      <main className="mx-auto max-w-[1400px] px-4 py-6 md:px-8 md:py-8 animate-fade-up"><Outlet /></main>
    </div>
  )
}
