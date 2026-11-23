-- =====================================================================
-- INNOVAI RESERVE — 01 · Schema (multi-tenant)
-- Every business table carries tenant_id. Cross-tenant references are
-- impossible by construction: child rows use composite foreign keys
-- (tenant_id, id), so a reservation can never point at a customer,
-- staff member, service or table owned by another tenant.
-- =====================================================================

create extension if not exists btree_gist;
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------
create type public.segment_type as enum ('restaurant', 'barbershop', 'salon', 'clinic', 'other');
create type public.member_role as enum ('owner', 'manager', 'staff');
create type public.tenant_status as enum ('active', 'suspended', 'cancelled');
create type public.subscription_status as enum ('trialing', 'active', 'past_due', 'cancelled', 'suspended');
create type public.reservation_status as enum ('pending', 'confirmed', 'in_progress', 'completed', 'cancelled', 'no_show');
create type public.reservation_source as enum ('online', 'manual', 'phone', 'walk_in', 'whatsapp', 'instagram');
create type public.notification_channel as enum ('in_app', 'email', 'whatsapp', 'push', 'sms');
create type public.notification_status as enum ('pending', 'sent', 'failed', 'skipped', 'requires_setup', 'cancelled');

-- ---------------------------------------------------------------------
-- Generic helpers
-- ---------------------------------------------------------------------
create or replace function public.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create or replace function public.is_valid_timezone(tz text) returns boolean
language sql stable as $$
  select exists (select 1 from pg_timezone_names where name = tz)
$$;

create or replace function public.normalize_phone(p text) returns text
language sql immutable as $$
  select nullif(regexp_replace(coalesce(p, ''), '\D', '', 'g'), '')
$$;

create or replace function public.gen_reservation_code() returns text
language plpgsql volatile as $$
declare
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  candidate text;
begin
  loop
    candidate := '';
    for i in 1..7 loop
      candidate := candidate || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;
    exit when not exists (select 1 from public.reservations where code = candidate);
  end loop;
  return candidate;
end $$;

