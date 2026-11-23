-- =====================================================================
-- INNOVAI RESERVE — Booking engine
--  * availability computation (business hours, shifts, blocks,
--    capacity, buffers, advance windows, timezone aware)
--  * write-time revalidation under a per-tenant advisory lock
--  * immutable change history + notification outbox
--  * public RPCs (no login required) and staff RPCs
-- =====================================================================

-- Active statuses occupy the agenda
create or replace function public.is_active_status(s public.reservation_status) returns boolean
language sql immutable as $$ select s in ('pending', 'confirmed', 'in_progress') $$;

create or replace function public._lock_tenant_agenda(p_tenant uuid) returns void
language sql volatile as $$
  select pg_advisory_xact_lock(hashtextextended('innovai:agenda:' || p_tenant::text, 0))
$$;

-- Load of the agenda for a window (honours buffer between reservations)
create or replace function public._window_load(
  p_tenant uuid, p_start timestamptz, p_end timestamptz, p_ignore uuid default null
) returns table (reservations integer, guests integer)
language sql stable security definer set search_path = public as $$
  select count(*)::int, coalesce(sum(r.party_size), 0)::int
  from public.reservations r
  join public.booking_settings s on s.tenant_id = r.tenant_id
  where r.tenant_id = p_tenant
    and public.is_active_status(r.status)
    and (p_ignore is null or r.id <> p_ignore)
    and r.staff_id is null and r.table_id is null
    and r.starts_at < p_end + make_interval(mins => s.buffer_min)
    and r.ends_at + make_interval(mins => s.buffer_min) > p_start
$$;

-- ---------------------------------------------------------------------
-- Availability: returns only genuinely bookable start times
-- ---------------------------------------------------------------------
create or replace function public._compute_slots(
  p_tenant uuid, p_date date, p_party integer, p_duration integer, p_ignore uuid default null
) returns table (slot_start timestamptz, slot_end timestamptz, remaining_reservations integer, remaining_guests integer)
language plpgsql stable security definer set search_path = public as $$
declare
  s public.booking_settings;
  v_tz text;
  v_today date;
begin
  select * into s from public.booking_settings where tenant_id = p_tenant;
  select timezone into v_tz from public.tenants where id = p_tenant;
  if not found or s.tenant_id is null or p_duration is null or p_duration < 5 then
    return;
  end if;

  v_today := (now() at time zone v_tz)::date;
  if p_date < v_today or p_date > v_today + s.max_advance_days then
    return;
  end if;

  return query
  with candidates as (
    select distinct (((p_date + bh.opens_at) + make_interval(mins => g * s.slot_interval_min)) at time zone v_tz) as st
    from public.business_hours bh
    cross join lateral generate_series(
      0,
      floor(((extract(epoch from (bh.closes_at - bh.opens_at)) / 60) - p_duration) / s.slot_interval_min)::int
    ) as g
    where bh.tenant_id = p_tenant
      and bh.weekday = extract(dow from p_date)::int
      and extract(epoch from (bh.closes_at - bh.opens_at)) / 60 >= p_duration
  ),
  windows as (
    select c.st, c.st + make_interval(mins => p_duration) as en
    from candidates c
    where c.st >= now() + make_interval(mins => s.min_advance_min)
      and not exists (
        select 1 from public.schedule_blocks b
        where b.tenant_id = p_tenant and b.staff_id is null and b.table_id is null
          and b.starts_at < c.st + make_interval(mins => p_duration) and b.ends_at > c.st
      )
  )
  select w.st, w.en,
         case when s.max_reservations_per_slot is null then null else s.max_reservations_per_slot - l.reservations end,
         case when s.max_guests_per_slot is null then null else s.max_guests_per_slot - l.guests end
  from windows w
  cross join lateral public._window_load(p_tenant, w.st, w.en, p_ignore) l
  where (s.max_reservations_per_slot is null or l.reservations < s.max_reservations_per_slot)
    and (s.max_guests_per_slot is null or l.guests + p_party <= s.max_guests_per_slot)
  order by w.st;
end $$;

-- ---------------------------------------------------------------------
-- BEFORE trigger: normalisation + hard revalidation on every write path
-- (online, manual, API). Runs under the per-tenant advisory lock so two
-- concurrent requests can never both take the last place.
-- ---------------------------------------------------------------------
create or replace function public.reservations_before_write() returns trigger
language plpgsql set search_path = public as $$
declare
  s public.booking_settings;
  l record;
  v_duration integer;
  v_needs_check boolean;
