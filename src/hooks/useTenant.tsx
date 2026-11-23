import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { hexToRgbTriplet } from '@/lib/utils'
import { supabase } from '@/lib/supabase'
import { useAuth } from './useAuth'
import type { Membership, MemberRole, Tenant } from '@/types/db'

interface TenantState {
  memberships: Membership[]
  tenant: Tenant | null
  role: MemberRole | null
  isManager: boolean
  loading: boolean
  switchTenant: (id: string) => void
  refresh: () => Promise<void>
}

const TenantCtx = createContext<TenantState | null>(null)
const STORAGE_KEY = 'innovai.tenant'

export function TenantProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  const qc = useQueryClient()
  const [selected, setSelected] = useState<string | null>(() => localStorage.getItem(STORAGE_KEY))

  const { data: memberships = [], isLoading } = useQuery({
    queryKey: ['memberships', user?.id],
    enabled: !!user,
    queryFn: async () => {
      // invitations are accepted before reading memberships (first login after invite)
      await supabase.rpc('accept_invitations')
      const { data, error } = await supabase
        .from('tenant_members')
        .select('id, tenant_id, user_id, role, is_active, tenant:tenants(*)')
        .eq('user_id', user!.id)
        .eq('is_active', true)
        .order('created_at')
      if (error) throw error
      return (data ?? []) as unknown as Membership[]
    },
  })

  const current = useMemo(
    () => memberships.find((m) => m.tenant_id === selected) ?? memberships[0] ?? null,
    [memberships, selected],
  )

  useEffect(() => {
    if (current) localStorage.setItem(STORAGE_KEY, current.tenant_id)
    document.documentElement.style.setProperty('--brand-rgb', hexToRgbTriplet(current?.tenant.brand_color ?? '#C6F432'))
  }, [current])

  const value: TenantState = {
    memberships,
    tenant: current?.tenant ?? null,
    role: current?.role ?? null,
    isManager: current?.role === 'owner' || current?.role === 'manager',
    loading: !!user && isLoading,
    switchTenant: (id) => {
      setSelected(id)
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'memberships' })
    },
    refresh: async () => {
      await qc.invalidateQueries({ queryKey: ['memberships'] })
    },
  }
  return <TenantCtx.Provider value={value}>{children}</TenantCtx.Provider>
}

export function useTenant() {
  const ctx = useContext(TenantCtx)
  if (!ctx) throw new Error('useTenant outside provider')
  return ctx
}

/** For pages under /app where a tenant is guaranteed by the route guard. */
export function useCurrentTenant() {
  const ctx = useTenant()
  if (!ctx.tenant) throw new Error('No tenant selected')
  return { ...ctx, tenant: ctx.tenant }
}
