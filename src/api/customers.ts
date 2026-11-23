import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import type { Customer, CustomerInsights, CustomerStats, Reservation } from '@/types/db'

export type CustomerSegment = 'all' | 'recurring' | 'new' | 'inactive' | 'no_show'

export function useCustomers(tenantId: string, search: string, segment: CustomerSegment, sort: 'name' | 'recent' | 'visits') {
  return useQuery({
    queryKey: ['customers', tenantId, search, segment, sort],
    queryFn: async () => {
      let q = supabase.from('customer_stats').select('*').eq('tenant_id', tenantId).limit(500)
      const s = search.trim().replace(/[%,()]/g, ' ')
      if (s) {
        const d = s.replace(/\D/g, '')
        q = q.or([`name.ilike.%${s}%`, `email.ilike.%${s}%`, d.length >= 3 ? `phone_normalized.ilike.%${d}%` : null].filter(Boolean).join(','))
      }
      if (segment === 'recurring') q = q.gte('visits', 2)
      if (segment === 'new') q = q.gte('created_at', new Date(Date.now() - 30 * 864e5).toISOString())
      if (segment === 'inactive') q = q.gte('visits', 1).lt('last_visit_at', new Date(Date.now() - 60 * 864e5).toISOString())
      if (segment === 'no_show') q = q.gt('no_shows', 0)
      q = sort === 'name' ? q.order('name') : sort === 'visits' ? q.order('visits', { ascending: false }) : q.order('created_at', { ascending: false })
      const { data, error } = await q
      if (error) throw error
      return data as CustomerStats[]
    },
  })
}

export function useCustomerInsights(tenantId: string) {
  return useQuery({
    queryKey: ['customers', 'insights', tenantId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('customer_insights', { p_tenant: tenantId })
      if (error) throw error
      return data as CustomerInsights
    },
  })
}

export function useCustomerHistory(customerId: string | undefined) {
  return useQuery({
    queryKey: ['customers', 'history', customerId],
    enabled: !!customerId,
    queryFn: async () => {
      const { data, error } = await supabase.from('reservations').select('*').eq('customer_id', customerId!).order('starts_at', { ascending: false }).limit(100)
      if (error) throw error
      return data as Reservation[]
    },
  })
}

export function useCustomerSearch(tenantId: string, term: string) {
  return useQuery({
    queryKey: ['customers', 'search', tenantId, term],
    enabled: term.trim().length >= 2,
    queryFn: async () => {
      const s = term.trim().replace(/[%,()]/g, ' ')
      const d = s.replace(/\D/g, '')
      const { data, error } = await supabase
        .from('customers')
        .select('*')
        .eq('tenant_id', tenantId)
        .or([`name.ilike.%${s}%`, d.length >= 3 ? `phone_normalized.ilike.%${d}%` : null].filter(Boolean).join(','))
        .limit(6)
      if (error) throw error
      return data as Customer[]
    },
  })
}

export function useCustomerMutations(tenantId: string) {
  const qc = useQueryClient()
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['customers'] })
  return {
    save: useMutation({
      mutationFn: async (c: Partial<Customer> & { name: string; phone: string }) => {
        const payload = {
          name: c.name, phone: c.phone, email: c.email || null, birthday: c.birthday || null,
          preferences: c.preferences || null, notes: c.notes || null, tags: c.tags ?? [], marketing_opt_in: c.marketing_opt_in ?? false,
        }
        const { error } = c.id
          ? await supabase.from('customers').update(payload).eq('id', c.id)
          : await supabase.from('customers').insert({ ...payload, tenant_id: tenantId, phone_normalized: c.phone.replace(/\D/g, '') })
        if (error) throw error
      },
      onSuccess: invalidate,
    }),
    remove: useMutation({
      mutationFn: async (id: string) => {
        const { error } = await supabase.from('customers').delete().eq('id', id)
        if (error) throw error
      },
      onSuccess: invalidate,
    }),
  }
}