-- ---------------------------------------------------------------------
-- Plans & platform (Innovai)
-- ---------------------------------------------------------------------
create table public.plans (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  description text,
  price_cents integer not null default 0 check (price_cents >= 0),
  currency text not null default 'BRL',
  -- e.g. {"max_members": 3, "max_reservations_month": 500, "max_resources": 10}
  limits jsonb not null default '{}'::jsonb,
  -- e.g. {"tables_map": true, "ai_insights": false, "whatsapp": false}
  features jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create table public.platform_admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text,
  phone text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger profiles_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- Tenants (establishments)
-- ---------------------------------------------------------------------
create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique
    check (slug ~ '^[a-z0-9](?:[a-z0-9-]{1,58}[a-z0-9])$'),
  name text not null check (char_length(name) between 2 and 120),
  segment public.segment_type not null default 'other',
  status public.tenant_status not null default 'active',
  timezone text not null default 'America/Sao_Paulo'
    check (public.is_valid_timezone(timezone)),
  locale text not null default 'pt-BR',
  description text check (char_length(description) <= 2000),
  logo_url text,
  cover_url text,
  brand_color text not null default '#C6F432' check (brand_color ~ '^#[0-9A-Fa-f]{6}$'),
  phone text,
  whatsapp text,
  email text,
  website text,
  instagram text,
  facebook text,
  address_line text,
  address_number text,
  address_complement text,
  neighborhood text,
  city text,
  state text,
  postal_code text,
  country text not null default 'BR',
  plan_id uuid references public.plans (id),
  -- commercial fields, editable only by Innovai (see tenants_guard)
  feature_overrides jsonb not null default '{}'::jsonb,   -- {"features": {...}, "limits": {...}}
  custom_domain text unique check (custom_domain is null or custom_domain ~ '^[a-z0-9.-]+\.[a-z]{2,}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger tenants_updated_at before update on public.tenants
  for each row execute function public.set_updated_at();

-- Innovai-only notes about a customer (kept out of `tenants`, which members can read)
create table public.tenant_admin_notes (
  tenant_id uuid primary key references public.tenants (id) on delete cascade,
  notes text,
  updated_at timestamptz not null default now()
);

create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null unique references public.tenants (id) on delete cascade,
  plan_id uuid not null references public.plans (id),
  status public.subscription_status not null default 'trialing',
  trial_ends_at timestamptz,
  current_period_start timestamptz,
  current_period_end timestamptz,
  -- billing provider integration (Stripe / Asaas / Pagar.me) — external setup required
  provider text,
  provider_customer_id text,
  provider_subscription_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger subscriptions_updated_at before update on public.subscriptions
  for each row execute function public.set_updated_at();

create table public.tenant_members (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.member_role not null default 'staff',
  -- granular permissions for staff (prepared): {"reservations.write": true, "customers.read": true}
  permissions jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, user_id)
);
create index tenant_members_user_idx on public.tenant_members (user_id);

create table public.tenant_invitations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  email text not null check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  role public.member_role not null default 'staff', -- 'owner' only via Innovai (RLS)
  invited_by uuid references auth.users (id) on delete set null,
  accepted_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index tenant_invitations_open_uniq
  on public.tenant_invitations (tenant_id, lower(email)) where accepted_at is null;

-- ---------------------------------------------------------------------
-- Booking configuration
-- ---------------------------------------------------------------------
create table public.booking_settings (
  tenant_id uuid primary key references public.tenants (id) on delete cascade,
  booking_enabled boolean not null default true,
  slot_interval_min integer not null default 30 check (slot_interval_min between 5 and 240),
  default_duration_min integer not null default 60 check (default_duration_min between 5 and 720),
  buffer_min integer not null default 0 check (buffer_min between 0 and 240),
  min_advance_min integer not null default 60 check (min_advance_min between 0 and 43200),
  max_advance_days integer not null default 60 check (max_advance_days between 1 and 365),
  min_party_size integer not null default 1 check (min_party_size >= 1),
  max_party_size integer not null default 10 check (max_party_size between 1 and 500),
  -- capacity per overlapping window; null = unlimited
  max_reservations_per_slot integer check (max_reservations_per_slot is null or max_reservations_per_slot >= 1),
  max_guests_per_slot integer check (max_guests_per_slot is null or max_guests_per_slot >= 1),
  require_confirmation boolean not null default false,
  allow_online_cancel boolean not null default true,
  allow_online_reschedule boolean not null default true,
  cancellation_min_notice_min integer not null default 120 check (cancellation_min_notice_min >= 0),
  max_active_per_phone integer not null default 3 check (max_active_per_phone between 1 and 50),
  -- what limits a time slot: general capacity, tables (restaurants) or professionals (services)
  allocation_mode text not null default 'capacity' check (allocation_mode in ('capacity', 'tables', 'staff')),
  booking_message text check (char_length(booking_message) <= 1000),
  cancellation_policy text check (char_length(cancellation_policy) <= 2000),
  updated_at timestamptz not null default now(),
  check (max_party_size >= min_party_size)
);
create trigger booking_settings_updated_at before update on public.booking_settings
  for each row execute function public.set_updated_at();

-- weekday: 0 = Sunday … 6 = Saturday. Several rows per weekday = shifts (turnos).
create table public.business_hours (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  weekday smallint not null check (weekday between 0 and 6),
  opens_at time not null,
  closes_at time not null,
  label text,
  check (closes_at > opens_at),
  constraint business_hours_no_overlap exclude using gist (
    tenant_id with =, weekday with =, tsrange(date '2000-01-01' + opens_at, date '2000-01-01' + closes_at, '[)') with &&
  )
);
create index business_hours_tenant_idx on public.business_hours (tenant_id, weekday);

create table public.notification_settings (
  tenant_id uuid primary key references public.tenants (id) on delete cascade,
  notify_owner_new_reservation boolean not null default true,
  email_enabled boolean not null default false,
  whatsapp_enabled boolean not null default false,
  push_enabled boolean not null default false,
  reminder_enabled boolean not null default true,
  reminder_hours_before integer not null default 24 check (reminder_hours_before between 1 and 168),
  review_request_enabled boolean not null default false,
  updated_at timestamptz not null default now()
);
create trigger notification_settings_updated_at before update on public.notification_settings
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- Resources (prepared for Phase 2 — restaurant — and Phase 3 — services)
-- ---------------------------------------------------------------------
create table public.areas (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  name text not null,
  description text,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, id)
);

create table public.dining_tables (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  area_id uuid,
  name text not null,
  min_capacity integer not null default 1 check (min_capacity >= 1),
  max_capacity integer not null check (max_capacity >= 1),
  shape text not null default 'square' check (shape in ('square', 'round', 'rect')),
  pos_x numeric not null default 0,
  pos_y numeric not null default 0,
  width numeric not null default 80,
  height numeric not null default 80,
  rotation numeric not null default 0,
  combinable boolean not null default true,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, name),
  check (max_capacity >= min_capacity),
  foreign key (tenant_id, area_id) references public.areas (tenant_id, id) on delete set null (area_id)
);
create index dining_tables_tenant_idx on public.dining_tables (tenant_id, is_active);
create index areas_tenant_idx on public.areas (tenant_id, sort_order);