begin
  new.customer_name := btrim(new.customer_name);
  new.customer_phone := btrim(new.customer_phone);
  new.customer_phone_normalized := public.normalize_phone(new.customer_phone);
  new.customer_email := nullif(lower(btrim(new.customer_email)), '');

  select * into s from public.booking_settings where tenant_id = new.tenant_id;

  -- default end time: service duration or tenant default
  if new.ends_at is null then
    select duration_min into v_duration from public.services where id = new.service_id and tenant_id = new.tenant_id;
    new.ends_at := new.starts_at + make_interval(mins => coalesce(v_duration, s.default_duration_min, 60));
  end if;

  if tg_op = 'UPDATE' then
    -- moving the start keeps the original duration unless the end was also changed
    if new.starts_at is distinct from old.starts_at and new.ends_at is not distinct from old.ends_at then
      new.ends_at := new.starts_at + (old.ends_at - old.starts_at);
    end if;
    if new.code is distinct from old.code or new.tenant_id is distinct from old.tenant_id then
      raise exception 'Código e estabelecimento da reserva não podem ser alterados.' using errcode = '42501';
    end if;
  end if;

  -- status timestamps
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    case new.status
      when 'confirmed' then new.confirmed_at := coalesce(new.confirmed_at, now());
      when 'in_progress' then new.checked_in_at := coalesce(new.checked_in_at, now());
      when 'completed' then new.completed_at := coalesce(new.completed_at, now());
      when 'cancelled' then new.cancelled_at := coalesce(new.cancelled_at, now());
      else null;
    end case;
  end if;

  v_needs_check := public.is_active_status(new.status) and (
    tg_op = 'INSERT'
    or not public.is_active_status(old.status)
    or new.starts_at is distinct from old.starts_at
    or new.ends_at is distinct from old.ends_at
    or new.party_size is distinct from old.party_size
    or new.staff_id is distinct from old.staff_id
    or new.table_id is distinct from old.table_id
  );

  if v_needs_check then
    perform public._lock_tenant_agenda(new.tenant_id);

    if exists (
      select 1 from public.schedule_blocks b
      where b.tenant_id = new.tenant_id
        and b.starts_at < new.ends_at and b.ends_at > new.starts_at
        and ((b.staff_id is null and b.table_id is null)
             or b.staff_id = new.staff_id
             or b.table_id = new.table_id)
    ) then
      raise exception 'Este horário está bloqueado na agenda.' using errcode = 'P0001', hint = 'SLOT_BLOCKED';
    end if;

    if new.staff_id is null and new.table_id is null and s.tenant_id is not null then
      select * into l from public._window_load(new.tenant_id, new.starts_at, new.ends_at, new.id);
      if s.max_reservations_per_slot is not null and l.reservations >= s.max_reservations_per_slot then
        raise exception 'Horário lotado: limite de % reserva(s) simultânea(s).', s.max_reservations_per_slot
          using errcode = 'P0001', hint = 'SLOT_FULL';
      end if;
      if s.max_guests_per_slot is not null and l.guests + new.party_size > s.max_guests_per_slot then
        raise exception 'Horário lotado: limite de % pessoas simultâneas.', s.max_guests_per_slot
          using errcode = 'P0001', hint = 'SLOT_FULL';
      end if;
    end if;
  end if;

  -- link / create CRM customer by phone
  -- (only on insert / phone change: a CRM deletion nulls customer_id via FK and must not recreate it)
  if new.customer_id is null and new.customer_phone_normalized is not null
     and (tg_op = 'INSERT' or new.customer_phone_normalized is distinct from old.customer_phone_normalized) then
    insert into public.customers (tenant_id, name, phone, email)
    values (new.tenant_id, new.customer_name, new.customer_phone, new.customer_email)
    on conflict (tenant_id, phone_normalized)
      do update set email = coalesce(public.customers.email, excluded.email)
    returning id into new.customer_id;
  end if;

  return new;
end $$;

create trigger reservations_before_write
  before insert or update on public.reservations
  for each row execute function public.reservations_before_write();

-- ---------------------------------------------------------------------
-- AFTER trigger: change history + notification outbox
-- ---------------------------------------------------------------------
create or replace function public._fmt_local(p_ts timestamptz, p_tz text) returns text
language sql stable as $$
  select to_char(p_ts at time zone p_tz, 'DD/MM/YYYY "às" HH24:MI')
$$;

create or replace function public._enqueue_customer_message(
  r public.reservations, p_template text, p_title text, p_body text, p_when timestamptz default now()
) returns void
language plpgsql security definer set search_path = public as $$
declare ns public.notification_settings;
begin
  select * into ns from public.notification_settings where tenant_id = r.tenant_id;
  if ns.tenant_id is null then return; end if;
  if ns.email_enabled and r.customer_email is not null then
    insert into public.notifications (tenant_id, reservation_id, channel, template, audience, recipient, title, body, scheduled_for, payload)
    values (r.tenant_id, r.id, 'email', p_template, 'customer', r.customer_email, p_title, p_body, p_when,
            jsonb_build_object('code', r.code, 'starts_at', r.starts_at, 'name', r.customer_name));
  end if;
  if ns.whatsapp_enabled then
    insert into public.notifications (tenant_id, reservation_id, channel, template, audience, recipient, title, body, scheduled_for, payload)
    values (r.tenant_id, r.id, 'whatsapp', p_template, 'customer', r.customer_phone_normalized, p_title, p_body, p_when,
            jsonb_build_object('code', r.code, 'starts_at', r.starts_at, 'name', r.customer_name));
  end if;
end $$;

create or replace function public.reservations_after_write() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_actor_type text := coalesce(nullif(current_setting('app.actor_type', true), ''),
                                case when auth.uid() is null then 'system' else 'staff' end);
  v_changes jsonb := '{}'::jsonb;
  v_action text;
  v_tz text;
  v_tenant_name text;
  v_when text;
  ns public.notification_settings;
  f text;
