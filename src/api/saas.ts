import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/hooks/useAuth'
import type {
  AdminOverview, AdminTenantRow, Plan, PlanUsage, Segment, SubscriptionStatus, SupportMessage, SupportTicket, TenantStatus, TicketCategory, TicketStatus,
} from '@/types/db'

export function useIsPlatformAdmin() {
  const { user } = useAuth()
  return useQuery({
    queryKey: ['platform-admin', user?.id],
    enabled: !!user,
    staleTime: 300_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('is_platform_admin')
      if (error) throw error
      return Boolean(data)
    },
  })
}

export function usePlanUsage(tenantId: string) {
  return useQuery({
    queryKey: ['plan-usage', tenantId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_plan_usage', { p_tenant: tenantId })
      if (error) throw error
      return data as PlanUsage
    },
  })
}

/* ------------------------------- support ------------------------------- */
export function useTickets(tenantId: string) {
  return useQuery({
    queryKey: ['support', 'tickets', tenantId],
    queryFn: async () => {
      const { data, error } = await supabase.from('support_tickets').select('*').eq('tenant_id', tenantId).order('updated_at', { ascending: false })
      if (error) throw error
      return data as SupportTicket[]
    },
  })
}

export function useTicketMessages(ticketId: string | undefined) {
  return useQuery({
    queryKey: ['support', 'messages', ticketId],
    enabled: !!ticketId,
    refetchInterval: 20_000,
    queryFn: async () => {
      const { data, error } = await supabase.from('support_messages').select('*').eq('ticket_id', ticketId!).order('created_at')
      if (error) throw error
      return data as SupportMessage[]
    },
  })
}

export function useSupportMutations() {
  const qc = useQueryClient()
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['support'] })
  return {
    open: useMutation({
      mutationFn: async ({ tenantId, subject, category, body }: { tenantId: string; subject: string; category: TicketCategory; body: string }) => {
        const { data: u } = await supabase.auth.getUser()
        const { data, error } = await supabase.from('support_tickets')
          .insert({ tenant_id: tenantId, subject, category, created_by: u.user?.id }).select().single()
        if (error) throw error
        const m = await supabase.from('support_messages').insert({ ticket_id: data.id, author_id: u.user?.id, body })
        if (m.error) throw m.error
        return data as SupportTicket
      },
      onSuccess: invalidate,
    }),
    reply: useMutation({
      mutationFn: async ({ ticketId, body }: { ticketId: string; body: string }) => {
        const { data: u } = await supabase.auth.getUser()
        const { error } = await supabase.from('support_messages').insert({ ticket_id: ticketId, author_id: u.user?.id, body })
        if (error) throw error
      },
      onSuccess: invalidate,
    }),
    setStatus: useMutation({
      mutationFn: async ({ ticketId, status }: { ticketId: string; status: TicketStatus }) => {
        const { error } = await supabase.from('support_tickets').update({ status, updated_at: new Date().toISOString() }).eq('id', ticketId)
        if (error) throw error
      },
      onSuccess: invalidate,
    }),
  }
}

/* -------------------------------- admin -------------------------------- */
export function useAdminOverview() {
  return useQuery({
    queryKey: ['admin', 'overview'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('admin_overview')
      if (error) throw error
      return data as AdminOverview
    },
  })
}

export function useAdminTenants(search: string, status: string) {
  return useQuery({
    queryKey: ['admin', 'tenants', search, status],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('admin_list_tenants', { p_search: search.trim() || null, p_status: status || null })
      if (error) throw error
      return data as AdminTenantRow[]
    },
  })
}

export function useAdminTickets(status: string) {
  return useQuery({
    queryKey: ['support', 'admin', status],
    refetchInterval: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('admin_list_tickets', { p_status: status || null })
      if (error) throw error
      return data as SupportTicket[]
    },
  })
}

export function useAllPlans() {
  return useQuery({
    queryKey: ['admin', 'plans'],
    queryFn: async () => {
      const { data, error } = await supabase.from('plans').select('*').order('sort_order')
      if (error) throw error
      return data as (Plan & { is_active: boolean })[]
    },
  })
}