-- Joined tables for larger groups
create table public.table_combinations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  name text not null,
  table_ids uuid[] not null check (cardinality(table_ids) between 2 and 12),
  min_capacity integer not null default 1 check (min_capacity >= 1),
  max_capacity integer not null check (max_capacity >= 2),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  check (max_capacity >= min_capacity)
);
create index table_combinations_tenant_idx on public.table_combinations (tenant_id);

create table public.staff (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  member_id uuid references public.tenant_members (id) on delete set null,
  name text not null,
  photo_url text,
  specialty text,
  bio text,
  color text not null default '#C6F432' check (color ~ '^#[0-9A-Fa-f]{6}$'),
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id)
);
create unique index staff_member_uniq on public.staff (member_id) where member_id is not null;
create index staff_tenant_idx on public.staff (tenant_id, is_active, sort_order);
create trigger staff_updated_at before update on public.staff for each row execute function public.set_updated_at();

create table public.staff_hours (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  staff_id uuid not null,
  weekday smallint not null check (weekday between 0 and 6),
  opens_at time not null,
  closes_at time not null,
  check (closes_at > opens_at),
  foreign key (tenant_id, staff_id) references public.staff (tenant_id, id) on delete cascade,
  constraint staff_hours_no_overlap exclude using gist (
    staff_id with =, weekday with =, tsrange(date '2000-01-01' + opens_at, date '2000-01-01' + closes_at, '[)') with &&
  )
);
create index staff_hours_staff_idx on public.staff_hours (staff_id, weekday);

create table public.services (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  name text not null,
  description text,
  price_cents integer check (price_cents is null or price_cents >= 0),
  duration_min integer not null check (duration_min between 5 and 720),
  buffer_min integer not null default 0 check (buffer_min between 0 and 240),
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  unique (tenant_id, id)
);
create index services_tenant_idx on public.services (tenant_id, is_active, sort_order);

create table public.service_staff (
  tenant_id uuid not null,
  service_id uuid not null,
  staff_id uuid not null,
  primary key (service_id, staff_id),
  foreign key (tenant_id, service_id) references public.services (tenant_id, id) on delete cascade,
  foreign key (tenant_id, staff_id) references public.staff (tenant_id, id) on delete cascade
);

-- ---------------------------------------------------------------------
-- Customers (per-tenant CRM; phone is the natural key)
-- ---------------------------------------------------------------------
create table public.customers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  user_id uuid references auth.users (id) on delete set null,
  name text not null check (char_length(name) between 1 and 120),
  phone text not null,
  phone_normalized text not null check (char_length(phone_normalized) between 8 and 15),
  email text check (email is null or email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  birthday date,
  preferences text,
  notes text,
  tags text[] not null default '{}',
  marketing_opt_in boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, phone_normalized)
);
create index customers_tenant_name_idx on public.customers (tenant_id, lower(name));
create trigger customers_updated_at before update on public.customers
  for each row execute function public.set_updated_at();

create or replace function public.customers_normalize() returns trigger
language plpgsql as $$
begin
  new.phone_normalized := public.normalize_phone(new.phone);
  new.name := btrim(new.name);
  new.email := nullif(lower(btrim(new.email)), '');
  return new;
end $$;
create trigger customers_normalize before insert or update of phone, name, email on public.customers
  for each row execute function public.customers_normalize();

-- ---------------------------------------------------------------------
-- Schedule blocks (agenda blocks, holidays, private events)
-- ---------------------------------------------------------------------
create table public.schedule_blocks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  staff_id uuid,          -- null = whole establishment
  table_id uuid,          -- null = not table specific
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  reason text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at),
  foreign key (tenant_id, staff_id) references public.staff (tenant_id, id) on delete cascade,
  foreign key (tenant_id, table_id) references public.dining_tables (tenant_id, id) on delete cascade
);
create index schedule_blocks_tenant_time_idx on public.schedule_blocks using gist (tenant_id, tstzrange(starts_at, ends_at, '[)'));