begin
  select timezone, name into v_tz, v_tenant_name from public.tenants where id = new.tenant_id;
  select * into ns from public.notification_settings where tenant_id = new.tenant_id;
  v_when := public._fmt_local(new.starts_at, v_tz);

  if tg_op = 'INSERT' then
    v_action := 'created';
    v_changes := jsonb_build_object('source', new.source, 'starts_at', new.starts_at, 'party_size', new.party_size);
  else
    foreach f in array array['starts_at', 'ends_at', 'party_size', 'status', 'customer_name', 'customer_phone',
                             'customer_email', 'service_id', 'staff_id', 'table_id', 'area_id', 'notes', 'internal_notes'] loop
      if (to_jsonb(new) -> f) is distinct from (to_jsonb(old) -> f) then
        v_changes := v_changes || jsonb_build_object(f, jsonb_build_object('from', to_jsonb(old) -> f, 'to', to_jsonb(new) -> f));
      end if;
    end loop;
    if v_changes = '{}'::jsonb then
      return null;
    end if;
    v_action := case
      when new.starts_at is distinct from old.starts_at then 'rescheduled'
      when new.status is distinct from old.status then 'status_changed'
      else 'updated' end;
  end if;

  insert into public.reservation_events (tenant_id, reservation_id, actor_id, actor_type, action, from_status, to_status, changes)
  values (new.tenant_id, new.id, auth.uid(), v_actor_type, v_action,
          case when tg_op = 'UPDATE' then old.status end, new.status, v_changes);

  if ns.tenant_id is null then
    return null;
  end if;

  -- ----- staff (in-app) notifications -----
  if ns.notify_owner_new_reservation and tg_op = 'INSERT' and v_actor_type = 'customer' then
    insert into public.notifications (tenant_id, reservation_id, channel, template, audience, title, body, status, sent_at)
    values (new.tenant_id, new.id, 'in_app', 'staff_new_reservation', 'staff',
            'Nova reserva online',
            format('%s · %s · %s pessoa(s)%s', new.customer_name, v_when, new.party_size,
                   case when new.status = 'pending' then ' · aguardando confirmação' else '' end),
            'sent', now());
  elsif tg_op = 'UPDATE' and v_actor_type = 'customer' and v_action in ('rescheduled', 'status_changed') then
    insert into public.notifications (tenant_id, reservation_id, channel, template, audience, title, body, status, sent_at)
    values (new.tenant_id, new.id, 'in_app',
            case when new.status = 'cancelled' then 'staff_reservation_cancelled' else 'staff_reservation_rescheduled' end,
            'staff',
            case when new.status = 'cancelled' then 'Reserva cancelada pelo cliente' else 'Reserva remarcada pelo cliente' end,
            format('%s · %s', new.customer_name, v_when), 'sent', now());
  end if;

  -- ----- customer messages (email / WhatsApp outbox) -----
  if tg_op = 'INSERT' then
    perform public._enqueue_customer_message(new,
      case when new.status = 'pending' then 'reservation_received' else 'reservation_confirmed' end,
      case when new.status = 'pending' then 'Recebemos sua reserva' else 'Reserva confirmada' end,
      format('Olá, %s! %s para %s em %s. Código: %s.',
             split_part(new.customer_name, ' ', 1),
             case when new.status = 'pending' then 'Recebemos seu pedido de reserva' else 'Sua reserva está confirmada' end,
             new.party_size || ' pessoa(s)', v_tenant_name || ', ' || v_when, new.code));
  elsif new.status is distinct from old.status then
    if new.status = 'confirmed' and old.status = 'pending' then
      perform public._enqueue_customer_message(new, 'reservation_confirmed', 'Reserva confirmada',
        format('Sua reserva em %s para %s está confirmada. Código: %s.', v_tenant_name, v_when, new.code));
    elsif new.status = 'cancelled' then
      perform public._enqueue_customer_message(new, 'reservation_cancelled', 'Reserva cancelada',
        format('Sua reserva em %s para %s foi cancelada.', v_tenant_name, v_when));
    elsif new.status = 'completed' and ns.review_request_enabled then
      perform public._enqueue_customer_message(new, 'review_request', 'Como foi sua experiência?',
        format('Obrigado pela visita ao %s! Conte como foi sua experiência.', v_tenant_name), now() + interval '2 hours');
    end if;
  elsif v_action = 'rescheduled' then
    perform public._enqueue_customer_message(new, 'reservation_rescheduled', 'Reserva alterada',
      format('Sua reserva em %s foi alterada para %s. Código: %s.', v_tenant_name, v_when, new.code));
  end if;

  -- ----- reminders: always keep exactly one pending reminder per active reservation -----
  if tg_op = 'UPDATE' and (new.starts_at is distinct from old.starts_at or new.status is distinct from old.status) then
    update public.notifications set status = 'cancelled'
    where reservation_id = new.id and template = 'reminder' and status = 'pending';
  end if;
  if ns.reminder_enabled and new.status in ('pending', 'confirmed')
     and (tg_op = 'INSERT' or new.starts_at is distinct from old.starts_at or new.status is distinct from old.status)
     and new.starts_at - make_interval(hours => ns.reminder_hours_before) > now() then
    perform public._enqueue_customer_message(new, 'reminder', 'Lembrete da sua reserva',
      format('Lembrete: sua reserva em %s é %s. Código: %s.', v_tenant_name, v_when, new.code),
      new.starts_at - make_interval(hours => ns.reminder_hours_before));
  end if;

  return null;
end $$;

create trigger reservations_after_write
  after insert or update on public.reservations
  for each row execute function public.reservations_after_write();

-- =====================================================================
-- Onboarding & team RPCs (authenticated)
-- =====================================================================
create or replace function public.slug_available(p_slug text) returns boolean
language sql stable security definer set search_path = public as $$
  select lower(p_slug) ~ '^[a-z0-9](?:[a-z0-9-]{1,58}[a-z0-9])$'
     and lower(p_slug) not in ('app', 'admin', 'api', 'login', 'signup', 'cadastro', 'entrar', 'reserva', 'innovai', 'www', 'suporte')
     and not exists (select 1 from public.tenants where slug = lower(p_slug))
