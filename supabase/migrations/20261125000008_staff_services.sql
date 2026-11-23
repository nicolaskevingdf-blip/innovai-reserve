-- =====================================================================
-- INNOVAI RESERVE — Phase 3: professionals & services (barbearia/salão)
--  * allocation mode "staff": availability = some qualified professional
--    is working and free for the full service duration (+ clean-up)
--  * "any professional": balanced choice (fewest bookings that day)
--  * DB-level guarantee: a professional never has overlapping services,
--    including the post-service interval (exclusion constraint)
--  * individual working hours, days off (blocks), per-staff agenda
--  * metrics per professional and per service
-- =====================================================================

alter table public.booking_settings drop constraint booking_settings_allocation_mode_check;
alter table public.booking_settings
  add constraint booking_settings_allocation_mode_check check (allocation_mode in ('capacity', 'tables', 'staff'));

alter table public.staff
  add column color text not null default '#C6F432' check (color ~ '^#[0-9A-Fa-f]{6}$'),
  add column updated_at timestamptz not null default now();
create unique index staff_member_uniq on public.staff (member_id) where member_id is not null;
create index staff_tenant_idx on public.staff (tenant_id, is_active, sort_order);
create index services_tenant_idx on public.services (tenant_id, is_active, sort_order);
create index staff_hours_staff_idx on public.staff_hours (staff_id, weekday);
create trigger staff_updated_at before update on public.staff for each row execute function public.set_updated_at();

-- end of the protected window for the professional (service end + clean-up interval)
alter table public.reservations
  add column occupied_until timestamptz,
  add column staff_requested boolean not null default false;
update public.reservations set occupied_until = ends_at;

alter table public.reservations drop constraint reservations_no_staff_overlap;
alter table public.reservations add constraint reservations_no_staff_overlap exclude using gist (
  staff_id with =, tstzrange(starts_at, coalesce(occupied_until, ends_at), '[)') with &&
) where (staff_id is not null and status in ('pending', 'confirmed', 'in_progress'));

-- service_staff must stay inside the tenant (composite FKs already) — expose to members
grant select, insert, update, delete on public.staff, public.staff_hours, public.services, public.service_staff to authenticated;

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------
-- Is the professional scheduled to work for the whole [start, end)? Without
-- individual hours, the establishment hours apply.
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

-- Is the professional busy (service, clean-up, block) or inactive during [start, occupied_end)?
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

