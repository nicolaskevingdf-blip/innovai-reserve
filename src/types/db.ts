export type Segment = 'restaurant' | 'barbershop' | 'salon' | 'clinic' | 'other'
export type MemberRole = 'owner' | 'manager' | 'staff'
export type TenantStatus = 'active' | 'suspended' | 'cancelled'
export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'cancelled' | 'suspended'
export type ReservationStatus = 'pending' | 'confirmed' | 'in_progress' | 'completed' | 'cancelled' | 'no_show'
export type ReservationSource = 'online' | 'manual' | 'phone' | 'walk_in' | 'whatsapp' | 'instagram'
export type NotificationChannel = 'in_app' | 'email' | 'whatsapp' | 'push' | 'sms'
export type AllocationMode = 'capacity' | 'tables' | 'staff'
export type NotificationStatus = 'pending' | 'sent' | 'failed' | 'skipped' | 'requires_setup' | 'cancelled'

export interface Tenant {
  id: string
  slug: string
  name: string
  segment: Segment
  status: TenantStatus
  timezone: string
  locale: string
  description: string | null
  logo_url: string | null
  cover_url: string | null
  brand_color: string
  phone: string | null
  whatsapp: string | null
  email: string | null
  website: string | null
  instagram: string | null
  facebook: string | null
  address_line: string | null
  address_number: string | null
  address_complement: string | null
  neighborhood: string | null
  city: string | null
  state: string | null
  postal_code: string | null
  country: string
  plan_id: string | null
  created_at: string
}

export interface Membership {
  id: string
  tenant_id: string
  user_id: string
  role: MemberRole
  is_active: boolean
  tenant: Tenant
}

export interface Plan {
  id: string
  code: string
  name: string
  description: string | null
  price_cents: number
  currency: string
  limits: Record<string, number | null>
  features: Record<string, boolean>
  sort_order: number
}

export interface Subscription {
  id: string
  tenant_id: string
  plan_id: string
  status: SubscriptionStatus
  trial_ends_at: string | null
  current_period_end: string | null
  plan?: Plan
}

export interface BookingSettings {
  tenant_id: string
  booking_enabled: boolean
  slot_interval_min: number
  default_duration_min: number
  buffer_min: number
  min_advance_min: number
  max_advance_days: number
  min_party_size: number
  max_party_size: number
  max_reservations_per_slot: number | null
  max_guests_per_slot: number | null
  require_confirmation: boolean
  allow_online_cancel: boolean
  allow_online_reschedule: boolean
  cancellation_min_notice_min: number
  max_active_per_phone: number
  booking_message: string | null
  cancellation_policy: string | null
  allocation_mode: AllocationMode
}

export interface NotificationSettings {
  tenant_id: string
  notify_owner_new_reservation: boolean
  email_enabled: boolean
  whatsapp_enabled: boolean
  push_enabled: boolean
  reminder_enabled: boolean
  reminder_hours_before: number
  review_request_enabled: boolean
}

export interface BusinessHour {
  id: string
  tenant_id: string
  weekday: number
  opens_at: string
  closes_at: string
  label: string | null
}

export interface ScheduleBlock {
  id: string
  tenant_id: string
  staff_id: string | null
  table_id: string | null
  starts_at: string
  ends_at: string
  reason: string | null
  created_at: string
}

export interface Customer {
  id: string
  tenant_id: string
  name: string
  phone: string
  phone_normalized: string
  email: string | null
  birthday: string | null
  preferences: string | null
  notes: string | null
  tags: string[]
  marketing_opt_in: boolean
  created_at: string
}

export interface CustomerStats extends Customer {
  reservations_count: number
  visits: number
  cancellations: number
  no_shows: number
  last_visit_at: string | null
  next_reservation_at: string | null
}

export interface Reservation {
  id: string
  tenant_id: string
  code: string
  customer_id: string | null
  customer_name: string
  customer_phone: string
  customer_phone_normalized: string
  customer_email: string | null
  starts_at: string
  ends_at: string
  party_size: number
  service_id: string | null
  staff_id: string | null
  table_id: string | null
  table_ids: string[]
  area_id: string | null
  occupied_until: string | null
  staff_requested: boolean
  status: ReservationStatus
  source: ReservationSource
  notes: string | null
  internal_notes: string | null
  cancel_reason: string | null
  confirmed_at: string | null
  checked_in_at: string | null
  completed_at: string | null
  cancelled_at: string | null
  created_at: string
  updated_at: string
}