$$;

create or replace function public.create_tenant(
  p_name text,
  p_slug text,
  p_segment public.segment_type,
  p_timezone text default 'America/Sao_Paulo',
  p_phone text default null
) returns public.tenants
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_plan uuid;
  t public.tenants;
  d int;
begin
  if v_uid is null then
    raise exception 'Faça login para criar um estabelecimento.' using errcode = '42501';
  end if;
  if (select count(*) from public.tenant_members where user_id = v_uid and role = 'owner') >= 5 then
    raise exception 'Limite de estabelecimentos por conta atingido. Fale com a Innovai.' using errcode = 'P0001';
  end if;
  if not public.slug_available(p_slug) then
    raise exception 'Este link já está em uso ou é inválido.' using errcode = 'P0001', hint = 'SLUG_TAKEN';
  end if;

  select id into v_plan from public.plans where code = 'starter';

  insert into public.tenants (name, slug, segment, timezone, phone, whatsapp, plan_id)
  values (btrim(p_name), lower(p_slug), p_segment, coalesce(p_timezone, 'America/Sao_Paulo'), p_phone, p_phone, v_plan)
  returning * into t;

  insert into public.tenant_members (tenant_id, user_id, role) values (t.id, v_uid, 'owner');
  insert into public.subscriptions (tenant_id, plan_id, status, trial_ends_at, current_period_start, current_period_end)
  values (t.id, v_plan, 'trialing', now() + interval '14 days', now(), now() + interval '14 days');
  insert into public.notification_settings (tenant_id) values (t.id);

  -- sensible defaults per segment (fully editable afterwards)
  if p_segment = 'restaurant' then
    insert into public.booking_settings (tenant_id, slot_interval_min, default_duration_min, buffer_min,
      min_advance_min, max_advance_days, max_party_size, max_reservations_per_slot, max_guests_per_slot, require_confirmation)
    values (t.id, 30, 90, 0, 60, 60, 12, 10, 40, false);
    for d in 2..5 loop -- Tue–Fri: lunch + dinner
      insert into public.business_hours (tenant_id, weekday, opens_at, closes_at, label) values
        (t.id, d, '12:00', '15:00', 'Almoço'), (t.id, d, '19:00', '23:00', 'Jantar');
    end loop;
    insert into public.business_hours (tenant_id, weekday, opens_at, closes_at, label) values
      (t.id, 6, '12:00', '16:00', 'Almoço'), (t.id, 6, '19:00', '23:30', 'Jantar'),
      (t.id, 0, '12:00', '16:00', 'Almoço');
  else
    insert into public.booking_settings (tenant_id, slot_interval_min, default_duration_min, buffer_min,
      min_advance_min, max_advance_days, max_party_size, max_reservations_per_slot, require_confirmation)
    values (t.id, 30, case when p_segment = 'barbershop' then 30 else 60 end, 0, 30, 30, 1, 1, false);
    for d in 1..5 loop
      insert into public.business_hours (tenant_id, weekday, opens_at, closes_at) values (t.id, d, '09:00', '19:00');
    end loop;
    insert into public.business_hours (tenant_id, weekday, opens_at, closes_at) values (t.id, 6, '09:00', '17:00');
  end if;

  return t;
end $$;

create or replace function public.accept_invitations() returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_email text;
  v_count int := 0;
  inv record;
begin
  select lower(email) into v_email from auth.users where id = auth.uid();
  if v_email is null then return 0; end if;
  for inv in
    select i.* from public.tenant_invitations i
    join public.tenants t on t.id = i.tenant_id and t.status = 'active'
    where lower(i.email) = v_email and i.accepted_at is null
  loop
    insert into public.tenant_members (tenant_id, user_id, role)
    values (inv.tenant_id, auth.uid(), inv.role)
    on conflict (tenant_id, user_id) do update set is_active = true;
    update public.tenant_invitations set accepted_at = now() where id = inv.id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