-- ---------------------------------------------------------------------
-- Reservations
-- ---------------------------------------------------------------------
create table public.reservations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  code text not null unique default public.gen_reservation_code(),
  customer_id uuid,
  customer_name text not null check (char_length(customer_name) between 1 and 120),
  customer_phone text not null,
  customer_phone_normalized text not null check (char_length(customer_phone_normalized) between 8 and 15),
  customer_email text check (customer_email is null or customer_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  party_size integer not null default 1 check (party_size between 1 and 500),
  service_id uuid,
  staff_id uuid,
  staff_requested boolean not null default false, -- customer chose this professional (vs "any")
  table_id uuid,                                  -- primary table (= table_ids[1])
  table_ids uuid[] not null default '{}',         -- all tables (joined tables)
  area_id uuid,
  -- end of the professional's protected window (service + clean-up interval)
  occupied_until timestamptz,
  status public.reservation_status not null default 'pending',
  source public.reservation_source not null default 'manual',
  notes text check (char_length(notes) <= 1000),
  internal_notes text check (char_length(internal_notes) <= 2000),
  created_by uuid references auth.users (id) on delete set null,
  confirmed_at timestamptz,
  checked_in_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  period tstzrange generated always as (tstzrange(starts_at, ends_at, '[)')) stored,
  check (ends_at > starts_at),
  check (ends_at - starts_at <= interval '24 hours'),
  unique (tenant_id, id),
  foreign key (tenant_id, customer_id) references public.customers (tenant_id, id) on delete set null (customer_id),
  foreign key (tenant_id, service_id) references public.services (tenant_id, id) on delete set null (service_id),
  foreign key (tenant_id, staff_id) references public.staff (tenant_id, id) on delete set null (staff_id),
  foreign key (tenant_id, table_id) references public.dining_tables (tenant_id, id) on delete set null (table_id),
  foreign key (tenant_id, area_id) references public.areas (tenant_id, id) on delete set null (area_id),
  -- Hard guarantees against double booking (enforced by Postgres, race-free).
  -- Table occupancy is guaranteed on reservation_tables (supports joined tables).
  constraint reservations_no_staff_overlap exclude using gist (
    staff_id with =, tstzrange(starts_at, coalesce(occupied_until, ends_at), '[)') with &&
  ) where (staff_id is not null and status in ('pending', 'confirmed', 'in_progress')),
  constraint reservations_no_duplicate_customer exclude using gist (
    tenant_id with =, customer_phone_normalized with =, period with &&
  ) where (status in ('pending', 'confirmed', 'in_progress'))
);
create index reservations_tenant_start_idx on public.reservations (tenant_id, starts_at);
create index reservations_tenant_status_idx on public.reservations (tenant_id, status);
create index reservations_customer_idx on public.reservations (customer_id);
create index reservations_period_idx on public.reservations using gist (tenant_id, period);
create index reservations_tenant_created_idx on public.reservations (tenant_id, created_at);
create trigger reservations_updated_at before update on public.reservations
  for each row execute function public.set_updated_at();

create table public.reservation_events (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  reservation_id uuid not null references public.reservations (id) on delete cascade,
  actor_id uuid references auth.users (id) on delete set null,
  actor_type text not null default 'staff' check (actor_type in ('staff', 'customer', 'system')),
  action text not null,
  from_status public.reservation_status,
  to_status public.reservation_status,
  changes jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index reservation_events_resv_idx on public.reservation_events (reservation_id, created_at);

-- One row per reservation × table; the period includes the clean-up interval.
create table public.reservation_tables (
  reservation_id uuid not null references public.reservations (id) on delete cascade,
  tenant_id uuid not null,
  table_id uuid not null,
  period tstzrange not null,
  active boolean not null default true,
  primary key (reservation_id, table_id),
  foreign key (tenant_id, table_id) references public.dining_tables (tenant_id, id) on delete cascade,
  constraint reservation_tables_no_overlap exclude using gist (table_id with =, period with &&) where (active)
);
create index reservation_tables_tenant_idx on public.reservation_tables using gist (tenant_id, period);

-- Waitlist (Phase 2 — prepared)
create table public.waitlist_entries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  customer_name text not null,
  customer_phone text not null,
  customer_phone_normalized text,
  customer_email text,
  area_id uuid,
  source public.reservation_source not null default 'manual',
  notified_at timestamptz,
  desired_date date not null,
  desired_time time,
  party_size integer not null default 1 check (party_size >= 1),
  notes text,
  status text not null default 'waiting' check (status in ('waiting', 'notified', 'converted', 'expired', 'cancelled')),
  reservation_id uuid references public.reservations (id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, area_id) references public.areas (tenant_id, id) on delete set null (area_id)
);
create index waitlist_tenant_date_idx on public.waitlist_entries (tenant_id, desired_date, status);