export interface ReservationEvent {
  id: number
  reservation_id: string
  actor_id: string | null
  actor_type: 'staff' | 'customer' | 'system'
  action: string
  from_status: ReservationStatus | null
  to_status: ReservationStatus | null
  changes: Record<string, unknown>
  created_at: string
}

export interface AppNotification {
  id: string
  tenant_id: string
  reservation_id: string | null
  channel: NotificationChannel
  template: string
  audience: 'staff' | 'customer'
  recipient: string | null
  title: string | null
  body: string | null
  status: NotificationStatus
  scheduled_for: string
  sent_at: string | null
  read_at: string | null
  error: string | null
  created_at: string
}

export interface Slot {
  slot_start: string
  slot_end: string
  remaining_reservations?: number | null
  remaining_guests?: number | null
}

export interface TeamMember {
  member_id: string
  user_id: string
  email: string
  full_name: string | null
  role: MemberRole
  is_active: boolean
  created_at: string
}

export interface Invitation {
  id: string
  tenant_id: string
  email: string
  role: MemberRole
  accepted_at: string | null
  created_at: string
}

export interface DashboardMetrics {
  timezone: string
  period: { from: string; to: string; days: number }
  totals: {
    reservations: number
    active: number
    pending: number
    confirmed: number
    in_progress: number
    completed: number
    cancelled: number
    no_show: number
    guests: number
    new_customers: number
    online_share: number | null
  }
  previous: { reservations: number; cancelled: number; no_show: number; guests: number; new_customers: number }
  occupancy: number | null
  by_hour: { hour: number; count: number }[]
  by_day: { date: string; total: number; cancelled: number; guests: number }[]
  by_source: { source: ReservationSource; count: number }[]
  by_weekday: { weekday: number; count: number }[]
}

export interface CustomerInsights {
  total: number
  new_30d: number
  recurring: number
  inactive_60d: number
  with_no_show: number
  total_cancellations: number
  total_no_shows: number
  avg_days_between_visits: number | null
}

export interface PublicPage {
  tenant: Pick<
    Tenant,
    | 'id' | 'slug' | 'name' | 'segment' | 'timezone' | 'description' | 'logo_url' | 'cover_url' | 'brand_color'
    | 'phone' | 'whatsapp' | 'email' | 'website' | 'instagram' | 'facebook' | 'address_line' | 'address_number'
    | 'address_complement' | 'neighborhood' | 'city' | 'state' | 'postal_code'
  >
  settings: Pick<
    BookingSettings,
    | 'booking_enabled' | 'min_party_size' | 'max_party_size' | 'max_advance_days' | 'min_advance_min'
    | 'require_confirmation' | 'allow_online_cancel' | 'allow_online_reschedule' | 'cancellation_min_notice_min'
    | 'booking_message' | 'cancellation_policy' | 'default_duration_min' | 'allocation_mode'
  >
  areas: { id: string; name: string; description: string | null }[]
  staff: { id: string; name: string; photo_url: string | null; specialty: string | null; bio: string | null; service_ids: string[] }[]
  hours: { weekday: number; opens_at: string; closes_at: string; label: string | null }[]
  services: { id: string; name: string; description: string | null; price_cents: number | null; duration_min: number }[]
}

export interface PublicReservation {
  code: string
  status: ReservationStatus
  starts_at: string
  ends_at: string
  party_size: number
  customer_name: string
  notes: string | null
  service_name: string | null
  service_id: string | null
  staff_name: string | null
  staff_requested: boolean
  tenant: Pick<Tenant, 'name' | 'slug' | 'segment' | 'timezone' | 'logo_url' | 'brand_color' | 'phone' | 'address_line' | 'address_number' | 'city'>
  can_cancel: boolean
  can_reschedule: boolean
  cancellation_min_notice_min: number
  cancellation_policy: string | null
}

