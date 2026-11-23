-- =====================================================================
-- INNOVAI RESERVE — Phase 2: restaurant module
--  * allocation mode "tables": every reservation occupies 1..n tables
--  * table combinations (joined tables for larger groups)
--  * DB-level guarantee: a table can never hold two overlapping reservations
--  * best-fit automatic allocation, preferred area (ambiente)
--  * waitlist (public + staff), floor occupancy metrics
-- =====================================================================

alter table public.booking_settings
  add column allocation_mode text not null default 'capacity' check (allocation_mode in ('capacity', 'tables'));

alter table public.reservations
  add column table_ids uuid[] not null default '{}';

-- table occupancy is now enforced on reservation_tables (supports joined tables)
alter table public.reservations drop constraint reservations_no_table_overlap;

create index dining_tables_tenant_idx on public.dining_tables (tenant_id, is_active);
create index areas_tenant_idx on public.areas (tenant_id, sort_order);

-- ---------------------------------------------------------------------
-- Joined tables
-- ---------------------------------------------------------------------
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
-- Table occupancy (one row per reservation × table). Period includes the
-- buffer after the reservation so cleaning time is respected.
-- ---------------------------------------------------------------------
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

-- Waitlist additions
alter table public.waitlist_entries
  add column customer_phone_normalized text,
  add column customer_email text,
  add column area_id uuid,
  add column source public.reservation_source not null default 'manual',
  add column notified_at timestamptz,
  add constraint waitlist_area_fk foreign key (tenant_id, area_id) references public.areas (tenant_id, id) on delete set null (area_id);
create index waitlist_tenant_date_idx on public.waitlist_entries (tenant_id, desired_date, status);

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

-- RLS for the new tables
alter table public.table_combinations enable row level security;
alter table public.reservation_tables enable row level security;
create policy table_combinations_read on public.table_combinations for select to authenticated using (public.is_member(tenant_id));
create policy table_combinations_write on public.table_combinations for all to authenticated
  using (public.can_manage(tenant_id)) with check (public.can_manage(tenant_id));
create policy reservation_tables_read on public.reservation_tables for select to authenticated using (public.is_member(tenant_id));
revoke all on public.table_combinations, public.reservation_tables from anon;
grant select, insert, update, delete on public.table_combinations to authenticated;
grant select on public.reservation_tables to authenticated;

-- A table with upcoming reservations cannot be deleted (deactivate it instead)
create or replace function public.dining_tables_guard_delete() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.tenants where id = old.tenant_id) and exists (
    select 1 from public.reservation_tables rt
    where rt.table_id = old.id and rt.active and upper(rt.period) > now()
  ) then
    raise exception 'Esta mesa tem reservas futuras. Desative-a ou mova as reservas antes de excluir.' using errcode = 'P0001', hint = 'TABLE_IN_USE';
  end if;
  return old;
end $$;
create trigger dining_tables_guard_delete before delete on public.dining_tables
  for each row execute function public.dining_tables_guard_delete();

-- ---------------------------------------------------------------------
-- Allocation helpers
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

-- Load of the agenda (all non-professional reservations)
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
-- Availability, now table-aware (p_area = preferred ambiente)
-- ---------------------------------------------------------------------
drop function public._compute_slots(uuid, date, integer, integer, uuid);
create function public._compute_slots(
  p_tenant uuid, p_date date, p_party integer, p_duration integer, p_ignore uuid default null, p_area uuid default null
) returns table (slot_start timestamptz, slot_end timestamptz, remaining_reservations integer, remaining_guests integer)
language plpgsql stable security definer set search_path = public as $$
declare
  s public.booking_settings;
  v_tz text;
  v_today date;
  v_tables boolean;
begin
  select * into s from public.booking_settings where tenant_id = p_tenant;
  select timezone into v_tz from public.tenants where id = p_tenant;
  if not found or s.tenant_id is null or p_duration is null or p_duration < 5 then
    return;
  end if;
  v_tables := s.allocation_mode = 'tables';

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
         case when v_tables or s.max_reservations_per_slot is null then null else s.max_reservations_per_slot - l.reservations end,
         case when s.max_guests_per_slot is null then null else s.max_guests_per_slot - l.guests end
  from windows w
  cross join lateral public._window_load(p_tenant, w.st, w.en, p_ignore) l
  where (v_tables or s.max_reservations_per_slot is null or l.reservations < s.max_reservations_per_slot)
    and (s.max_guests_per_slot is null or l.guests + p_party <= s.max_guests_per_slot)
    and (not v_tables or public._find_tables(p_tenant, w.st, w.en, p_party, p_area, p_ignore) is not null)
  order by w.st;
