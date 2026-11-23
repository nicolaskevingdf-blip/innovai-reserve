-- =====================================================================
-- INNOVAI RESERVE — 03 · Booking engine
--  * availability (hours, shifts, blocks, advance windows, timezone) by
--    capacity, by table (restaurants) or by professional (services)
--  * write-time revalidation under a per-tenant advisory lock, so two
--    concurrent requests can never both take the last place
--  * change history + notification outbox
-- =====================================================================

create or replace function public.is_active_status(s public.reservation_status) returns boolean
language sql immutable as $$ select s in ('pending', 'confirmed', 'in_progress') $$;

create or replace function public._lock_tenant_agenda(p_tenant uuid) returns void
language sql volatile as $$
  select pg_advisory_xact_lock(hashtextextended('innovai:agenda:' || p_tenant::text, 0))
$$;

-- Load of the agenda for a window (non-professional reservations, with buffer)
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
    and r.staff_id is null
    and r.starts_at < p_end + make_interval(mins => s.buffer_min)
    and r.ends_at + make_interval(mins => s.buffer_min) > p_start
$$;

-- ---------------------------------------------------------------------
-- Tables (restaurants)
-- ---------------------------------------------------------------------
create or replace function public._tables_free(
  p_tenant uuid, p_tables uuid[], p_start timestamptz, p_end timestamptz, p_ignore uuid default null
) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(cardinality(p_tables), 0) > 0
     and not exists (
       select 1
       from public.reservation_tables rt
       join public.booking_settings s on s.tenant_id = p_tenant
       where rt.table_id = any (p_tables) and rt.active
         and (p_ignore is null or rt.reservation_id <> p_ignore)
         and rt.period && tstzrange(p_start, p_end + make_interval(mins => s.buffer_min), '[)'))
     and not exists (
       select 1 from public.schedule_blocks b
       where b.tenant_id = p_tenant and b.table_id = any (p_tables)
         and b.starts_at < p_end and b.ends_at > p_start)
     and not exists (
       select 1 from unnest(p_tables) x(id)
       left join public.dining_tables t on t.id = x.id and t.tenant_id = p_tenant
       where t.id is null or not t.is_active)
$$;

-- Best fit: smallest single table that seats the group; otherwise the
-- smallest configured combination whose tables are all free.
create or replace function public._find_tables(
  p_tenant uuid, p_start timestamptz, p_end timestamptz, p_party integer, p_area uuid default null, p_ignore uuid default null
) returns uuid[]
language plpgsql stable security definer set search_path = public as $$
declare v uuid[];
begin
  select array[t.id] into v
  from public.dining_tables t
  where t.tenant_id = p_tenant and t.is_active
    and t.max_capacity >= p_party and t.min_capacity <= p_party
    and (p_area is null or t.area_id = p_area)
    and public._tables_free(p_tenant, array[t.id], p_start, p_end, p_ignore)
  order by t.max_capacity, t.name
  limit 1;
  if v is not null then return v; end if;

  select c.table_ids into v
  from public.table_combinations c
  where c.tenant_id = p_tenant and c.is_active
    and c.max_capacity >= p_party and c.min_capacity <= p_party
    and (p_area is null or (select t.area_id from public.dining_tables t where t.id = c.table_ids[1]) = p_area)
    and public._tables_free(p_tenant, c.table_ids, p_start, p_end, p_ignore)
  order by c.max_capacity, cardinality(c.table_ids)
  limit 1;
  return v;
end $$;