create or replace function public.get_team(p_tenant uuid)
returns table (member_id uuid, user_id uuid, email text, full_name text, role public.member_role, is_active boolean, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select m.id, m.user_id, u.email::text, p.full_name, m.role, m.is_active, m.created_at
  from public.tenant_members m
  join auth.users u on u.id = m.user_id
  left join public.profiles p on p.id = m.user_id
  where m.tenant_id = p_tenant and public.is_member(p_tenant)
  order by m.role, m.created_at
$$;

-- Slots for the staff UI (manual booking, rescheduling)
create or replace function public.get_tenant_slots(
  p_tenant uuid, p_date date, p_party integer default 1, p_duration integer default null, p_ignore uuid default null
) returns table (slot_start timestamptz, slot_end timestamptz, remaining_reservations integer, remaining_guests integer)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_member(p_tenant) then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;
  return query
  select * from public._compute_slots(
    p_tenant, p_date, greatest(coalesce(p_party, 1), 1),
    coalesce(p_duration, (select default_duration_min from public.booking_settings where tenant_id = p_tenant)),
    p_ignore);
end $$;

-- =====================================================================
-- Public RPCs (anon + authenticated). Narrow, validated, no table access.
-- =====================================================================
create or replace function public._public_tenant(p_slug text) returns public.tenants
language plpgsql stable security definer set search_path = public as $$
declare t public.tenants;
begin
  select * into t from public.tenants where slug = lower(btrim(p_slug)) and status = 'active';
  if t.id is null then
    raise exception 'Estabelecimento não encontrado.' using errcode = 'P0002', hint = 'NOT_FOUND';
  end if;
  return t;
end $$;

create or replace function public.get_public_page(p_slug text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  t public.tenants := public._public_tenant(p_slug);
  s public.booking_settings;
begin
  select * into s from public.booking_settings where tenant_id = t.id;
  return jsonb_build_object(
    'tenant', jsonb_build_object(
      'id', t.id, 'slug', t.slug, 'name', t.name, 'segment', t.segment, 'timezone', t.timezone,
      'description', t.description, 'logo_url', t.logo_url, 'cover_url', t.cover_url, 'brand_color', t.brand_color,
      'phone', t.phone, 'whatsapp', t.whatsapp, 'email', t.email, 'website', t.website,
      'instagram', t.instagram, 'facebook', t.facebook,
      'address_line', t.address_line, 'address_number', t.address_number, 'address_complement', t.address_complement,
      'neighborhood', t.neighborhood, 'city', t.city, 'state', t.state, 'postal_code', t.postal_code),
    'settings', jsonb_build_object(
      'booking_enabled', s.booking_enabled, 'min_party_size', s.min_party_size, 'max_party_size', s.max_party_size,
      'max_advance_days', s.max_advance_days, 'min_advance_min', s.min_advance_min,
      'require_confirmation', s.require_confirmation, 'allow_online_cancel', s.allow_online_cancel,
      'allow_online_reschedule', s.allow_online_reschedule, 'cancellation_min_notice_min', s.cancellation_min_notice_min,
      'booking_message', s.booking_message, 'cancellation_policy', s.cancellation_policy,
      'default_duration_min', s.default_duration_min),
    'hours', coalesce((
      select jsonb_agg(jsonb_build_object('weekday', weekday, 'opens_at', to_char(opens_at, 'HH24:MI'),
                                          'closes_at', to_char(closes_at, 'HH24:MI'), 'label', label)
                       order by weekday, opens_at)
      from public.business_hours where tenant_id = t.id), '[]'::jsonb),
    'services', coalesce((
      select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'description', description,
                                          'price_cents', price_cents, 'duration_min', duration_min) order by sort_order, name)
      from public.services where tenant_id = t.id and is_active), '[]'::jsonb)
  );
end $$;

create or replace function public.get_available_slots(
  p_slug text, p_date date, p_party_size integer default 1, p_service_id uuid default null
) returns table (slot_start timestamptz, slot_end timestamptz)
language plpgsql stable security definer set search_path = public as $$
declare
  t public.tenants := public._public_tenant(p_slug);
  s public.booking_settings;
  v_duration int;
begin
  select * into s from public.booking_settings where tenant_id = t.id;
  if not s.booking_enabled or p_party_size < s.min_party_size or p_party_size > s.max_party_size then
    return;
  end if;
  if p_service_id is not null then
    select duration_min into v_duration from public.services where id = p_service_id and tenant_id = t.id and is_active;
    if v_duration is null then return; end if;
  end if;
  return query
  select c.slot_start, c.slot_end
  from public._compute_slots(t.id, p_date, p_party_size, coalesce(v_duration, s.default_duration_min)) c;
end $$;

-- Days (within a range) that still have at least one free slot — for the calendar
create or replace function public.get_available_days(
  p_slug text, p_from date, p_to date, p_party_size integer default 1, p_service_id uuid default null
) returns table (day date)
language plpgsql stable security definer set search_path = public as $$
declare d date;
begin
  if p_to - p_from > 62 then p_to := p_from + 62; end if;
  d := p_from;
  while d <= p_to loop
    if exists (select 1 from public.get_available_slots(p_slug, d, p_party_size, p_service_id)) then
      day := d;
      return next;
    end if;
    d := d + 1;
  end loop;
end $$;

create or replace function public.create_public_reservation(
  p_slug text,
  p_starts_at timestamptz,
  p_party_size integer,
  p_name text,
  p_phone text,
  p_email text default null,
  p_notes text default null,
  p_service_id uuid default null
) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  t public.tenants := public._public_tenant(p_slug);
  s public.booking_settings;
  v_phone text := public.normalize_phone(p_phone);
  v_duration int;
  r public.reservations;