-- Qualified + working + free professional. Preferred one if given, otherwise
-- the one with the fewest bookings that day (balanced agenda), then sort order.
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
-- Availability (now staff-aware)
-- ---------------------------------------------------------------------
drop function public._compute_slots(uuid, date, integer, integer, uuid, uuid);
create function public._compute_slots(
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
-- BEFORE trigger (replaces Phase 2 version): adds professional allocation
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

-- Professional changes appear in history too
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

-- ---------------------------------------------------------------------
-- Staff RPCs
-- ---------------------------------------------------------------------
drop function public.get_tenant_slots(uuid, date, integer, integer, uuid, uuid);
create function public.get_tenant_slots(
  p_tenant uuid, p_date date, p_party integer default 1, p_duration integer default null, p_ignore uuid default null,
  p_area uuid default null, p_service uuid default null, p_staff uuid default null
) returns table (slot_start timestamptz, slot_end timestamptz, remaining_reservations integer, remaining_guests integer)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_member(p_tenant) then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;
  return query
  select * from public._compute_slots(
    p_tenant, p_date, greatest(coalesce(p_party, 1), 1),
    coalesce(p_duration,
             (select duration_min from public.services where id = p_service and tenant_id = p_tenant),
             (select default_duration_min from public.booking_settings where tenant_id = p_tenant)),
    p_ignore, p_area, p_service, p_staff);
end $$;

-- Which professionals can take [start, end) for a service (for the manual form)
create or replace function public.get_free_staff(
  p_tenant uuid, p_start timestamptz, p_end timestamptz, p_service uuid default null, p_ignore uuid default null
) returns table (staff_id uuid, is_free boolean, is_working boolean, is_qualified boolean)
language plpgsql stable security definer set search_path = public as $$
declare v_occ timestamptz;
begin
  if not public.is_member(p_tenant) then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;
  v_occ := p_end + make_interval(mins => public._service_buffer(p_tenant, p_service));
  return query
  select st.id,
         not public._staff_busy(p_tenant, st.id, p_start, v_occ, p_ignore),
         public._staff_working(p_tenant, st.id, p_start, p_end),
         (p_service is null
          or not exists (select 1 from public.service_staff ss where ss.service_id = p_service)
          or exists (select 1 from public.service_staff ss where ss.service_id = p_service and ss.staff_id = st.id))
  from public.staff st where st.tenant_id = p_tenant and st.is_active order by st.sort_order, st.name;
end $$;

-- Atomic save of a professional's weekly hours + services
create or replace function public.save_staff_profile(p_staff uuid, p_hours jsonb, p_service_ids uuid[]) returns void
language plpgsql security invoker set search_path = public as $$
declare v_tenant uuid;
begin
  select tenant_id into v_tenant from public.staff where id = p_staff;
  if v_tenant is null or not public.can_manage(v_tenant) then
    raise exception 'Somente proprietário ou gerente pode editar profissionais.' using errcode = '42501';
  end if;
  delete from public.staff_hours where staff_id = p_staff;
  insert into public.staff_hours (tenant_id, staff_id, weekday, opens_at, closes_at)
  select v_tenant, p_staff, (h ->> 'weekday')::smallint, (h ->> 'opens_at')::time, (h ->> 'closes_at')::time
  from jsonb_array_elements(coalesce(p_hours, '[]'::jsonb)) h;
  delete from public.service_staff where staff_id = p_staff;
  insert into public.service_staff (tenant_id, service_id, staff_id)
  select v_tenant, x, p_staff from unnest(coalesce(p_service_ids, '{}')) x;
exception
  when exclusion_violation then
    raise exception 'Há turnos sobrepostos no mesmo dia.' using errcode = 'P0001', hint = 'HOURS_OVERLAP';
  when check_violation then
    raise exception 'O fim do turno deve ser depois do início.' using errcode = 'P0001', hint = 'HOURS_INVALID';
  when foreign_key_violation then
    raise exception 'Serviço inválido para este estabelecimento.' using errcode = '42501';
end $$;

-- Metrics per professional / service (barbershop dashboard & reports)
create or replace function public.staff_service_metrics(p_tenant uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_tz text;
  v_start timestamptz;
  v_end timestamptz;
  v_work numeric := 0;
  v_booked numeric;
  st record;
  d date;
begin
  if not public.is_member(p_tenant) then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;
  select timezone into v_tz from public.tenants where id = p_tenant;
  v_start := p_from::timestamp at time zone v_tz;
  v_end := (p_to + 1)::timestamp at time zone v_tz;

  -- working minutes of every active professional in the period
  for st in select id from public.staff where tenant_id = p_tenant and is_active loop
    for d in select generate_series(p_from, p_to, interval '1 day')::date loop
      if exists (select 1 from public.staff_hours where staff_id = st.id) then
        v_work := v_work + coalesce((select sum(extract(epoch from (closes_at - opens_at)) / 60) from public.staff_hours
                                     where staff_id = st.id and weekday = extract(dow from d)::int), 0);
      else
        v_work := v_work + coalesce((select sum(extract(epoch from (closes_at - opens_at)) / 60) from public.business_hours
                                     where tenant_id = p_tenant and weekday = extract(dow from d)::int), 0);
      end if;
    end loop;
  end loop;

  select coalesce(sum(extract(epoch from (r.ends_at - r.starts_at)) / 60), 0) into v_booked
  from public.reservations r
  where r.tenant_id = p_tenant and r.staff_id is not null and r.starts_at >= v_start and r.starts_at < v_end
    and r.status in ('pending', 'confirmed', 'in_progress', 'completed');

  return jsonb_build_object(
    'occupancy', case when v_work = 0 then null else round(least(100, 100 * v_booked / v_work), 1) end,
    'by_staff', coalesce((
      select jsonb_agg(x order by x.appointments desc) from (
        select st2.id as staff_id, st2.name, st2.color,
               count(r.id) filter (where r.status in ('pending', 'confirmed', 'in_progress', 'completed')) as appointments,
               count(r.id) filter (where r.status = 'completed') as completed,
               count(r.id) filter (where r.status = 'no_show') as no_shows,
               coalesce(sum(sv.price_cents) filter (where r.status = 'completed'), 0) as revenue_cents
        from public.staff st2
        left join public.reservations r on r.staff_id = st2.id and r.starts_at >= v_start and r.starts_at < v_end
        left join public.services sv on sv.id = r.service_id
        where st2.tenant_id = p_tenant
        group by st2.id) x), '[]'::jsonb),
    'by_service', coalesce((
      select jsonb_agg(x order by x.appointments desc) from (
        select sv.id as service_id, sv.name, count(r.id) as appointments,
               count(r.id) filter (where r.status = 'completed') as completed,
               coalesce(sum(sv.price_cents) filter (where r.status = 'completed'), 0) as revenue_cents
        from public.services sv
        join public.reservations r on r.service_id = sv.id and r.starts_at >= v_start and r.starts_at < v_end
             and r.status in ('pending', 'confirmed', 'in_progress', 'completed')
        where sv.tenant_id = p_tenant
        group by sv.id) x), '[]'::jsonb)
  );
end $$;

-- ---------------------------------------------------------------------
-- Public RPCs (re-declared with service/professional)
-- ---------------------------------------------------------------------
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
      'default_duration_min', s.default_duration_min, 'allocation_mode', s.allocation_mode),
    'hours', coalesce((
      select jsonb_agg(jsonb_build_object('weekday', weekday, 'opens_at', to_char(opens_at, 'HH24:MI'),
                                          'closes_at', to_char(closes_at, 'HH24:MI'), 'label', label)
                       order by weekday, opens_at)
      from public.business_hours where tenant_id = t.id), '[]'::jsonb),
    'services', coalesce((
      select jsonb_agg(jsonb_build_object('id', sv.id, 'name', sv.name, 'description', sv.description,
                                          'price_cents', sv.price_cents, 'duration_min', sv.duration_min) order by sv.sort_order, sv.name)
      from public.services sv where sv.tenant_id = t.id and sv.is_active), '[]'::jsonb),
    'areas', case when s.allocation_mode = 'tables' then coalesce((
      select jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'description', a.description) order by a.sort_order, a.name)
      from public.areas a
      where a.tenant_id = t.id and a.is_active
        and exists (select 1 from public.dining_tables dt where dt.area_id = a.id and dt.is_active)), '[]'::jsonb)
      else '[]'::jsonb end,
    'staff', case when s.allocation_mode = 'staff' then coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', st.id, 'name', st.name, 'photo_url', st.photo_url, 'specialty', st.specialty, 'bio', st.bio,
               'service_ids', coalesce((select jsonb_agg(ss.service_id) from public.service_staff ss where ss.staff_id = st.id), '[]'::jsonb))
             order by st.sort_order, st.name)
      from public.staff st where st.tenant_id = t.id and st.is_active), '[]'::jsonb)
      else '[]'::jsonb end
  );