-- ---------------------------------------------------------------------
-- Professionals (services)
-- ---------------------------------------------------------------------
-- Scheduled to work for the whole [start, end)? Without individual hours,
-- the establishment hours apply.
create or replace function public._staff_working(p_tenant uuid, p_staff uuid, p_start timestamptz, p_end timestamptz)
returns boolean
language sql stable security definer set search_path = public as $$
  with loc as (
    select (p_start at time zone t.timezone) as ls, (p_end at time zone t.timezone) as le
    from public.tenants t where t.id = p_tenant
  )
  select case
    when exists (select 1 from public.staff_hours where staff_id = p_staff) then
      exists (select 1 from public.staff_hours h, loc
              where h.staff_id = p_staff and h.weekday = extract(dow from loc.ls)::int
                and loc.ls >= loc.ls::date + h.opens_at and loc.le <= loc.ls::date + h.closes_at)
    else
      exists (select 1 from public.business_hours h, loc
              where h.tenant_id = p_tenant and h.weekday = extract(dow from loc.ls)::int
                and loc.ls >= loc.ls::date + h.opens_at and loc.le <= loc.ls::date + h.closes_at)
  end
$$;

-- Busy (service, clean-up, block) or inactive during [start, occupied_end)?
create or replace function public._staff_busy(p_tenant uuid, p_staff uuid, p_start timestamptz, p_occ_end timestamptz, p_ignore uuid default null)
returns boolean
language sql stable security definer set search_path = public as $$
  select not exists (select 1 from public.staff where id = p_staff and tenant_id = p_tenant and is_active)
      or exists (
        select 1 from public.reservations r
        where r.tenant_id = p_tenant and r.staff_id = p_staff
          and r.status in ('pending', 'confirmed', 'in_progress')
          and (p_ignore is null or r.id <> p_ignore)
          and tstzrange(r.starts_at, coalesce(r.occupied_until, r.ends_at), '[)') && tstzrange(p_start, p_occ_end, '[)'))
      or exists (
        select 1 from public.schedule_blocks b
        where b.tenant_id = p_tenant and b.staff_id = p_staff
          and b.starts_at < p_occ_end and b.ends_at > p_start)
$$;

-- Qualified + working + free; preferred one if given, otherwise the one with
-- the fewest bookings that day (balanced agenda), then sort order.
create or replace function public._find_staff(
  p_tenant uuid, p_service uuid, p_start timestamptz, p_end timestamptz, p_occ_end timestamptz,
  p_preferred uuid default null, p_ignore uuid default null
) returns uuid
language sql stable security definer set search_path = public as $$
  select s.id
  from public.staff s
  cross join (select timezone from public.tenants where id = p_tenant) tz
  where s.tenant_id = p_tenant and s.is_active
    and (p_preferred is null or s.id = p_preferred)
    and (p_service is null
         or not exists (select 1 from public.service_staff ss where ss.service_id = p_service)
         or exists (select 1 from public.service_staff ss where ss.service_id = p_service and ss.staff_id = s.id))
    and public._staff_working(p_tenant, s.id, p_start, p_end)
    and not public._staff_busy(p_tenant, s.id, p_start, p_occ_end, p_ignore)
  order by (select count(*) from public.reservations r
            where r.staff_id = s.id and r.status in ('pending', 'confirmed', 'in_progress', 'completed')
              and (r.starts_at at time zone tz.timezone)::date = (p_start at time zone tz.timezone)::date),
           s.sort_order, s.name
  limit 1
$$;

-- Clean-up interval for a service in staff mode
create or replace function public._service_buffer(p_tenant uuid, p_service uuid) returns integer
language sql stable security definer set search_path = public as $$
  select coalesce((select buffer_min from public.services where id = p_service and tenant_id = p_tenant), 0)
       + coalesce((select buffer_min from public.booking_settings where tenant_id = p_tenant), 0)
$$;

-- ---------------------------------------------------------------------
-- Availability: returns only genuinely bookable start times
-- ---------------------------------------------------------------------
create or replace function public._compute_slots(
  p_tenant uuid, p_date date, p_party integer, p_duration integer, p_ignore uuid default null,
  p_area uuid default null, p_service uuid default null, p_staff uuid default null
) returns table (slot_start timestamptz, slot_end timestamptz, remaining_reservations integer, remaining_guests integer)
language plpgsql stable security definer set search_path = public as $$
declare
  s public.booking_settings;
  v_tz text;
  v_today date;
  v_tables boolean;
  v_staff boolean;
  v_buffer int;