end $$;

-- ---------------------------------------------------------------------
-- BEFORE trigger (replaces Phase 1 version): adds table allocation
-- ---------------------------------------------------------------------
-- SECURITY DEFINER: internal helpers stay non-callable from the API. The row
-- itself is still subject to the caller's RLS WITH CHECK after this trigger.
create or replace function public.reservations_before_write() returns trigger
language plpgsql security definer set search_path = public as $$
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
  new.table_ids := coalesce(array(select u.x from unnest(new.table_ids) with ordinality u(x, o) where u.x is not null group by u.x order by min(u.o)), '{}');
  if cardinality(new.table_ids) = 0 and new.table_id is not null and (tg_op = 'INSERT' or new.table_id is distinct from old.table_id) then
    new.table_ids := array[new.table_id];
  end if;

  select * into s from public.booking_settings where tenant_id = new.tenant_id;

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
    or new.table_ids is distinct from old.table_ids
    or new.area_id is distinct from old.area_id
  );

  if v_needs_check then
    perform public._lock_tenant_agenda(new.tenant_id);

    -- ----- table allocation -----
    if cardinality(new.table_ids) > 0 then
      if exists (select 1 from unnest(new.table_ids) x(id)
                 where not exists (select 1 from public.dining_tables t where t.id = x.id and t.tenant_id = new.tenant_id)) then
        raise exception 'Mesa inválida para este estabelecimento.' using errcode = '42501';
      end if;
      if not public._tables_free(new.tenant_id, new.table_ids, new.starts_at, new.ends_at, new.id) then
        if tg_op = 'UPDATE' and new.table_ids = old.table_ids and s.allocation_mode = 'tables' then
          new.table_ids := '{}'; -- moved in time: try to reallocate below
        else
          raise exception 'A mesa escolhida já está ocupada, bloqueada ou inativa neste horário.' using errcode = 'P0001', hint = 'TABLE_TAKEN';
        end if;
      elsif tg_op = 'UPDATE' and new.table_ids = old.table_ids and s.allocation_mode = 'tables'
            and new.party_size > old.party_size
            and (select coalesce(sum(max_capacity), 0) from public.dining_tables where id = any (new.table_ids)) < new.party_size then
        new.table_ids := '{}'; -- group grew beyond the tables: reallocate
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

-- AFTER trigger: mirror reservation → reservation_tables (exclusion constraint lives there)
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

-- Track table changes in history too
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

-- Cancellation frees a slot → tell the team if someone is waiting that day
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