-- ---------------------------------------------------------------------
-- Notifications outbox + audit log
-- ---------------------------------------------------------------------
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  reservation_id uuid references public.reservations (id) on delete cascade,
  channel public.notification_channel not null,
  template text not null,
  audience text not null check (audience in ('staff', 'customer')),
  recipient text,
  title text,
  body text,
  payload jsonb not null default '{}'::jsonb,
  status public.notification_status not null default 'pending',
  scheduled_for timestamptz not null default now(),
  attempts integer not null default 0,
  sent_at timestamptz,
  read_at timestamptz,
  error text,
  created_at timestamptz not null default now()
);
create index notifications_tenant_idx on public.notifications (tenant_id, created_at desc);
create index notifications_dispatch_idx on public.notifications (status, scheduled_for) where status = 'pending';

create table public.audit_logs (
  id bigint generated always as identity primary key,
  tenant_id uuid references public.tenants (id) on delete cascade,
  actor_id uuid,
  entity text not null,
  entity_id text,
  action text not null,
  old_data jsonb,
  new_data jsonb,
  created_at timestamptz not null default now()
);
create index audit_logs_tenant_idx on public.audit_logs (tenant_id, created_at desc);

-- ---------------------------------------------------------------------
-- Support (establishments ↔ Innovai)
-- ---------------------------------------------------------------------
create table public.support_tickets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  created_by uuid references auth.users (id) on delete set null,
  subject text not null check (char_length(subject) between 3 and 160),
  category text not null default 'question' check (category in ('question', 'bug', 'billing', 'upgrade', 'feature')),
  status text not null default 'open' check (status in ('open', 'answered', 'waiting', 'closed')),
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index support_tickets_tenant_idx on public.support_tickets (tenant_id, updated_at desc);
create index support_tickets_status_idx on public.support_tickets (status, updated_at desc);

create table public.support_messages (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.support_tickets (id) on delete cascade,
  author_id uuid references auth.users (id) on delete set null,
  is_staff boolean not null default false, -- set by the database (only Innovai admins)
  body text not null check (char_length(body) between 1 and 5000),
  created_at timestamptz not null default now()
);
create index support_messages_ticket_idx on public.support_messages (ticket_id, created_at);

-- ---------------------------------------------------------------------
-- Normalisation / validation triggers
-- ---------------------------------------------------------------------
create or replace function public.waitlist_normalize() returns trigger
language plpgsql as $$
begin
  new.customer_name := btrim(new.customer_name);
  new.customer_phone_normalized := public.normalize_phone(new.customer_phone);
  new.customer_email := nullif(lower(btrim(new.customer_email)), '');
  return new;
end $$;
create trigger waitlist_normalize before insert or update of customer_phone, customer_name, customer_email on public.waitlist_entries
  for each row execute function public.waitlist_normalize();

create or replace function public.table_combinations_validate() returns trigger
language plpgsql set search_path = public as $$
begin
  new.table_ids := array(select u.x from unnest(new.table_ids) with ordinality u(x, o) where u.x is not null group by u.x order by min(u.o));
  if exists (select 1 from unnest(new.table_ids) x(id)
             where not exists (select 1 from public.dining_tables t where t.id = x.id and t.tenant_id = new.tenant_id)) then
    raise exception 'A união contém mesas de outro estabelecimento ou inexistentes.' using errcode = '42501';
  end if;
  if cardinality(new.table_ids) < 2 then
    raise exception 'Selecione ao menos duas mesas para unir.' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger table_combinations_validate before insert or update on public.table_combinations
  for each row execute function public.table_combinations_validate();

-- ---------------------------------------------------------------------
-- Seed plans
-- ---------------------------------------------------------------------
insert into public.plans (code, name, description, price_cents, limits, features, sort_order) values
  ('starter', 'Starter', 'Para começar a receber reservas online.', 9900,
   '{"max_members": 2, "max_reservations_month": 300, "max_resources": 5}',
   '{"public_page": true, "crm": true, "tables_map": false, "whatsapp": false, "ai_insights": false, "reports_advanced": false}', 1),
  ('pro', 'Pro', 'Operação completa com mapa de mesas, profissionais e relatórios.', 19900,
   '{"max_members": 8, "max_reservations_month": 2000, "max_resources": 30}',
   '{"public_page": true, "crm": true, "tables_map": true, "whatsapp": true, "ai_insights": false, "reports_advanced": true}', 2),
  ('business', 'Business', 'Multiunidade, automações e inteligência artificial.', 39900,
   '{"max_members": 50, "max_reservations_month": null, "max_resources": 200}',
   '{"public_page": true, "crm": true, "tables_map": true, "whatsapp": true, "ai_insights": true, "reports_advanced": true}', 3);