end $$;

drop function public.get_available_days(text, date, date, integer, uuid, uuid);
drop function public.get_available_slots(text, date, integer, uuid, uuid);

create function public.get_available_slots(
  p_slug text, p_date date, p_party_size integer default 1, p_service_id uuid default null,
  p_area_id uuid default null, p_staff_id uuid default null
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
  elsif s.allocation_mode = 'staff' and exists (select 1 from public.services where tenant_id = t.id and is_active) then
    return; -- a service must be chosen first
  end if;
  if p_area_id is not null and not exists (select 1 from public.areas where id = p_area_id and tenant_id = t.id and is_active) then
    return;
  end if;
  if p_staff_id is not null and not exists (select 1 from public.staff where id = p_staff_id and tenant_id = t.id and is_active) then
    return;
  end if;
  return query
  select c.slot_start, c.slot_end
  from public._compute_slots(t.id, p_date, p_party_size, coalesce(v_duration, s.default_duration_min), null,
                             p_area_id, p_service_id, p_staff_id) c;
end $$;

create function public.get_available_days(
  p_slug text, p_from date, p_to date, p_party_size integer default 1, p_service_id uuid default null,
  p_area_id uuid default null, p_staff_id uuid default null
) returns table (day date)
language plpgsql stable security definer set search_path = public as $$
declare d date;
begin
  if p_to - p_from > 62 then p_to := p_from + 62; end if;
  d := p_from;
  while d <= p_to loop
    if exists (select 1 from public.get_available_slots(p_slug, d, p_party_size, p_service_id, p_area_id, p_staff_id)) then
      day := d;
      return next;
    end if;
    d := d + 1;
  end loop;
end $$;

drop function public.create_public_reservation(text, timestamptz, integer, text, text, text, text, uuid, uuid);
create function public.create_public_reservation(
  p_slug text,
  p_starts_at timestamptz,
  p_party_size integer,
  p_name text,
  p_phone text,
  p_email text default null,
  p_notes text default null,
  p_service_id uuid default null,
  p_area_id uuid default null,
  p_staff_id uuid default null
) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  t public.tenants := public._public_tenant(p_slug);
  s public.booking_settings;
  v_phone text := public.normalize_phone(p_phone);
  v_duration int;
  v_constraint text;
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
  elsif s.allocation_mode = 'staff' and exists (select 1 from public.services where tenant_id = t.id and is_active) then
    raise exception 'Escolha um serviço.' using errcode = 'P0001', hint = 'INVALID_SERVICE';
  end if;
  if p_area_id is not null and not exists (select 1 from public.areas where id = p_area_id and tenant_id = t.id and is_active) then
    raise exception 'Ambiente indisponível.' using errcode = 'P0001', hint = 'INVALID_AREA';
  end if;
  if p_staff_id is not null and not exists (select 1 from public.staff where id = p_staff_id and tenant_id = t.id and is_active) then
    raise exception 'Profissional indisponível.' using errcode = 'P0001', hint = 'INVALID_STAFF';
  end if;
  v_duration := coalesce(v_duration, s.default_duration_min);

  perform public._lock_tenant_agenda(t.id);

  if (select count(*) from public.reservations
      where tenant_id = t.id and customer_phone_normalized = v_phone
        and public.is_active_status(status) and starts_at > now()) >= s.max_active_per_phone then
    raise exception 'Você já possui o máximo de reservas ativas neste estabelecimento.' using errcode = 'P0001', hint = 'TOO_MANY_ACTIVE';
  end if;

  if not exists (
    select 1 from public._compute_slots(t.id, (p_starts_at at time zone t.timezone)::date, p_party_size, v_duration, null,
                                        p_area_id, p_service_id, p_staff_id) c
    where c.slot_start = p_starts_at
  ) then
    raise exception 'Este horário acabou de ficar indisponível. Escolha outro horário.' using errcode = 'P0001', hint = 'SLOT_UNAVAILABLE';
  end if;

  perform set_config('app.actor_type', 'customer', true);
  begin
    insert into public.reservations (tenant_id, customer_name, customer_phone, customer_email, starts_at, ends_at,
                                     party_size, service_id, area_id, staff_id, staff_requested, status, source, notes)
    values (t.id, btrim(p_name), p_phone, nullif(btrim(p_email), ''), p_starts_at,
            p_starts_at + make_interval(mins => v_duration), p_party_size, p_service_id, p_area_id,
            p_staff_id, p_staff_id is not null,
            case when s.require_confirmation then 'pending' else 'confirmed' end::public.reservation_status,
            'online', nullif(left(btrim(p_notes), 1000), ''))
    returning * into r;
  exception when exclusion_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint = 'reservations_no_duplicate_customer' then
      raise exception 'Você já tem uma reserva que coincide com este horário.' using errcode = 'P0001', hint = 'DUPLICATE';
    end if;
    raise exception 'Este horário acabou de ficar indisponível. Escolha outro horário.' using errcode = 'P0001', hint = 'SLOT_UNAVAILABLE';
  end;
  perform set_config('app.actor_type', '', true);

  return jsonb_build_object('code', r.code, 'status', r.status, 'starts_at', r.starts_at, 'ends_at', r.ends_at,
                            'party_size', r.party_size, 'tenant_name', t.name, 'tenant_slug', t.slug, 'timezone', t.timezone,
                            'area_name', (select name from public.areas where id = r.area_id),
                            'staff_name', (select name from public.staff where id = r.staff_id));
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
    'staff_name', (select name from public.staff where id = r.staff_id),
    'staff_requested', r.staff_requested,
    'tenant', jsonb_build_object('name', t.name, 'slug', t.slug, 'segment', t.segment, 'timezone', t.timezone,
                                 'logo_url', t.logo_url, 'brand_color', t.brand_color, 'phone', t.phone,
                                 'address_line', t.address_line, 'address_number', t.address_number, 'city', t.city),
    'can_cancel', v_can_change and s.allow_online_cancel,
    'can_reschedule', v_can_change and s.allow_online_reschedule,
    'cancellation_min_notice_min', s.cancellation_min_notice_min,
    'cancellation_policy', s.cancellation_policy);
