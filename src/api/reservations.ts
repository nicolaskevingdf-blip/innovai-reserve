import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import type { Reservation, ReservationEvent, ReservationStatus, ScheduleBlock, Slot, DashboardMetrics } from '@/types/db'

export interface ReservationFilters {
  from: string // ISO instant
  to: string // ISO instant (exclusive)
  status?: ReservationStatus[]
  search?: string
}

export function useReservations(tenantId: string, f: ReservationFilters) {
  return useQuery({
    queryKey: ['reservations', tenantId, f],
    queryFn: async () => {
      let q = supabase
        .from('reservations')
        .select('*')
        .eq('tenant_id', tenantId)
        .gte('starts_at', f.from)
        .lt('starts_at', f.to)
        .order('starts_at')
        .limit(2000)
      if (f.status?.length) q = q.in('status', f.status)
      const s = f.search?.trim()
      if (s) {
        const safe = s.replace(/[%,()]/g, ' ')
        const digits = safe.replace(/\D/g, '')
        q = q.or(
          [`customer_name.ilike.%${safe}%`, `code.ilike.%${safe}%`, digits.length >= 3 ? `customer_phone_normalized.ilike.%${digits}%` : null]
            .filter(Boolean)
            .join(','),
        )
      }
      const { data, error } = await q
      if (error) throw error
      return data as Reservation[]
    },
  })
}

export function useUpcoming(tenantId: string, limit = 6) {
  return useQuery({
    queryKey: ['reservations', tenantId, 'upcoming', limit],
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('reservations')
        .select('*')
        .eq('tenant_id', tenantId)
        .in('status', ['pending', 'confirmed', 'in_progress'])
        .gte('ends_at', new Date().toISOString())
        .order('starts_at')
        .limit(limit)
      if (error) throw error
      return data as Reservation[]
    },
  })
}

export function useReservationEvents(reservationId: string | undefined) {
  return useQuery({
    queryKey: ['reservations', 'events', reservationId],
    enabled: !!reservationId,
    queryFn: async () => {
      const { data, error } = await supabase.from('reservation_events').select('*').eq('reservation_id', reservationId!).order('created_at', { ascending: false })
      if (error) throw error
      return data as ReservationEvent[]
    },
  })
}

export type ReservationInput = Pick<Reservation, 'customer_name' | 'customer_phone' | 'starts_at' | 'party_size' | 'source' | 'status'> &
  Partial<Pick<Reservation, 'customer_email' | 'ends_at' | 'notes' | 'internal_notes' | 'customer_id' | 'table_ids' | 'area_id' | 'service_id' | 'staff_id' | 'staff_requested'>>

export function useReservationMutations(tenantId: string) {
  const qc = useQueryClient()
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['reservations'] })
    void qc.invalidateQueries({ queryKey: ['dashboard'] })
    void qc.invalidateQueries({ queryKey: ['slots'] })
    void qc.invalidateQueries({ queryKey: ['customers'] })
  }
  return {
    create: useMutation({
      mutationFn: async (input: ReservationInput) => {
        const { data: u } = await supabase.auth.getUser()
        const { data, error } = await supabase
          .from('reservations')
          .insert({ ...input, tenant_id: tenantId, created_by: u.user?.id })
          .select()
          .single()
        if (error) throw error
        return data as Reservation
      },
      onSuccess: invalidate,
    }),
    update: useMutation({
      mutationFn: async ({ id, patch }: { id: string; patch: Partial<Reservation> }) => {
        const { data, error } = await supabase.from('reservations').update(patch).eq('id', id).select().single()
        if (error) throw error
        return data as Reservation
      },
      onSuccess: invalidate,
    }),
    setStatus: useMutation({
      mutationFn: async ({ id, status, reason }: { id: string; status: ReservationStatus; reason?: string }) => {
        const patch: Partial<Reservation> = { status }
        if (status === 'cancelled') patch.cancel_reason = reason || 'Cancelado pelo estabelecimento'
        const { error } = await supabase.from('reservations').update(patch).eq('id', id)
        if (error) throw error
      },
      onSuccess: invalidate,
    }),
    remove: useMutation({
      mutationFn: async (id: string) => {
        const { error } = await supabase.from('reservations').delete().eq('id', id)
        if (error) throw error
      },
      onSuccess: invalidate,
    }),
  }
}

export function useTenantSlots(tenantId: string, dateKey: string | null, party: number, durationMin?: number, ignoreId?: string, areaId?: string | null, serviceId?: string | null, staffId?: string | null) {
  return useQuery({
    queryKey: ['slots', tenantId, dateKey, party, durationMin, ignoreId, areaId, serviceId, staffId],
    enabled: !!dateKey,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_tenant_slots', {
        p_tenant: tenantId, p_date: dateKey, p_party: party, p_duration: durationMin ?? null, p_ignore: ignoreId ?? null, p_area: areaId ?? null,
        p_service: serviceId ?? null, p_staff: staffId ?? null,
      })
      if (error) throw error
      return data as Slot[]
    },
  })
}

export function useBlocks(tenantId: string, from: string, to: string) {
  return useQuery({
    queryKey: ['blocks', tenantId, from, to],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('schedule_blocks')
        .select('*')
        .eq('tenant_id', tenantId)
        .lt('starts_at', to)
        .gt('ends_at', from)
        .order('starts_at')
      if (error) throw error
      return data as ScheduleBlock[]
    },
  })
}

export function useBlockMutations(tenantId: string) {
  const qc = useQueryClient()
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['blocks'] })
    void qc.invalidateQueries({ queryKey: ['slots'] })
  }
  return {
    create: useMutation({
      mutationFn: async (b: { starts_at: string; ends_at: string; reason?: string; staff_id?: string | null }) => {
        const { data: u } = await supabase.auth.getUser()
        const { error } = await supabase.from('schedule_blocks').insert({ ...b, tenant_id: tenantId, created_by: u.user?.id })
        if (error) throw error
      },
      onSuccess: invalidate,
    }),
    remove: useMutation({
      mutationFn: async (id: string) => {
        const { error } = await supabase.from('schedule_blocks').delete().eq('id', id)
        if (error) throw error
      },
      onSuccess: invalidate,
    }),
  }
}

export function useDashboard(tenantId: string, fromKey: string, toKey: string) {
  return useQuery({
    queryKey: ['dashboard', tenantId, fromKey, toKey],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('dashboard_metrics', { p_tenant: tenantId, p_from: fromKey, p_to: toKey })
      if (error) throw error
      return data as DashboardMetrics
    },
  })
}
