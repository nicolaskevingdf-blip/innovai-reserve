import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import type { AppNotification } from '@/types/db'

export function useNotifications(tenantId: string, scope: 'inbox' | 'outbox') {
  return useQuery({
    queryKey: ['notifications', tenantId, scope],
    queryFn: async () => {
      let q = supabase.from('notifications').select('*').eq('tenant_id', tenantId).order('created_at', { ascending: false }).limit(100)
      q = scope === 'inbox' ? q.eq('channel', 'in_app') : q.neq('channel', 'in_app')
      const { data, error } = await q
      if (error) throw error
      return data as AppNotification[]
    },
  })
}

export function useUnreadCount(tenantId: string) {
  return useQuery({
    queryKey: ['notifications', tenantId, 'unread'],
    queryFn: async () => {
      const { count, error } = await supabase
        .from('notifications')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId)
        .eq('channel', 'in_app')
        .is('read_at', null)
      if (error) throw error
      return count ?? 0
    },
  })
}

export function useMarkRead(tenantId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id?: string) => {
      let q = supabase.from('notifications').update({ read_at: new Date().toISOString() }).eq('tenant_id', tenantId).eq('channel', 'in_app').is('read_at', null)
      if (id) q = q.eq('id', id)
      const { error } = await q
      if (error) throw error
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  })
}