end $$;

-- Reschedule keeps the chosen professional (or "any" if the customer did not choose)
create or replace function public.get_reschedule_slots(p_code text, p_phone text, p_date date)
returns table (slot_start timestamptz, slot_end timestamptz)
language plpgsql stable security definer set search_path = public as $$
declare r public.reservations := public._public_reservation(p_code, p_phone);
begin
  return query
  select c.slot_start, c.slot_end
  from public._compute_slots(r.tenant_id, p_date, r.party_size,
                             (extract(epoch from (r.ends_at - r.starts_at)) / 60)::int, r.id, null,
                             r.service_id, case when r.staff_requested then r.staff_id end) c;
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
    select 1 from public._compute_slots(r.tenant_id, (p_new_start at time zone t.timezone)::date, r.party_size, v_duration, r.id, null,
                                        r.service_id, case when r.staff_requested then r.staff_id end) c
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

-- ---------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
      and p.proname in ('_staff_working', '_staff_busy', '_find_staff', '_service_buffer', '_compute_slots',
                        'reservations_staff_history', 'get_tenant_slots', 'get_free_staff', 'save_staff_profile',
                        'staff_service_metrics', 'get_public_page', 'get_available_slots', 'get_available_days',
                        'create_public_reservation', 'get_public_reservation', 'get_reschedule_slots', 'reschedule_public_reservation')
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
  end loop;
end $$;

grant execute on function
  public.get_public_page(text),
  public.get_available_slots(text, date, integer, uuid, uuid, uuid),
  public.get_available_days(text, date, date, integer, uuid, uuid, uuid),
  public.create_public_reservation(text, timestamptz, integer, text, text, text, text, uuid, uuid, uuid),
  public.get_public_reservation(text, text),
  public.get_reschedule_slots(text, text, date),
  public.reschedule_public_reservation(text, text, timestamptz)
to anon, authenticated;

grant execute on function
  public.get_tenant_slots(uuid, date, integer, integer, uuid, uuid, uuid, uuid),
  public.get_free_staff(uuid, timestamptz, timestamptz, uuid, uuid),
  public.save_staff_profile(uuid, jsonb, uuid[]),
  public.staff_service_metrics(uuid, date, date)
to authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.staff;
  end if;
end $$;
