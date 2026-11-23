import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import type { Service, ServiceStaff, Staff, StaffHour, StaffMetrics } from '@/types/db'

export function useStaff(tenantId: string) {
  return useQuery({
    queryKey: ['staff', 'list', tenantId],
    queryFn: async () => {
      const { data, error } = await supabase.from('staff').select('*').eq('tenant_id', tenantId).order('sort_order').order('name')
      if (error) throw error
      return data as Staff[]
    },
  })
}

export function useServices(tenantId: string) {
  return useQuery({
    queryKey: ['staff', 'services', tenantId],
    queryFn: async () => {
      const { data, error } = await supabase.from('services').select('*').eq('tenant_id', tenantId).order('sort_order').order('name')
      if (error) throw error
      return data as Service[]
    },
  })
}

export function useServiceStaff(tenantId: string) {
  return useQuery({
    queryKey: ['staff', 'links', tenantId],
    queryFn: async () => {
      const { data, error } = await supabase.from('service_staff').select('service_id, staff_id').eq('tenant_id', tenantId)
      if (error) throw error
      return data as ServiceStaff[]
    },
  })
}

export function useStaffHours(tenantId: string) {
  return useQuery({
    queryKey: ['staff', 'hours', tenantId],
    queryFn: async () => {
      const { data, error } = await supabase.from('staff_hours').select('*').eq('tenant_id', tenantId).order('weekday').order('opens_at')
      if (error) throw error
      return data as StaffHour[]
    },
  })
}

export function useFreeStaff(tenantId: string, start: string | null, end: string | null, serviceId?: string | null, ignoreId?: string) {
  return useQuery({
    queryKey: ['staff', 'free', tenantId, start, end, serviceId, ignoreId],
    enabled: !!start && !!end,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_free_staff', { p_tenant: tenantId, p_start: start, p_end: end, p_service: serviceId ?? null, p_ignore: ignoreId ?? null })
      if (error) throw error
      return new Map((data as { staff_id: string; is_free: boolean; is_working: boolean; is_qualified: boolean }[]).map((r) => [r.staff_id, r]))
    },
  })
}

export function useStaffMetrics(tenantId: string, fromKey: string, toKey: string, enabled = true) {
  return useQuery({
    queryKey: ['dashboard', 'staff', tenantId, fromKey, toKey],
    enabled,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('staff_service_metrics', { p_tenant: tenantId, p_from: fromKey, p_to: toKey })
      if (error) throw error
      return data as StaffMetrics
    },
  })
}

/** "Qualified" mirrors the database rule: a service without explicit professionals can be done by anyone. */
export const qualifiedStaff = (staff: Staff[], links: ServiceStaff[], serviceId: string | null) => {
  if (!serviceId) return staff
  const linked = links.filter((l) => l.service_id === serviceId).map((l) => l.staff_id)
  return linked.length ? staff.filter((s) => linked.includes(s.id)) : staff
}

export function useStaffMutations(tenantId: string) {
  const qc = useQueryClient()
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['staff'] })
    void qc.invalidateQueries({ queryKey: ['slots'] })
  }
  return {
    saveStaff: useMutation({
      mutationFn: async ({ staff, hours, serviceIds }: {
        staff: Partial<Staff> & { name: string }; hours: { weekday: number; opens_at: string; closes_at: string }[]; serviceIds: string[]
      }) => {
        const payload = {
          name: staff.name.trim(), specialty: staff.specialty || null, bio: staff.bio || null, photo_url: staff.photo_url ?? null,
          color: staff.color ?? '#C6F432', is_active: staff.is_active ?? true, member_id: staff.member_id || null, sort_order: staff.sort_order ?? 0,
        }
        let id = staff.id
        if (id) {
          const { error } = await supabase.from('staff').update(payload).eq('id', id)
          if (error) throw error
        } else {
          const { data, error } = await supabase.from('staff').insert({ ...payload, tenant_id: tenantId }).select('id').single()
          if (error) throw error
          id = data.id as string
        }
        const { error } = await supabase.rpc('save_staff_profile', { p_staff: id, p_hours: hours, p_service_ids: serviceIds })
        if (error) throw error
        return id
      },
      onSuccess: invalidate,
    }),
    deleteStaff: useMutation({
      mutationFn: async (id: string) => {
        const { error } = await supabase.from('staff').delete().eq('id', id)
        if (error) throw error
      },
      onSuccess: invalidate,
    }),
    saveService: useMutation({
      mutationFn: async ({ service, staffIds }: { service: Partial<Service> & { name: string; duration_min: number }; staffIds: string[] }) => {
        const payload = {
          name: service.name.trim(), description: service.description || null, price_cents: service.price_cents ?? null,
          duration_min: service.duration_min, buffer_min: service.buffer_min ?? 0, is_active: service.is_active ?? true, sort_order: service.sort_order ?? 0,
        }
        let id = service.id
        if (id) {
          const { error } = await supabase.from('services').update(payload).eq('id', id)
          if (error) throw error
        } else {
          const { data, error } = await supabase.from('services').insert({ ...payload, tenant_id: tenantId }).select('id').single()
          if (error) throw error
          id = data.id as string
        }
        const del = await supabase.from('service_staff').delete().eq('service_id', id)
        if (del.error) throw del.error
        if (staffIds.length) {
          const ins = await supabase.from('service_staff').insert(staffIds.map((s) => ({ tenant_id: tenantId, service_id: id, staff_id: s })))
          if (ins.error) throw ins.error
        }
        return id
      },
      onSuccess: invalidate,
    }),
    deleteService: useMutation({
      mutationFn: async (id: string) => {
        const { error } = await supabase.from('services').delete().eq('id', id)
        if (error) throw error
      },
      onSuccess: invalidate,
    }),
  }
}