-- ---------------------------------------------------------------------
-- Staff RPCs
-- ---------------------------------------------------------------------
create or replace function public.get_free_tables(
  p_tenant uuid, p_start timestamptz, p_end timestamptz, p_ignore uuid default null
) returns table (table_id uuid, is_free boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_member(p_tenant) then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;
  return query
  select t.id, public._tables_free(p_tenant, array[t.id], p_start, p_end, p_ignore)
  from public.dining_tables t where t.tenant_id = p_tenant order by t.name;
end $$;

-- Re-declare staff slots with optional area
drop function public.get_tenant_slots(uuid, date, integer, integer, uuid);
create function public.get_tenant_slots(
  p_tenant uuid, p_date date, p_party integer default 1, p_duration integer default null, p_ignore uuid default null, p_area uuid default null
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
    p_ignore, p_area);
end $$;

-- Atomic save of floor layout positions
create or replace function public.save_floor_layout(p_tenant uuid, p_tables jsonb) returns integer
language plpgsql security invoker set search_path = public as $$
declare v int;
begin
  if not public.can_manage(p_tenant) then
    raise exception 'Somente proprietário ou gerente pode editar o salão.' using errcode = '42501';
  end if;
  update public.dining_tables t
     set pos_x = (j ->> 'pos_x')::numeric, pos_y = (j ->> 'pos_y')::numeric,
         width = coalesce((j ->> 'width')::numeric, t.width), height = coalesce((j ->> 'height')::numeric, t.height),
         rotation = coalesce((j ->> 'rotation')::numeric, t.rotation)
    from jsonb_array_elements(p_tables) j
   where t.tenant_id = p_tenant and t.id = (j ->> 'id')::uuid;
  get diagnostics v = row_count;
  return v;
end $$;

create or replace function public.notify_waitlist_entry(p_entry uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  w public.waitlist_entries;
  t public.tenants;
  ns public.notification_settings;
  v_body text;
begin
  select * into w from public.waitlist_entries where id = p_entry;
  if w.id is null or not public.can_write(w.tenant_id) then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;
  select * into t from public.tenants where id = w.tenant_id;
  select * into ns from public.notification_settings where tenant_id = w.tenant_id;
  v_body := format('Olá, %s! Abriu uma vaga no %s para %s em %s. Responda para garantir seu lugar.',
                   split_part(w.customer_name, ' ', 1), t.name, w.party_size || ' pessoa(s)', to_char(w.desired_date, 'DD/MM'));
  update public.waitlist_entries set status = 'notified', notified_at = now() where id = w.id;
  if ns.whatsapp_enabled then
    insert into public.notifications (tenant_id, channel, template, audience, recipient, title, body, payload)
    values (w.tenant_id, 'whatsapp', 'waitlist_available', 'customer', w.customer_phone_normalized, 'Abriu uma vaga', v_body,
            jsonb_build_object('waitlist_id', w.id));
  end if;
  if ns.email_enabled and w.customer_email is not null then
    insert into public.notifications (tenant_id, channel, template, audience, recipient, title, body, payload)
    values (w.tenant_id, 'email', 'waitlist_available', 'customer', w.customer_email, 'Abriu uma vaga', v_body,
            jsonb_build_object('waitlist_id', w.id));
  end if;
  return jsonb_build_object('message', v_body, 'phone', w.customer_phone_normalized,
                            'queued', ns.whatsapp_enabled or (ns.email_enabled and w.customer_email is not null));
end $$;

-- ---------------------------------------------------------------------
-- Public RPCs (re-declared with preferred area)
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
      select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'description', description,
                                          'price_cents', price_cents, 'duration_min', duration_min) order by sort_order, name)
      from public.services where tenant_id = t.id and is_active), '[]'::jsonb),
    'areas', case when s.allocation_mode = 'tables' then coalesce((
      select jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'description', a.description) order by a.sort_order, a.name)
      from public.areas a
      where a.tenant_id = t.id and a.is_active
        and exists (select 1 from public.dining_tables dt where dt.area_id = a.id and dt.is_active)), '[]'::jsonb)
      else '[]'::jsonb end
  );
end $$;

drop function public.get_available_days(text, date, date, integer, uuid);
drop function public.get_available_slots(text, date, integer, uuid);