begin
  select * into s from public.booking_settings where tenant_id = t.id;
  if not s.booking_enabled then
    raise exception 'Reservas online estão desativadas no momento.' using errcode = 'P0001', hint = 'BOOKING_DISABLED';
  end if;
  if char_length(btrim(coalesce(p_name, ''))) < 2 then
    raise exception 'Informe seu nome.' using errcode = 'P0001', hint = 'INVALID_NAME';
  end if;
  if v_phone is null or char_length(v_phone) not between 10 and 13 then
    raise exception 'Informe um telefone válido com DDD.' using errcode = 'P0001', hint = 'INVALID_PHONE';
  end if;
  if p_email is not null and btrim(p_email) <> '' and p_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'E-mail inválido.' using errcode = 'P0001', hint = 'INVALID_EMAIL';
  end if;
  if p_party_size is null or p_party_size < s.min_party_size or p_party_size > s.max_party_size then
    raise exception 'Quantidade de pessoas fora do permitido (% a %).', s.min_party_size, s.max_party_size
      using errcode = 'P0001', hint = 'INVALID_PARTY';
  end if;
  if p_service_id is not null then
    select duration_min into v_duration from public.services where id = p_service_id and tenant_id = t.id and is_active;
    if v_duration is null then
      raise exception 'Serviço indisponível.' using errcode = 'P0001', hint = 'INVALID_SERVICE';
    end if;
  end if;
  v_duration := coalesce(v_duration, s.default_duration_min);

  -- serialize writes for this agenda, then revalidate against live data
  perform public._lock_tenant_agenda(t.id);

  if (select count(*) from public.reservations
      where tenant_id = t.id and customer_phone_normalized = v_phone
        and public.is_active_status(status) and starts_at > now()) >= s.max_active_per_phone then
    raise exception 'Você já possui o máximo de reservas ativas neste estabelecimento.' using errcode = 'P0001', hint = 'TOO_MANY_ACTIVE';
  end if;

  if not exists (
    select 1 from public._compute_slots(t.id, (p_starts_at at time zone t.timezone)::date, p_party_size, v_duration) c
    where c.slot_start = p_starts_at
  ) then
    raise exception 'Este horário acabou de ficar indisponível. Escolha outro horário.' using errcode = 'P0001', hint = 'SLOT_UNAVAILABLE';
  end if;

  perform set_config('app.actor_type', 'customer', true);
  begin
    insert into public.reservations (tenant_id, customer_name, customer_phone, customer_email, starts_at, ends_at,
                                     party_size, service_id, status, source, notes)
    values (t.id, btrim(p_name), p_phone, nullif(btrim(p_email), ''), p_starts_at,
            p_starts_at + make_interval(mins => v_duration), p_party_size, p_service_id,
            case when s.require_confirmation then 'pending' else 'confirmed' end::public.reservation_status,
            'online', nullif(left(btrim(p_notes), 1000), ''))
    returning * into r;
  exception when exclusion_violation then
    raise exception 'Você já tem uma reserva que coincide com este horário.' using errcode = 'P0001', hint = 'DUPLICATE';
  end;
  perform set_config('app.actor_type', '', true);

  return jsonb_build_object('code', r.code, 'status', r.status, 'starts_at', r.starts_at, 'ends_at', r.ends_at,
                            'party_size', r.party_size, 'tenant_name', t.name, 'tenant_slug', t.slug, 'timezone', t.timezone);
end $$;

create or replace function public._public_reservation(p_code text, p_phone text) returns public.reservations
language plpgsql stable security definer set search_path = public as $$
declare r public.reservations;
begin
  select * into r from public.reservations
  where code = upper(btrim(p_code))
    and right(customer_phone_normalized, 8) = right(public.normalize_phone(p_phone), 8);
  if r.id is null then
    raise exception 'Reserva não encontrada. Confira o código e o telefone.' using errcode = 'P0002', hint = 'NOT_FOUND';
  end if;
  return r;
end $$;

