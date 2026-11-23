import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import type { Area, DiningTable, TableCombination } from '@/types/db'

export function useAreas(tenantId: string) {
  return useQuery({
    queryKey: ['floor', 'areas', tenantId],
    queryFn: async () => {
      const { data, error } = await supabase.from('areas').select('*').eq('tenant_id', tenantId).order('sort_order').order('name')
      if (error) throw error
      return data as Area[]
    },
  })
}

export function useTables(tenantId: string) {
  return useQuery({
    queryKey: ['floor', 'tables', tenantId],
    queryFn: async () => {
      const { data, error } = await supabase.from('dining_tables').select('*').eq('tenant_id', tenantId).order('name')
      if (error) throw error
      return (data as DiningTable[]).map((t) => ({ ...t, pos_x: Number(t.pos_x), pos_y: Number(t.pos_y), width: Number(t.width), height: Number(t.height) }))
    },
  })
}

export function useCombinations(tenantId: string) {
  return useQuery({
    queryKey: ['floor', 'combinations', tenantId],
    queryFn: async () => {
      const { data, error } = await supabase.from('table_combinations').select('*').eq('tenant_id', tenantId).order('max_capacity')
      if (error) throw error
      return data as TableCombination[]
    },
  })
}

export function useFreeTables(tenantId: string, start: string | null, end: string | null, ignoreId?: string) {
  return useQuery({
    queryKey: ['floor', 'free', tenantId, start, end, ignoreId],
    enabled: !!start && !!end,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_free_tables', { p_tenant: tenantId, p_start: start, p_end: end, p_ignore: ignoreId ?? null })
      if (error) throw error
      return new Map((data as { table_id: string; is_free: boolean }[]).map((r) => [r.table_id, r.is_free]))
    },
  })
}

export function useFloorOccupancy(tenantId: string, fromKey: string, toKey: string, enabled: boolean) {
  return useQuery({
    queryKey: ['dashboard', 'floor', tenantId, fromKey, toKey],
    enabled,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('floor_occupancy', { p_tenant: tenantId, p_from: fromKey, p_to: toKey })
      if (error) throw error
      return data as number | null
    },
  })
}

export function useFloorMutations(tenantId: string) {
  const qc = useQueryClient()
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['floor'] })
    void qc.invalidateQueries({ queryKey: ['slots'] })
  }
  const run = async (p: PromiseLike<{ error: unknown }>) => {
    const { error } = await p
    if (error) throw error
  }
  return {
    saveArea: useMutation({
      mutationFn: (a: Partial<Area> & { name: string }) =>
        run(a.id ? supabase.from('areas').update({ name: a.name, description: a.description ?? null, is_active: a.is_active ?? true, sort_order: a.sort_order ?? 0 }).eq('id', a.id)
          : supabase.from('areas').insert({ tenant_id: tenantId, name: a.name, description: a.description ?? null, sort_order: a.sort_order ?? 0 })),
      onSuccess: invalidate,
    }),
    deleteArea: useMutation({ mutationFn: (id: string) => run(supabase.from('areas').delete().eq('id', id)), onSuccess: invalidate }),
    saveTable: useMutation({
      mutationFn: (t: Partial<DiningTable> & { name: string; max_capacity: number }) => {
        const payload = {
          name: t.name.trim(), area_id: t.area_id ?? null, min_capacity: t.min_capacity ?? 1, max_capacity: t.max_capacity,
          shape: t.shape ?? 'square', width: t.width ?? 80, height: t.height ?? 80, combinable: t.combinable ?? true, is_active: t.is_active ?? true,
          ...(t.pos_x != null ? { pos_x: t.pos_x, pos_y: t.pos_y } : {}),
        }
        return run(t.id ? supabase.from('dining_tables').update(payload).eq('id', t.id) : supabase.from('dining_tables').insert({ ...payload, tenant_id: tenantId }))
      },
      onSuccess: invalidate,
    }),
    deleteTable: useMutation({ mutationFn: (id: string) => run(supabase.from('dining_tables').delete().eq('id', id)), onSuccess: invalidate }),
    saveLayout: useMutation({
      mutationFn: (tables: Pick<DiningTable, 'id' | 'pos_x' | 'pos_y'>[]) =>
        run(supabase.rpc('save_floor_layout', { p_tenant: tenantId, p_tables: tables.map((t) => ({ id: t.id, pos_x: Math.round(t.pos_x), pos_y: Math.round(t.pos_y) })) })),
      onSuccess: invalidate,
    }),
    saveCombination: useMutation({
      mutationFn: (c: Partial<TableCombination> & { name: string; table_ids: string[]; max_capacity: number }) => {
        const payload = { name: c.name, table_ids: c.table_ids, min_capacity: c.min_capacity ?? 1, max_capacity: c.max_capacity, is_active: c.is_active ?? true }
        return run(c.id ? supabase.from('table_combinations').update(payload).eq('id', c.id) : supabase.from('table_combinations').insert({ ...payload, tenant_id: tenantId }))
      },
      onSuccess: invalidate,
    }),
    deleteCombination: useMutation({ mutationFn: (id: string) => run(supabase.from('table_combinations').delete().eq('id', id)), onSuccess: invalidate }),
  }
}