begin
  select * into s from public.booking_settings where tenant_id = p_tenant;
  select timezone into v_tz from public.tenants where id = p_tenant;
  if not found or s.tenant_id is null or p_duration is null or p_duration < 5 then
    return;
  end if;
  v_tables := s.allocation_mode = 'tables';
  v_staff := s.allocation_mode = 'staff';
  v_buffer := case when v_staff then public._service_buffer(p_tenant, p_service) else 0 end;

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
         case when v_tables or v_staff or s.max_reservations_per_slot is null then null else s.max_reservations_per_slot - l.reservations end,
         case when v_staff or s.max_guests_per_slot is null then null else s.max_guests_per_slot - l.guests end
  from windows w
  cross join lateral public._window_load(p_tenant, w.st, w.en, p_ignore) l
  where (v_tables or v_staff or s.max_reservations_per_slot is null or l.reservations < s.max_reservations_per_slot)
    and (v_staff or s.max_guests_per_slot is null or l.guests + p_party <= s.max_guests_per_slot)
    and (not v_tables or public._find_tables(p_tenant, w.st, w.en, p_party, p_area, p_ignore) is not null)
    and (not v_staff or public._find_staff(p_tenant, p_service, w.st, w.en, w.en + make_interval(mins => v_buffer), p_staff, p_ignore) is not null)
  order by w.st;
end $$;

-- ---------------------------------------------------------------------
-- BEFORE trigger: normalisation + hard revalidation on every write path.
-- SECURITY DEFINER keeps internal helpers off the API; the row is still
-- subject to the caller's RLS WITH CHECK after this trigger.
-- ---------------------------------------------------------------------
create or replace function public.reservations_before_write() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  s public.booking_settings;
  l record;
  v_duration integer;
  v_needs_check boolean;
  v_staff_mode boolean;