export interface Area {
  id: string
  tenant_id: string
  name: string
  description: string | null
  sort_order: number
  is_active: boolean
}

export type TableShape = 'square' | 'round' | 'rect'

export interface DiningTable {
  id: string
  tenant_id: string
  area_id: string | null
  name: string
  min_capacity: number
  max_capacity: number
  shape: TableShape
  pos_x: number
  pos_y: number
  width: number
  height: number
  rotation: number
  combinable: boolean
  is_active: boolean
}

export interface TableCombination {
  id: string
  tenant_id: string
  name: string
  table_ids: string[]
  min_capacity: number
  max_capacity: number
  is_active: boolean
}

export type WaitlistStatus = 'waiting' | 'notified' | 'converted' | 'expired' | 'cancelled'

export interface WaitlistEntry {
  id: string
  tenant_id: string
  customer_name: string
  customer_phone: string
  customer_phone_normalized: string | null
  customer_email: string | null
  desired_date: string
  desired_time: string | null
  party_size: number
  notes: string | null
  status: WaitlistStatus
  area_id: string | null
  source: ReservationSource
  reservation_id: string | null
  notified_at: string | null
  created_at: string
}

export interface Staff {
  id: string
  tenant_id: string
  member_id: string | null
  name: string
  photo_url: string | null
  specialty: string | null
  bio: string | null
  color: string
  is_active: boolean
  sort_order: number
}

export interface StaffHour {
  id: string
  staff_id: string
  weekday: number
  opens_at: string
  closes_at: string
}

export interface Service {
  id: string
  tenant_id: string
  name: string
  description: string | null
  price_cents: number | null
  duration_min: number
  buffer_min: number
  is_active: boolean
  sort_order: number
}

export interface ServiceStaff {
  service_id: string
  staff_id: string
}

export interface StaffMetrics {
  occupancy: number | null
  by_staff: { staff_id: string; name: string; color: string; appointments: number; completed: number; no_shows: number; revenue_cents: number }[]
  by_service: { service_id: string; name: string; appointments: number; completed: number; revenue_cents: number }[]
}

export interface PlanUsage {
  plan: { id: string; code: string; name: string; price_cents: number } | null
  subscription: (Omit<Subscription, 'plan'> & { current_period_start: string | null }) | null
  subscription_ok: boolean
  features: Record<string, boolean>
  limits: Record<string, number | null>
  usage: { members: number; reservations_month: number; resources: number }
}

export interface AdminOverview {
  tenants: number
  tenants_active: number
  tenants_suspended: number
  new_tenants_30d: number
  mrr_cents: number
  by_status: Record<string, number>
  by_plan: { plan: string; count: number }[]
  by_segment: Record<string, number>
  trials_ending_7d: number
  reservations_30d: number
  online_share_30d: number | null
  open_tickets: number
  signups_by_month: { month: string; count: number }[]
}

export interface AdminTenantRow {
  id: string
  name: string
  slug: string
  segment: Segment
  status: TenantStatus
  city: string | null
  created_at: string
  plan_code: string | null
  plan_name: string | null
  subscription_status: SubscriptionStatus | null
  trial_ends_at: string | null
  current_period_end: string | null
  owner_email: string | null
  members: number
  reservations_30d: number
  last_reservation_at: string | null
  open_tickets: number
  feature_overrides: { features?: Record<string, boolean>; limits?: Record<string, number | null> }
  custom_domain: string | null
  internal_notes: string | null
}

export type TicketStatus = 'open' | 'answered' | 'waiting' | 'closed'
export type TicketCategory = 'question' | 'bug' | 'billing' | 'upgrade' | 'feature'

export interface SupportTicket {
  id: string
  tenant_id: string
  created_by: string | null
  subject: string
  category: TicketCategory
  status: TicketStatus
  priority: 'low' | 'normal' | 'high'
  created_at: string
  updated_at: string
  tenant_name?: string
  messages?: number
  last_message?: string | null
}

export interface SupportMessage {
  id: string
  ticket_id: string
  author_id: string | null
  is_staff: boolean
  body: string
  created_at: string
}
