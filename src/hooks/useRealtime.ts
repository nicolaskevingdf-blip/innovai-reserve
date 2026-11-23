import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'

/**
 * Live agenda: any change to reservations / blocks / notifications of the
 * tenant invalidates the cached queries. RLS guarantees we only receive
 * rows of the current tenant.
 */
export function useTenantRealtime(tenantId: string | undefined, onNewNotification?: (title: string, body: string) => void) {
  const qc = useQueryClient()
  useEffect(() => {
    if (!tenantId) return
    const channel = supabase
      .channel(`tenant:${tenantId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'reservations', filter: `tenant_id=eq.${tenantId}` }, () => {
        void qc.invalidateQueries({ queryKey: ['reservations'] })
        void qc.invalidateQueries({ queryKey: ['dashboard'] })
        void qc.invalidateQueries({ queryKey: ['customers'] })
        void qc.invalidateQueries({ queryKey: ['slots'] })
        void qc.invalidateQueries({ queryKey: ['floor', 'free'] })
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'schedule_blocks', filter: `tenant_id=eq.${tenantId}` }, () => {
        void qc.invalidateQueries({ queryKey: ['blocks'] })
        void qc.invalidateQueries({ queryKey: ['slots'] })
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'waitlist_entries', filter: `tenant_id=eq.${tenantId}` }, () => {
        void qc.invalidateQueries({ queryKey: ['waitlist'] })
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'staff', filter: `tenant_id=eq.${tenantId}` }, () => {
        void qc.invalidateQueries({ queryKey: ['staff'] })
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'dining_tables', filter: `tenant_id=eq.${tenantId}` }, () => {
        void qc.invalidateQueries({ queryKey: ['floor'] })
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications', filter: `tenant_id=eq.${tenantId}` }, (payload) => {
        void qc.invalidateQueries({ queryKey: ['notifications'] })
        const n = payload.new as { channel?: string; title?: string; body?: string }
        if (n.channel === 'in_app' && onNewNotification) onNewNotification(n.title ?? 'Notificação', n.body ?? '')
      })
      .subscribe()
    return () => { void supabase.removeChannel(channel) }
  }, [tenantId, qc, onNewNotification])
}