begin
  new.customer_name := btrim(new.customer_name);
  new.customer_phone := btrim(new.customer_phone);
  new.customer_phone_normalized := public.normalize_phone(new.customer_phone);
  new.customer_email := nullif(lower(btrim(new.customer_email)), '');
  new.table_ids := coalesce(array(select u.x from unnest(new.table_ids) with ordinality u(x, o) where u.x is not null group by u.x order by min(u.o)), '{}');
  if cardinality(new.table_ids) = 0 and new.table_id is not null and (tg_op = 'INSERT' or new.table_id is distinct from old.table_id) then
    new.table_ids := array[new.table_id];
  end if;

  select * into s from public.booking_settings where tenant_id = new.tenant_id;
  v_staff_mode := s.allocation_mode = 'staff';

  if new.ends_at is null then
    select duration_min into v_duration from public.services where id = new.service_id and tenant_id = new.tenant_id;
    new.ends_at := new.starts_at + make_interval(mins => coalesce(v_duration, s.default_duration_min, 60));
  end if;

  if tg_op = 'UPDATE' then
    if new.starts_at is distinct from old.starts_at and new.ends_at is not distinct from old.ends_at then
      new.ends_at := new.starts_at + (old.ends_at - old.starts_at);
    end if;
    if new.code is distinct from old.code or new.tenant_id is distinct from old.tenant_id then
      raise exception 'Código e estabelecimento da reserva não podem ser alterados.' using errcode = '42501';
    end if;
  end if;

  -- protected window for the professional = service + clean-up interval
  new.occupied_until := new.ends_at + make_interval(mins => case when v_staff_mode then public._service_buffer(new.tenant_id, new.service_id) else 0 end);

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
    or new.service_id is distinct from old.service_id
    or new.table_ids is distinct from old.table_ids
    or new.area_id is distinct from old.area_id
  );

  if v_needs_check then
    perform public._lock_tenant_agenda(new.tenant_id);

    -- ----- professional allocation -----
    if new.staff_id is not null and public._staff_busy(new.tenant_id, new.staff_id, new.starts_at, new.occupied_until, new.id) then
      if v_staff_mode and tg_op = 'UPDATE' and new.staff_id = old.staff_id and not new.staff_requested then
        new.staff_id := null; -- customer accepted "any professional": try someone else
      else
        raise exception 'O profissional já tem atendimento, intervalo ou bloqueio neste horário.' using errcode = 'P0001', hint = 'STAFF_BUSY';
      end if;
    end if;
    if v_staff_mode and new.staff_id is null then
      new.staff_id := public._find_staff(new.tenant_id, new.service_id, new.starts_at, new.ends_at, new.occupied_until, null, new.id);
      if new.staff_id is null then
        raise exception 'Nenhum profissional disponível para este serviço neste horário.' using errcode = 'P0001', hint = 'NO_STAFF';
      end if;
    end if;

    -- ----- table allocation (restaurants) -----
    if cardinality(new.table_ids) > 0 then
      if exists (select 1 from unnest(new.table_ids) x(id)
                 where not exists (select 1 from public.dining_tables t where t.id = x.id and t.tenant_id = new.tenant_id)) then
        raise exception 'Mesa inválida para este estabelecimento.' using errcode = '42501';
      end if;
      if not public._tables_free(new.tenant_id, new.table_ids, new.starts_at, new.ends_at, new.id) then
        if tg_op = 'UPDATE' and new.table_ids = old.table_ids and s.allocation_mode = 'tables' then
          new.table_ids := '{}';
        else
          raise exception 'A mesa escolhida já está ocupada, bloqueada ou inativa neste horário.' using errcode = 'P0001', hint = 'TABLE_TAKEN';
        end if;
      elsif tg_op = 'UPDATE' and new.table_ids = old.table_ids and s.allocation_mode = 'tables'
            and new.party_size > old.party_size
            and (select coalesce(sum(max_capacity), 0) from public.dining_tables where id = any (new.table_ids)) < new.party_size then
        new.table_ids := '{}';
      end if;
    end if;

    if s.allocation_mode = 'tables' and new.staff_id is null and cardinality(new.table_ids) = 0 then
      new.table_ids := coalesce(public._find_tables(new.tenant_id, new.starts_at, new.ends_at, new.party_size, new.area_id, new.id), '{}');
      if cardinality(new.table_ids) = 0 then
        raise exception 'Nenhuma mesa disponível para % pessoa(s) neste horário.', new.party_size
          using errcode = 'P0001', hint = 'NO_TABLE';
      end if;
    end if;

    if exists (
      select 1 from public.schedule_blocks b
      where b.tenant_id = new.tenant_id
        and b.starts_at < new.ends_at and b.ends_at > new.starts_at
        and ((b.staff_id is null and b.table_id is null) or b.staff_id = new.staff_id)
    ) then
      raise exception 'Este horário está bloqueado na agenda.' using errcode = 'P0001', hint = 'SLOT_BLOCKED';
    end if;

    if new.staff_id is null and s.tenant_id is not null then
      select * into l from public._window_load(new.tenant_id, new.starts_at, new.ends_at, new.id);
      if s.allocation_mode = 'capacity' and s.max_reservations_per_slot is not null and l.reservations >= s.max_reservations_per_slot then
        raise exception 'Horário lotado: limite de % reserva(s) simultânea(s).', s.max_reservations_per_slot
          using errcode = 'P0001', hint = 'SLOT_FULL';
      end if;
      if s.max_guests_per_slot is not null and l.guests + new.party_size > s.max_guests_per_slot then
        raise exception 'Horário lotado: limite de % pessoas simultâneas.', s.max_guests_per_slot
          using errcode = 'P0001', hint = 'SLOT_FULL';
      end if;
    end if;
  end if;

  new.table_id := new.table_ids[1];
  if new.table_id is not null and (new.area_id is null or v_needs_check) then
    new.area_id := coalesce((select area_id from public.dining_tables where id = new.table_id), new.area_id);
  end if;

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
-- AFTER triggers: history, notification outbox, table occupancy, waitlist
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