export interface AdminTenantPatch {
  status?: TenantStatus | null
  plan_code?: string | null
  subscription_status?: SubscriptionStatus | null
  trial_ends_at?: string | null
  period_end?: string | null
  feature_overrides?: Record<string, unknown> | null
  custom_domain?: string | null
  internal_notes?: string | null
}

export function useAdminMutations() {
  const qc = useQueryClient()
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['admin'] })
    void qc.invalidateQueries({ queryKey: ['plan-usage'] })
    void qc.invalidateQueries({ queryKey: ['memberships'] })
  }
  return {
    updateTenant: useMutation({
      mutationFn: async ({ id, patch }: { id: string; patch: AdminTenantPatch }) => {
        const { error } = await supabase.rpc('admin_update_tenant', {
          p_tenant: id, p_status: patch.status ?? null, p_plan_code: patch.plan_code ?? null,
          p_subscription_status: patch.subscription_status ?? null, p_trial_ends_at: patch.trial_ends_at ?? null,
          p_period_end: patch.period_end ?? null, p_feature_overrides: patch.feature_overrides ?? null,
          p_custom_domain: patch.custom_domain ?? null, p_internal_notes: patch.internal_notes ?? null,
        })
        if (error) throw error
      },
      onSuccess: invalidate,
    }),
    createTenant: useMutation({
      mutationFn: async (t: { name: string; slug: string; segment: Segment; owner_email: string; plan_code: string; trial_days: number }) => {
        const { data, error } = await supabase.rpc('admin_create_tenant', {
          p_name: t.name, p_slug: t.slug, p_segment: t.segment, p_owner_email: t.owner_email, p_plan_code: t.plan_code, p_trial_days: t.trial_days,
        })
        if (error) throw error
        return data as string
      },
      onSuccess: invalidate,
    }),
    savePlan: useMutation({
      mutationFn: async (p: Partial<Plan> & { id: string; is_active?: boolean }) => {
        const { id, ...patch } = p
        const { error } = await supabase.from('plans').update(patch).eq('id', id)
        if (error) throw error
      },
      onSuccess: invalidate,
    }),
  }
}

export const FEATURES: Record<string, string> = {
  public_page: 'Página pública de reservas',
  crm: 'CRM de clientes',
  tables_map: 'Mapa de mesas / agenda por profissional',
  whatsapp: 'Automação por WhatsApp',
  reports_advanced: 'Relatórios avançados',
  ai_insights: 'Insights com IA',
}

export const LIMITS: Record<string, string> = {
  max_members: 'Usuários',
  max_reservations_month: 'Reservas por mês',
  max_resources: 'Mesas + profissionais',
}

export const SUB_STATUS: Record<SubscriptionStatus, { label: string; chip: string }> = {
  trialing: { label: 'Em teste', chip: 'border-sky-400/30 bg-sky-400/10 text-sky-300' },
  active: { label: 'Ativa', chip: 'border-lime/30 bg-lime/10 text-lime' },
  past_due: { label: 'Pagamento pendente', chip: 'border-amber-400/30 bg-amber-400/10 text-amber-300' },
  cancelled: { label: 'Cancelada', chip: 'border-ink-500 bg-ink-700/60 text-ink-300' },
  suspended: { label: 'Suspensa', chip: 'border-rose-400/30 bg-rose-400/10 text-rose-300' },
}

export const TICKET_STATUS: Record<TicketStatus, { label: string; chip: string }> = {
  open: { label: 'Aberto', chip: 'border-amber-400/30 bg-amber-400/10 text-amber-300' },
  waiting: { label: 'Aguardando cliente', chip: 'border-sky-400/30 bg-sky-400/10 text-sky-300' },
  answered: { label: 'Respondido', chip: 'border-lime/30 bg-lime/10 text-lime' },
  closed: { label: 'Encerrado', chip: 'border-ink-500 bg-ink-700/60 text-ink-300' },
}

export const TICKET_CATEGORY: Record<TicketCategory, string> = {
  question: 'Dúvida', bug: 'Problema técnico', billing: 'Cobrança', upgrade: 'Mudança de plano', feature: 'Sugestão',
}