create or replace function public.get_public_reservation(p_code text, p_phone text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  r public.reservations := public._public_reservation(p_code, p_phone);
  t public.tenants;
  s public.booking_settings;
  v_can_change boolean;
begin
  select * into t from public.tenants where id = r.tenant_id;
  select * into s from public.booking_settings where tenant_id = r.tenant_id;
  v_can_change := r.status in ('pending', 'confirmed')
                  and r.starts_at - make_interval(mins => s.cancellation_min_notice_min) > now();
  return jsonb_build_object(
    'code', r.code, 'status', r.status, 'starts_at', r.starts_at, 'ends_at', r.ends_at,
    'party_size', r.party_size, 'customer_name', r.customer_name, 'notes', r.notes,
    'service_name', (select name from public.services where id = r.service_id),
    'service_id', r.service_id,
    'tenant', jsonb_build_object('name', t.name, 'slug', t.slug, 'segment', t.segment, 'timezone', t.timezone,
                                 'logo_url', t.logo_url, 'brand_color', t.brand_color, 'phone', t.phone,
                                 'address_line', t.address_line, 'address_number', t.address_number, 'city', t.city),
    'can_cancel', v_can_change and s.allow_online_cancel,
    'can_reschedule', v_can_change and s.allow_online_reschedule,
    'cancellation_min_notice_min', s.cancellation_min_notice_min,
    'cancellation_policy', s.cancellation_policy);
end $$;

create or replace function public.cancel_public_reservation(p_code text, p_phone text, p_reason text default null) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  r public.reservations := public._public_reservation(p_code, p_phone);
  s public.booking_settings;
begin
  select * into s from public.booking_settings where tenant_id = r.tenant_id;
  if r.status not in ('pending', 'confirmed') then
    raise exception 'Esta reserva não pode mais ser cancelada.' using errcode = 'P0001', hint = 'NOT_CANCELLABLE';
  end if;
  if not s.allow_online_cancel or r.starts_at - make_interval(mins => s.cancellation_min_notice_min) <= now() then
    raise exception 'Cancelamento online indisponível para esta reserva. Entre em contato com o estabelecimento.'
      using errcode = 'P0001', hint = 'CANCEL_WINDOW';
  end if;
  perform set_config('app.actor_type', 'customer', true);
  update public.reservations
     set status = 'cancelled', cancel_reason = coalesce(nullif(left(btrim(p_reason), 500), ''), 'Cancelado pelo cliente')
   where id = r.id;
  perform set_config('app.actor_type', '', true);
  return public.get_public_reservation(p_code, p_phone);
end $$;

create or replace function public.reschedule_public_reservation(p_code text, p_phone text, p_new_start timestamptz) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  r public.reservations := public._public_reservation(p_code, p_phone);
  s public.booking_settings;
  t public.tenants;
  v_duration int;
begin
  select * into s from public.booking_settings where tenant_id = r.tenant_id;
  select * into t from public.tenants where id = r.tenant_id;
  if r.status not in ('pending', 'confirmed') or not s.allow_online_reschedule
     or r.starts_at - make_interval(mins => s.cancellation_min_notice_min) <= now() then
    raise exception 'Remarcação online indisponível para esta reserva.' using errcode = 'P0001', hint = 'RESCHEDULE_WINDOW';
  end if;
  v_duration := (extract(epoch from (r.ends_at - r.starts_at)) / 60)::int;

  perform public._lock_tenant_agenda(r.tenant_id);
  if not exists (
    select 1 from public._compute_slots(r.tenant_id, (p_new_start at time zone t.timezone)::date, r.party_size, v_duration, r.id) c
    where c.slot_start = p_new_start
  ) then
    raise exception 'Este horário não está disponível.' using errcode = 'P0001', hint = 'SLOT_UNAVAILABLE';
  end if;

  perform set_config('app.actor_type', 'customer', true);
  update public.reservations
     set starts_at = p_new_start, ends_at = p_new_start + make_interval(mins => v_duration)
   where id = r.id;
  perform set_config('app.actor_type', '', true);
  return public.get_public_reservation(p_code, p_phone);
end $$;

-- Slots for a public reschedule (ignores the reservation being moved)
create or replace function public.get_reschedule_slots(p_code text, p_phone text, p_date date)
returns table (slot_start timestamptz, slot_end timestamptz)
language plpgsql stable security definer set search_path = public as $$
declare r public.reservations := public._public_reservation(p_code, p_phone);
begin
  return query
  select c.slot_start, c.slot_end
  from public._compute_slots(r.tenant_id, p_date, r.party_size,
                             (extract(epoch from (r.ends_at - r.starts_at)) / 60)::int, r.id) c;
end $$;

-- =====================================================================
-- Analytics (dashboard + CRM). Membership enforced inside.
-- =====================================================================
create or replace view public.customer_stats with (security_invoker = true) as
select
  c.*,
  count(r.id) as reservations_count,
  count(r.id) filter (where r.status in ('completed', 'in_progress')
                         or (r.status = 'confirmed' and r.ends_at < now())) as visits,
  count(r.id) filter (where r.status = 'cancelled') as cancellations,
  count(r.id) filter (where r.status = 'no_show') as no_shows,
  max(r.starts_at) filter (where r.status in ('completed', 'in_progress')
                              or (r.status = 'confirmed' and r.ends_at < now())) as last_visit_at,
  min(r.starts_at) filter (where r.status in ('pending', 'confirmed') and r.starts_at > now()) as next_reservation_at
from public.customers c
left join public.reservations r on r.customer_id = c.id and r.tenant_id = c.tenant_id
group by c.id;

grant select on public.customer_stats to authenticated;

create or replace function public.dashboard_metrics(p_tenant uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_tz text;
  s public.booking_settings;
  v_start timestamptz;
  v_end timestamptz;
  v_prev_start timestamptz;
  v_days int;
  v_capacity_min numeric;
  v_booked_min numeric;
  v_result jsonb;
begin
  if not public.is_member(p_tenant) then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;
  if p_to < p_from or p_to - p_from > 370 then
    raise exception 'Período inválido.' using errcode = '22023';
  end if;
  select timezone into v_tz from public.tenants where id = p_tenant;
  select * into s from public.booking_settings where tenant_id = p_tenant;

  v_days := p_to - p_from + 1;
  v_start := p_from::timestamp at time zone v_tz;
  v_end := (p_to + 1)::timestamp at time zone v_tz;
  v_prev_start := (p_from - v_days)::timestamp at time zone v_tz;

  -- capacity in "reservation-minutes": open minutes × simultaneous capacity
  if s.max_reservations_per_slot is not null then
    select coalesce(sum(extract(epoch from (bh.closes_at - bh.opens_at)) / 60), 0) * s.max_reservations_per_slot
      into v_capacity_min
    from generate_series(p_from, p_to, interval '1 day') d
    join public.business_hours bh on bh.tenant_id = p_tenant and bh.weekday = extract(dow from d)::int;
  end if;

  select coalesce(sum(extract(epoch from (r.ends_at - r.starts_at)) / 60), 0) into v_booked_min
  from public.reservations r
  where r.tenant_id = p_tenant and r.starts_at >= v_start and r.starts_at < v_end
    and r.status in ('pending', 'confirmed', 'in_progress', 'completed');

  with cur as (
    select * from public.reservations where tenant_id = p_tenant and starts_at >= v_start and starts_at < v_end
  ), prev as (
    select * from public.reservations where tenant_id = p_tenant and starts_at >= v_prev_start and starts_at < v_start
  )
  select jsonb_build_object(
    'timezone', v_tz,
    'period', jsonb_build_object('from', p_from, 'to', p_to, 'days', v_days),
    'totals', jsonb_build_object(
      'reservations', (select count(*) from cur),
      'active', (select count(*) from cur where status <> 'cancelled'),
      'pending', (select count(*) from cur where status = 'pending'),
      'confirmed', (select count(*) from cur where status = 'confirmed'),
      'in_progress', (select count(*) from cur where status = 'in_progress'),
      'completed', (select count(*) from cur where status = 'completed'),
      'cancelled', (select count(*) from cur where status = 'cancelled'),
      'no_show', (select count(*) from cur where status = 'no_show'),
      'guests', (select coalesce(sum(party_size), 0) from cur where status not in ('cancelled', 'no_show')),
      'new_customers', (select count(*) from public.customers where tenant_id = p_tenant and created_at >= v_start and created_at < v_end),
      'online_share', (select case when count(*) = 0 then null else round(100.0 * count(*) filter (where source = 'online') / count(*), 1) end from cur)
    ),
    'previous', jsonb_build_object(
      'reservations', (select count(*) from prev),
      'cancelled', (select count(*) from prev where status = 'cancelled'),
      'no_show', (select count(*) from prev where status = 'no_show'),
      'guests', (select coalesce(sum(party_size), 0) from prev where status not in ('cancelled', 'no_show')),
      'new_customers', (select count(*) from public.customers where tenant_id = p_tenant and created_at >= v_prev_start and created_at < v_start)
    ),
    'occupancy', case when v_capacity_min is null or v_capacity_min = 0 then null
                      else round(least(100, 100 * v_booked_min / v_capacity_min), 1) end,
    'by_hour', coalesce((
      select jsonb_agg(jsonb_build_object('hour', h, 'count', c) order by h)
      from (select extract(hour from starts_at at time zone v_tz)::int as h, count(*) as c
            from cur where status not in ('cancelled') group by 1) x), '[]'::jsonb),
    'by_day', coalesce((
      select jsonb_agg(jsonb_build_object('date', d::date,
              'total', (select count(*) from cur where (starts_at at time zone v_tz)::date = d::date and status <> 'cancelled'),
              'cancelled', (select count(*) from cur where (starts_at at time zone v_tz)::date = d::date and status = 'cancelled'),
              'guests', (select coalesce(sum(party_size), 0) from cur where (starts_at at time zone v_tz)::date = d::date and status not in ('cancelled', 'no_show')))
             order by d)
      from generate_series(p_from, p_to, interval '1 day') d), '[]'::jsonb),
    'by_source', coalesce((
      select jsonb_agg(jsonb_build_object('source', source, 'count', c))
      from (select source, count(*) c from cur group by source) x), '[]'::jsonb),
    'by_weekday', coalesce((
      select jsonb_agg(jsonb_build_object('weekday', w, 'count', c) order by w)
      from (select extract(dow from starts_at at time zone v_tz)::int w, count(*) c from cur where status <> 'cancelled' group by 1) x), '[]'::jsonb)
  ) into v_result;

  return v_result;
end $$;

create or replace function public.customer_insights(p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  if not public.is_member(p_tenant) then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;
  with cs as (
    select c.id, c.created_at,
           count(r.id) filter (where r.status in ('completed', 'in_progress') or (r.status = 'confirmed' and r.ends_at < now())) as visits,
           max(r.starts_at) filter (where r.status in ('completed', 'in_progress') or (r.status = 'confirmed' and r.ends_at < now())) as last_visit,
           min(r.starts_at) filter (where r.status in ('completed', 'in_progress') or (r.status = 'confirmed' and r.ends_at < now())) as first_visit,
           count(r.id) filter (where r.status = 'cancelled') as cancels,
           count(r.id) filter (where r.status = 'no_show') as no_shows
    from public.customers c
    left join public.reservations r on r.customer_id = c.id
    where c.tenant_id = p_tenant
    group by c.id
  )
  select jsonb_build_object(
    'total', count(*),
    'new_30d', count(*) filter (where created_at >= now() - interval '30 days'),
    'recurring', count(*) filter (where visits >= 2),
    'inactive_60d', count(*) filter (where visits >= 1 and last_visit < now() - interval '60 days'),
    'with_no_show', count(*) filter (where no_shows > 0),
    'total_cancellations', coalesce(sum(cancels), 0),
    'total_no_shows', coalesce(sum(no_shows), 0),
    'avg_days_between_visits', round(avg(extract(epoch from (last_visit - first_visit)) / 86400 / nullif(visits - 1, 0))::numeric, 1)
  ) into v from cs;
  return v;
end $$;

-- =====================================================================
-- Function privileges: internal helpers are not callable by clients.
-- =====================================================================
-- Supabase grants EXECUTE to anon/authenticated by default; take it all back
-- and re-grant explicitly so internal helpers (e.g. _compute_slots,
-- _enqueue_customer_message) can never be called directly by a client.
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
  end loop;
end $$;
grant execute on function
  public.get_public_page(text),
  public.get_available_slots(text, date, integer, uuid),
  public.get_available_days(text, date, date, integer, uuid),
  public.create_public_reservation(text, timestamptz, integer, text, text, text, text, uuid),
  public.get_public_reservation(text, text),
  public.cancel_public_reservation(text, text, text),
  public.reschedule_public_reservation(text, text, timestamptz),
  public.get_reschedule_slots(text, text, date),
  public.slug_available(text)
to anon, authenticated;

grant execute on function
  public.create_tenant(text, text, public.segment_type, text, text),
  public.accept_invitations(),
  public.get_team(uuid),
  public.get_tenant_slots(uuid, date, integer, integer, uuid),
  public.dashboard_metrics(uuid, date, date),
  public.customer_insights(uuid),
  public.is_platform_admin(), public.tenant_role(uuid), public.is_member(uuid), public.is_manager(uuid),
  public.is_owner(uuid), public.can_write(uuid), public.can_manage(uuid), public.shares_tenant_with(uuid)
to authenticated;

-- Helpers that run inside RLS policies / triggers on behalf of the caller
grant execute on function
  public.normalize_phone(text), public.is_active_status(public.reservation_status),
  public.set_updated_at(), public.customers_normalize(), public.reservations_before_write(),
  public._lock_tenant_agenda(uuid), public._window_load(uuid, timestamptz, timestamptz, uuid),
  public.gen_reservation_code(), public.is_valid_timezone(text), public._fmt_local(timestamptz, text)
to authenticated;