-- mirror reservation → reservation_tables (the exclusion constraint lives there)
create or replace function public.reservations_sync_tables() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_buffer int;
begin
  if tg_op = 'UPDATE'
     and new.table_ids is not distinct from old.table_ids
     and new.starts_at = old.starts_at and new.ends_at = old.ends_at
     and public.is_active_status(new.status) = public.is_active_status(old.status) then
    return null;
  end if;
  select buffer_min into v_buffer from public.booking_settings where tenant_id = new.tenant_id;
  delete from public.reservation_tables where reservation_id = new.id;
  insert into public.reservation_tables (reservation_id, tenant_id, table_id, period, active)
  select new.id, new.tenant_id, x, tstzrange(new.starts_at, new.ends_at + make_interval(mins => coalesce(v_buffer, 0)), '[)'),
         public.is_active_status(new.status)
  from unnest(new.table_ids) x;
  return null;
end $$;
create trigger reservations_sync_tables after insert or update on public.reservations
  for each row execute function public.reservations_sync_tables();

create or replace function public.reservations_table_history() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and new.table_ids is distinct from old.table_ids and new.starts_at = old.starts_at
     and new.status = old.status then
    insert into public.reservation_events (tenant_id, reservation_id, actor_id, actor_type, action, changes)
    values (new.tenant_id, new.id, auth.uid(),
            coalesce(nullif(current_setting('app.actor_type', true), ''), case when auth.uid() is null then 'system' else 'staff' end),
            'table_changed',
            jsonb_build_object('table_ids', jsonb_build_object('from', to_jsonb(old.table_ids), 'to', to_jsonb(new.table_ids))));
  end if;
  return null;
end $$;
create trigger reservations_table_history after update on public.reservations
  for each row execute function public.reservations_table_history();

create or replace function public.reservations_staff_history() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.staff_id is distinct from old.staff_id and new.starts_at = old.starts_at and new.status = old.status then
    insert into public.reservation_events (tenant_id, reservation_id, actor_id, actor_type, action, changes)
    values (new.tenant_id, new.id, auth.uid(),
            coalesce(nullif(current_setting('app.actor_type', true), ''), case when auth.uid() is null then 'system' else 'staff' end),
            'staff_changed',
            jsonb_build_object('staff_id', jsonb_build_object('from', old.staff_id, 'to', new.staff_id)));
  end if;
  return null;
end $$;
create trigger reservations_staff_history after update on public.reservations
  for each row execute function public.reservations_staff_history();

-- a cancellation frees a slot → tell the team if someone is waiting that day
create or replace function public.reservations_waitlist_hint() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_tz text;
  v_day date;
  v_waiting int;
begin
  if new.status not in ('cancelled', 'no_show') or old.status = new.status then
    return null;
  end if;
  select timezone into v_tz from public.tenants where id = new.tenant_id;
  v_day := (new.starts_at at time zone v_tz)::date;
  select count(*) into v_waiting from public.waitlist_entries
  where tenant_id = new.tenant_id and desired_date = v_day and status = 'waiting';
  if v_waiting > 0 then
    insert into public.notifications (tenant_id, reservation_id, channel, template, audience, title, body, status, sent_at)
    values (new.tenant_id, new.id, 'in_app', 'staff_waitlist_slot', 'staff', 'Vaga liberada',
            format('%s às %s · %s pessoa(s) na lista de espera deste dia', to_char(v_day, 'DD/MM'),
                   to_char(new.starts_at at time zone v_tz, 'HH24:MI'), v_waiting),
            'sent', now());
  end if;
  return null;
end $$;
create trigger reservations_waitlist_hint after update of status on public.reservations
  for each row execute function public.reservations_waitlist_hint();
