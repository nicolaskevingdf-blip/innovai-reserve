import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import type { WaitlistEntry, WaitlistStatus } from '@/types/db'

export function useWaitlist(tenantId: string, dateKey: string, onlyOpen: boolean) {
  return useQuery({
    queryKey: ['waitlist', tenantId, dateKey, onlyOpen],
    queryFn: async () => {
      let q = supabase.from('waitlist_entries').select('*').eq('tenant_id', tenantId).eq('desired_date', dateKey)
        .order('created_at')
      if (onlyOpen) q = q.in('status', ['waiting', 'notified'])
      const { data, error } = await q
      if (error) throw error
      return data as WaitlistEntry[]
    },
  })
}

export function useWaitlistCount(tenantId: string, dateKey: string) {
  return useQuery({
    queryKey: ['waitlist', tenantId, 'count', dateKey],
    queryFn: async () => {
      const { count, error } = await supabase.from('waitlist_entries').select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId).gte('desired_date', dateKey).eq('status', 'waiting')
      if (error) throw error
      return count ?? 0
    },
  })
}

export function useWaitlistMutations(tenantId: string) {
  const qc = useQueryClient()
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['waitlist'] })
  return {
    create: useMutation({
      mutationFn: async (w: Pick<WaitlistEntry, 'customer_name' | 'customer_phone' | 'desired_date' | 'party_size'> & Partial<WaitlistEntry>) => {
        const { error } = await supabase.from('waitlist_entries').insert({
          tenant_id: tenantId, customer_name: w.customer_name, customer_phone: w.customer_phone, desired_date: w.desired_date,
          desired_time: w.desired_time || null, party_size: w.party_size, notes: w.notes || null, area_id: w.area_id ?? null, source: w.source ?? 'phone',
        })
        if (error) throw error
      },
      onSuccess: invalidate,
    }),
    setStatus: useMutation({
      mutationFn: async ({ id, status, reservationId }: { id: string; status: WaitlistStatus; reservationId?: string }) => {
        const { error } = await supabase.from('waitlist_entries').update({ status, ...(reservationId ? { reservation_id: reservationId } : {}) }).eq('id', id)
        if (error) throw error
      },
      onSuccess: invalidate,
    }),
    notify: useMutation({
      mutationFn: async (id: string) => {
        const { data, error } = await supabase.rpc('notify_waitlist_entry', { p_entry: id })
        if (error) throw error
        return data as { message: string; phone: string; queued: boolean }
      },
      onSuccess: invalidate,
    }),
  }
}
