import { lazy, Suspense, type ReactNode } from 'react'
import { Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom'
import { useAuth } from './hooks/useAuth'
import { TenantProvider, useTenant } from './hooks/useTenant'
import { isSupabaseConfigured } from './lib/supabase'
import { SEGMENT_PATHS } from './lib/constants'
import { PageLoader } from './components/ui/ui'
import { AppShell } from './components/layout/AppShell'
import { SetupRequired } from './pages/SetupRequired'

const Landing = lazy(() => import('./pages/Landing'))
const Login = lazy(() => import('./pages/auth/Login'))
const Signup = lazy(() => import('./pages/auth/Signup'))
const ForgotPassword = lazy(() => import('./pages/auth/ForgotPassword'))
const ResetPassword = lazy(() => import('./pages/auth/ResetPassword'))
const Onboarding = lazy(() => import('./pages/onboarding/Onboarding'))
const Dashboard = lazy(() => import('./pages/app/Dashboard'))
const Agenda = lazy(() => import('./pages/app/Agenda'))
const Reservations = lazy(() => import('./pages/app/Reservations'))
const Customers = lazy(() => import('./pages/app/Customers'))
const Settings = lazy(() => import('./pages/app/Settings'))
const Notifications = lazy(() => import('./pages/app/Notifications'))
const Plan = lazy(() => import('./pages/app/Plan'))
const Roadmap = lazy(() => import('./pages/app/Roadmap'))
const Floor = lazy(() => import('./pages/app/Floor'))
const Waitlist = lazy(() => import('./pages/app/Waitlist'))
const Services = lazy(() => import('./pages/app/Services'))
const StaffPage = lazy(() => import('./pages/app/Staff'))
const PublicBooking = lazy(() => import('./pages/public/PublicBooking'))
const ReservationLookup = lazy(() => import('./pages/public/ReservationLookup'))
const NotFound = lazy(() => import('./pages/NotFound'))

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth()
  const loc = useLocation()
  if (loading) return <PageLoader />
  if (!user) return <Navigate to={`/entrar?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />
  return <TenantProvider>{children}</TenantProvider>
}

function RequireTenant({ children }: { children: ReactNode }) {
  const { tenant, loading } = useTenant()
  if (loading) return <PageLoader />
  if (!tenant) return <Navigate to="/onboarding" replace />
  return <>{children}</>
}

function PublicRoute() {
  const { segment } = useParams()
  if (!segment || !SEGMENT_PATHS.includes(segment)) return <NotFound />
  return <PublicBooking />
}

export function App() {
  if (!isSupabaseConfigured) return <SetupRequired />
  return (
    <Suspense fallback={<PageLoader />}>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/entrar" element={<Login />} />
        <Route path="/cadastro" element={<Signup />} />
        <Route path="/recuperar-senha" element={<ForgotPassword />} />
        <Route path="/nova-senha" element={<ResetPassword />} />
        <Route path="/onboarding" element={<RequireAuth><Onboarding /></RequireAuth>} />
        <Route path="/app" element={<RequireAuth><RequireTenant><AppShell /></RequireTenant></RequireAuth>}>
          <Route index element={<Navigate to="dashboard" replace />} />
          <Route path="dashboard" element={<Dashboard />} />
          <Route path="agenda" element={<Agenda />} />
          <Route path="reservas" element={<Reservations />} />
          <Route path="clientes" element={<Customers />} />
          <Route path="notificacoes" element={<Notifications />} />
          <Route path="configuracoes" element={<Settings />} />
          <Route path="plano" element={<Plan />} />
          <Route path="mesas" element={<Floor />} />
          <Route path="lista-espera" element={<Waitlist />} />
          <Route path="servicos" element={<Services />} />
          <Route path="profissionais" element={<StaffPage />} />
          <Route path="modulos/:module" element={<Roadmap />} />
        </Route>
        <Route path="/reserva" element={<ReservationLookup />} />
        <Route path="/reserva/:code" element={<ReservationLookup />} />
        <Route path="/:segment/:slug" element={<PublicRoute />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Suspense>
  )
}
