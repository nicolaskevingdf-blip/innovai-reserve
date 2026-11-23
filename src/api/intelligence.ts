import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FunctionsHttpError } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'
import type { AutomationKind, AutomationRule, Insight, ReportData } from '@/types/db'

export function useInsights(tenantId: string) {
  return useQuery({
    queryKey: ['insights', tenantId],
    staleTime: 300_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('tenant_insights', { p_tenant: tenantId })
      if (error) throw error
      return data as Insight[]
    },
  })
}

export function useReport(tenantId: string, fromKey: string, toKey: string, enabled: boolean) {
  return useQuery({
    queryKey: ['report', tenantId, fromKey, toKey],
    enabled,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('report_data', { p_tenant: tenantId, p_from: fromKey, p_to: toKey })
      if (error) throw error
      return data as ReportData
    },
  })
}

export function useAutomations(tenantId: string) {
  return useQuery({
    queryKey: ['automations', tenantId],
    queryFn: async () => {
      const { data, error } = await supabase.from('automation_rules').select('*').eq('tenant_id', tenantId)
      if (error) throw error
      return data as AutomationRule[]
    },
  })
}

export function useAutomationPreview(tenantId: string, kind: AutomationKind, days: number, channel: 'whatsapp' | 'email') {
  return useQuery({
    queryKey: ['automations', 'preview', tenantId, kind, days, channel],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('preview_automation', { p_tenant: tenantId, p_kind: kind, p_days: days, p_channel: channel })
      if (error) throw error
      return data as { count: number; sample: string[] }
    },
  })
}

export function useSaveAutomation(tenantId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (r: Pick<AutomationRule, 'kind' | 'enabled' | 'channel' | 'days' | 'message'>) => {
      const { error } = await supabase.from('automation_rules').upsert({ ...r, tenant_id: tenantId }, { onConflict: 'tenant_id,kind' })
      if (error) throw error
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['automations'] })
      void qc.invalidateQueries({ queryKey: ['insights'] })
    },
  })
}

export interface AssistantTurn { role: 'user' | 'assistant'; content: string }
export class AssistantError extends Error {
  constructor(message: string, readonly code?: string) { super(message) }
}

/** Calls the ai-assistant Edge Function (runs with the user's own permissions). */
export async function askAssistant(tenantId: string, question: string, history: AssistantTurn[]) {
  const { data, error } = await supabase.functions.invoke('ai-assistant', { body: { tenant_id: tenantId, question, history } })
  if (error) {
    if (error instanceof FunctionsHttpError) {
      const body = await error.context.json().catch(() => ({}))
      throw new AssistantError(body.error ?? 'O assistente não respondeu.', body.code)
    }
    throw new AssistantError('O assistente de IA não está disponível neste ambiente. Publique a Edge Function ai-assistant.', 'AI_UNAVAILABLE')
  }
  return data as { answer: string; tools_used: string[] }
}
