import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import type { BookingSettings, BusinessHour, Invitation, MemberRole, NotificationSettings, Plan, Segment, TeamMember, Tenant } from '@/types/db'

export async function createTenant(input: { name: string; slug: string; segment: Segment; timezone: string; phone?: string }) {
  const { data, error } = await supabase.rpc('create_tenant', {
    p_name: input.name, p_slug: input.slug, p_segment: input.segment, p_timezone: input.timezone, p_phone: input.phone || null,
  })
  if (error) throw error
  return data as Tenant
}

export async function isSlugAvailable(slug: string) {
  const { data, error } = await supabase.rpc('slug_available', { p_slug: slug })
  if (error) throw error
  return Boolean(data)
}

export function useUpdateTenant() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Partial<Tenant> }) => {
      const { error } = await supabase.from('tenants').update(patch).eq('id', id)
      if (error) throw error
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['memberships'] }),
  })
}

export async function uploadTenantAsset(tenantId: string, file: File, kind: 'logo' | 'cover' | 'staff') {
  if (file.size > 5 * 1024 * 1024) throw new Error('Arquivo maior que 5 MB.')
  const ext = file.name.split('.').pop()?.toLowerCase() || 'png'
  const path = `${tenantId}/${kind}-${Date.now()}.${ext}`
  const { error } = await supabase.storage.from('tenant-assets').upload(path, file, { upsert: true, cacheControl: '31536000' })
  if (error) throw error
  return supabase.storage.from('tenant-assets').getPublicUrl(path).data.publicUrl
}

export function useBookingSettings(tenantId: string) {
  return useQuery({
    queryKey: ['booking_settings', tenantId],
    queryFn: async () => {
      const { data, error } = await supabase.from('booking_settings').select('*').eq('tenant_id', tenantId).single()
      if (error) throw error
      return data as BookingSettings
    },
  })
}

export function useUpdateBookingSettings(tenantId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (patch: Partial<BookingSettings>) => {
      const { error } = await supabase.from('booking_settings').update(patch).eq('tenant_id', tenantId)
      if (error) throw error
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['booking_settings', tenantId] })
      void qc.invalidateQueries({ queryKey: ['slots'] })
    },
  })
}

export function useBusinessHours(tenantId: string) {
  return useQuery({
    queryKey: ['business_hours', tenantId],
    queryFn: async () => {
      const { data, error } = await supabase.from('business_hours').select('*').eq('tenant_id', tenantId).order('weekday').order('opens_at')
      if (error) throw error
      return data as BusinessHour[]
    },
  })
}

export function useSaveBusinessHours(tenantId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (hours: { weekday: number; opens_at: string; closes_at: string; label?: string | null }[]) => {
      const { error } = await supabase.rpc('save_business_hours', { p_tenant: tenantId, p_hours: hours })
      if (error) throw error
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['business_hours', tenantId] })
      void qc.invalidateQueries({ queryKey: ['slots'] })
    },
  })
}

export function useNotificationSettings(tenantId: string) {
  return useQuery({
    queryKey: ['notification_settings', tenantId],
    queryFn: async () => {
      const { data, error } = await supabase.from('notification_settings').select('*').eq('tenant_id', tenantId).single()
      if (error) throw error
      return data as NotificationSettings
    },
  })
}

export function useUpdateNotificationSettings(tenantId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (patch: Partial<NotificationSettings>) => {
      const { error } = await supabase.from('notification_settings').update(patch).eq('tenant_id', tenantId)
      if (error) throw error
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notification_settings', tenantId] }),
  })
}

export function useTeam(tenantId: string) {
  return useQuery({
    queryKey: ['team', tenantId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_team', { p_tenant: tenantId })
      if (error) throw error
      return data as TeamMember[]
    },
  })
}

export function useInvitations(tenantId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['invitations', tenantId],
    enabled,
    queryFn: async () => {
      const { data, error } = await supabase.from('tenant_invitations').select('*').eq('tenant_id', tenantId).is('accepted_at', null).order('created_at', { ascending: false })
      if (error) throw error
      return data as Invitation[]
    },
  })
}

export function useTeamMutations(tenantId: string) {
  const qc = useQueryClient()
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['team', tenantId] })
    void qc.invalidateQueries({ queryKey: ['invitations', tenantId] })
  }
  return {
    invite: useMutation({
      mutationFn: async ({ email, role }: { email: string; role: MemberRole }) => {
        const { data: u } = await supabase.auth.getUser()
        const { error } = await supabase.from('tenant_invitations').insert({ tenant_id: tenantId, email: email.trim().toLowerCase(), role, invited_by: u.user?.id })
        if (error) throw error
      },
      onSuccess: refresh,
    }),
    revokeInvite: useMutation({
      mutationFn: async (id: string) => {
        const { error } = await supabase.from('tenant_invitations').delete().eq('id', id)
        if (error) throw error
      },
      onSuccess: refresh,
    }),
    updateMember: useMutation({
      mutationFn: async ({ memberId, patch }: { memberId: string; patch: { role?: MemberRole; is_active?: boolean } }) => {
        const { error } = await supabase.from('tenant_members').update(patch).eq('id', memberId)
        if (error) throw error
      },
      onSuccess: refresh,
    }),
    removeMember: useMutation({
      mutationFn: async (memberId: string) => {
        const { error } = await supabase.from('tenant_members').delete().eq('id', memberId)
        if (error) throw error
      },
      onSuccess: refresh,
    }),
  }
}

export function usePlans() {
  return useQuery({
    queryKey: ['plans'],
    staleTime: 3600_000,
    queryFn: async () => {
      const { data, error } = await supabase.from('plans').select('*').eq('is_active', true).order('sort_order')
      if (error) throw error
      return data as Plan[]
    },
  })
}
