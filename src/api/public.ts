import { supabase } from '@/lib/supabase'
import type { PublicPage, PublicReservation, Slot } from '@/types/db'

export async function getPublicPage(slug: string) {
  const { data, error } = await supabase.rpc('get_public_page', { p_slug: slug })
  if (error) throw error
  return data as PublicPage
}

export async function getAvailableSlots(slug: string, dateKey: string, party: number, serviceId?: string | null, areaId?: string | null, staffId?: string | null) {
  const { data, error } = await supabase.rpc('get_available_slots', { p_slug: slug, p_date: dateKey, p_party_size: party, p_service_id: serviceId ?? null, p_area_id: areaId ?? null, p_staff_id: staffId ?? null })
  if (error) throw error
  return data as Slot[]
}

export async function getAvailableDays(slug: string, fromKey: string, toKey: string, party: number, serviceId?: string | null, areaId?: string | null, staffId?: string | null) {
  const { data, error } = await supabase.rpc('get_available_days', { p_slug: slug, p_from: fromKey, p_to: toKey, p_party_size: party, p_service_id: serviceId ?? null, p_area_id: areaId ?? null, p_staff_id: staffId ?? null })
  if (error) throw error
  return new Set((data as { day: string }[]).map((d) => d.day))
}

export async function createPublicReservation(input: {
  slug: string; startsAt: string; party: number; name: string; phone: string; email?: string; notes?: string; serviceId?: string | null; areaId?: string | null; staffId?: string | null
}) {
  const { data, error } = await supabase.rpc('create_public_reservation', {
    p_slug: input.slug, p_starts_at: input.startsAt, p_party_size: input.party, p_name: input.name, p_phone: input.phone,
    p_email: input.email || null, p_notes: input.notes || null, p_service_id: input.serviceId ?? null, p_area_id: input.areaId ?? null, p_staff_id: input.staffId ?? null,
  })
  if (error) throw error
  return data as { code: string; status: string; starts_at: string; ends_at: string; party_size: number; tenant_name: string; tenant_slug: string; timezone: string; area_name: string | null; staff_name: string | null }
}

export async function getPublicReservation(code: string, phone: string) {
  const { data, error } = await supabase.rpc('get_public_reservation', { p_code: code, p_phone: phone })
  if (error) throw error
  return data as PublicReservation
}

export async function cancelPublicReservation(code: string, phone: string, reason?: string) {
  const { data, error } = await supabase.rpc('cancel_public_reservation', { p_code: code, p_phone: phone, p_reason: reason || null })
  if (error) throw error
  return data as PublicReservation
}

export async function getRescheduleSlots(code: string, phone: string, dateKey: string) {
  const { data, error } = await supabase.rpc('get_reschedule_slots', { p_code: code, p_phone: phone, p_date: dateKey })
  if (error) throw error
  return data as Slot[]
}

export async function reschedulePublicReservation(code: string, phone: string, newStart: string) {
  const { data, error } = await supabase.rpc('reschedule_public_reservation', { p_code: code, p_phone: phone, p_new_start: newStart })
  if (error) throw error
  return data as PublicReservation
}

export async function joinWaitlist(input: {
  slug: string; dateKey: string; time?: string | null; party: number; name: string; phone: string; email?: string; notes?: string; areaId?: string | null
}) {
  const { data, error } = await supabase.rpc('join_waitlist', {
    p_slug: input.slug, p_date: input.dateKey, p_time: input.time || null, p_party_size: input.party, p_name: input.name,
    p_phone: input.phone, p_email: input.email || null, p_notes: input.notes || null, p_area_id: input.areaId ?? null,
  })
  if (error) throw error
  return data as { id: string; position: number }
}