create function public.get_available_slots(
  p_slug text, p_date date, p_party_size integer default 1, p_service_id uuid default null, p_area_id uuid default null
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
  if p_area_id is not null and not exists (select 1 from public.areas where id = p_area_id and tenant_id = t.id and is_active) then
    return;
  end if;
  return query
  select c.slot_start, c.slot_end
  from public._compute_slots(t.id, p_date, p_party_size, coalesce(v_duration, s.default_duration_min), null, p_area_id) c;
end $$;

create function public.get_available_days(
  p_slug text, p_from date, p_to date, p_party_size integer default 1, p_service_id uuid default null, p_area_id uuid default null
) returns table (day date)
language plpgsql stable security definer set search_path = public as $$
declare d date;
begin
  if p_to - p_from > 62 then p_to := p_from + 62; end if;
  d := p_from;
  while d <= p_to loop
    if exists (select 1 from public.get_available_slots(p_slug, d, p_party_size, p_service_id, p_area_id)) then
      day := d;
      return next;
    end if;
    d := d + 1;
  end loop;
end $$;

drop function public.create_public_reservation(text, timestamptz, integer, text, text, text, text, uuid);
create function public.create_public_reservation(
  p_slug text,
  p_starts_at timestamptz,
  p_party_size integer,
  p_name text,
  p_phone text,
  p_email text default null,
  p_notes text default null,
  p_service_id uuid default null,
  p_area_id uuid default null
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
  end if;
  if p_area_id is not null and not exists (select 1 from public.areas where id = p_area_id and tenant_id = t.id and is_active) then
    raise exception 'Ambiente indisponível.' using errcode = 'P0001', hint = 'INVALID_AREA';
  end if;
  v_duration := coalesce(v_duration, s.default_duration_min);

  perform public._lock_tenant_agenda(t.id);

  if (select count(*) from public.reservations
      where tenant_id = t.id and customer_phone_normalized = v_phone
        and public.is_active_status(status) and starts_at > now()) >= s.max_active_per_phone then
    raise exception 'Você já possui o máximo de reservas ativas neste estabelecimento.' using errcode = 'P0001', hint = 'TOO_MANY_ACTIVE';
  end if;

  if not exists (
    select 1 from public._compute_slots(t.id, (p_starts_at at time zone t.timezone)::date, p_party_size, v_duration, null, p_area_id) c
    where c.slot_start = p_starts_at
  ) then
    raise exception 'Este horário acabou de ficar indisponível. Escolha outro horário.' using errcode = 'P0001', hint = 'SLOT_UNAVAILABLE';
  end if;

  perform set_config('app.actor_type', 'customer', true);
  begin
    insert into public.reservations (tenant_id, customer_name, customer_phone, customer_email, starts_at, ends_at,
                                     party_size, service_id, area_id, status, source, notes)
    values (t.id, btrim(p_name), p_phone, nullif(btrim(p_email), ''), p_starts_at,
            p_starts_at + make_interval(mins => v_duration), p_party_size, p_service_id, p_area_id,
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
                            'area_name', (select name from public.areas where id = r.area_id));
end $$;

-- Public reschedule keeps the area preference of the reservation
create or replace function public.get_reschedule_slots(p_code text, p_phone text, p_date date)
returns table (slot_start timestamptz, slot_end timestamptz)
language plpgsql stable security definer set search_path = public as $$
declare r public.reservations := public._public_reservation(p_code, p_phone);
begin
  return query
  select c.slot_start, c.slot_end
  from public._compute_slots(r.tenant_id, p_date, r.party_size,
                             (extract(epoch from (r.ends_at - r.starts_at)) / 60)::int, r.id, null) c;
end $$;

create or replace function public.join_waitlist(
  p_slug text, p_date date, p_time time, p_party_size integer, p_name text, p_phone text,
  p_email text default null, p_notes text default null, p_area_id uuid default null
) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  t public.tenants := public._public_tenant(p_slug);
  s public.booking_settings;
  v_phone text := public.normalize_phone(p_phone);
  w public.waitlist_entries;
  v_today date;
begin
  select * into s from public.booking_settings where tenant_id = t.id;
  v_today := (now() at time zone t.timezone)::date;
  if char_length(btrim(coalesce(p_name, ''))) < 2 then
    raise exception 'Informe seu nome.' using errcode = 'P0001', hint = 'INVALID_NAME';
  end if;
  if v_phone is null or char_length(v_phone) not between 10 and 13 then
    raise exception 'Informe um telefone válido com DDD.' using errcode = 'P0001', hint = 'INVALID_PHONE';
  end if;
  if p_date is null or p_date < v_today or p_date > v_today + s.max_advance_days then
    raise exception 'Data fora do período de reservas.' using errcode = 'P0001', hint = 'INVALID_DATE';
  end if;
  if p_party_size is null or p_party_size < 1 or p_party_size > greatest(s.max_party_size, 1) then
    raise exception 'Quantidade de pessoas inválida.' using errcode = 'P0001', hint = 'INVALID_PARTY';
  end if;
  if (select count(*) from public.waitlist_entries
      where tenant_id = t.id and customer_phone_normalized = v_phone and status = 'waiting' and desired_date >= v_today) >= 3 then
    raise exception 'Você já está na lista de espera deste estabelecimento.' using errcode = 'P0001', hint = 'ALREADY_WAITING';
  end if;
  if exists (select 1 from public.waitlist_entries
             where tenant_id = t.id and customer_phone_normalized = v_phone and desired_date = p_date and status = 'waiting') then
    raise exception 'Você já está na lista de espera para esta data.' using errcode = 'P0001', hint = 'ALREADY_WAITING';
  end if;

  insert into public.waitlist_entries (tenant_id, customer_name, customer_phone, customer_email, desired_date, desired_time,
                                       party_size, notes, area_id, source)
  values (t.id, btrim(p_name), p_phone, nullif(btrim(p_email), ''), p_date, p_time, p_party_size,
          nullif(left(btrim(p_notes), 500), ''),
          (select id from public.areas where id = p_area_id and tenant_id = t.id), 'online')
  returning * into w;

  insert into public.notifications (tenant_id, channel, template, audience, title, body, status, sent_at)
  values (t.id, 'in_app', 'staff_waitlist_new', 'staff', 'Novo pedido na lista de espera',
          format('%s · %s%s · %s pessoa(s)', w.customer_name, to_char(p_date, 'DD/MM'),
                 coalesce(' ' || to_char(p_time, 'HH24:MI'), ''), p_party_size), 'sent', now());

  return jsonb_build_object('id', w.id, 'position',
    (select count(*) from public.waitlist_entries where tenant_id = t.id and desired_date = p_date and status = 'waiting'
       and created_at <= w.created_at));
end $$;

-- ---------------------------------------------------------------------
-- Dashboard: floor occupancy in table mode (table-minutes booked / open)
-- ---------------------------------------------------------------------
create or replace function public.floor_occupancy(p_tenant uuid, p_from date, p_to date) returns numeric
language plpgsql stable security definer set search_path = public as $$
declare
  v_tz text;
  v_tables int;
  v_open numeric;
  v_booked numeric;
begin
  if not public.is_member(p_tenant) then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;
  select timezone into v_tz from public.tenants where id = p_tenant;
  select count(*) into v_tables from public.dining_tables where tenant_id = p_tenant and is_active;
  select coalesce(sum(extract(epoch from (bh.closes_at - bh.opens_at)) / 60), 0) into v_open
  from generate_series(p_from, p_to, interval '1 day') d
  join public.business_hours bh on bh.tenant_id = p_tenant and bh.weekday = extract(dow from d)::int;
  if v_tables = 0 or v_open = 0 then return null; end if;
  select coalesce(sum(extract(epoch from (r.ends_at - r.starts_at)) / 60 * cardinality(r.table_ids)), 0) into v_booked
  from public.reservations r
  where r.tenant_id = p_tenant
    and r.starts_at >= (p_from::timestamp at time zone v_tz) and r.starts_at < ((p_to + 1)::timestamp at time zone v_tz)
    and r.status in ('pending', 'confirmed', 'in_progress', 'completed');
  return round(least(100, 100 * v_booked / (v_open * v_tables)), 1);
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
      and p.proname in ('_lock_tenant_agenda', '_tables_free', '_find_tables', '_compute_slots', '_window_load', 'reservations_sync_tables',
                        'reservations_table_history', 'reservations_waitlist_hint', 'table_combinations_validate',
                        'dining_tables_guard_delete', 'waitlist_normalize', 'get_free_tables', 'get_tenant_slots',
                        'save_floor_layout', 'notify_waitlist_entry', 'get_available_slots', 'get_available_days',
                        'create_public_reservation', 'join_waitlist', 'floor_occupancy', 'get_public_page', 'get_reschedule_slots')
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
  end loop;
end $$;

grant execute on function
  public.get_public_page(text),
  public.get_available_slots(text, date, integer, uuid, uuid),
  public.get_available_days(text, date, date, integer, uuid, uuid),
  public.create_public_reservation(text, timestamptz, integer, text, text, text, text, uuid, uuid),
  public.get_reschedule_slots(text, text, date),
  public.join_waitlist(text, date, time, integer, text, text, text, text, uuid)
to anon, authenticated;

grant execute on function
  public.get_free_tables(uuid, timestamptz, timestamptz, uuid),
  public.get_tenant_slots(uuid, date, integer, integer, uuid, uuid),
  public.save_floor_layout(uuid, jsonb),
  public.notify_waitlist_entry(uuid),
  public.floor_occupancy(uuid, date, date),
  public.waitlist_normalize(), public.table_combinations_validate()
to authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.waitlist_entries;
    alter publication supabase_realtime add table public.dining_tables;
  end if;
end $$;
