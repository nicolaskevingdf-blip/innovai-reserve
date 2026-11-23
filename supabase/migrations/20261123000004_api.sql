-- =====================================================================
-- INNOVAI RESERVE — 04 · API (RPCs called by the app)
-- Every staff RPC checks membership; public RPCs expose only public data.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Onboarding & team
-- ---------------------------------------------------------------------
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

  -- every new establishment starts with a 14-day trial of the Pro plan
  select id into v_plan from public.plans where code = 'pro';

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

-- ---------------------------------------------------------------------
-- Staff tools (panel)
-- ---------------------------------------------------------------------
create or replace function public.get_tenant_slots(
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

-- Atomic replacement of the weekly schedule
create or replace function public.save_business_hours(p_tenant uuid, p_hours jsonb) returns integer
language plpgsql security invoker set search_path = public as $$
declare v_count int;
begin
  if not public.can_manage(p_tenant) then
    raise exception 'Somente proprietário ou gerente pode alterar horários.' using errcode = '42501';
  end if;
  delete from public.business_hours where tenant_id = p_tenant;
  insert into public.business_hours (tenant_id, weekday, opens_at, closes_at, label)
  select p_tenant, (h ->> 'weekday')::smallint, (h ->> 'opens_at')::time, (h ->> 'closes_at')::time, nullif(h ->> 'label', '')
  from jsonb_array_elements(coalesce(p_hours, '[]'::jsonb)) h;
  get diagnostics v_count = row_count;
  return v_count;
exception
  when exclusion_violation then
    raise exception 'Há turnos sobrepostos no mesmo dia.' using errcode = 'P0001', hint = 'HOURS_OVERLAP';
  when check_violation then
    raise exception 'O horário de fechamento deve ser depois da abertura (turnos após meia-noite ainda não são suportados).'
      using errcode = 'P0001', hint = 'HOURS_INVALID';
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
-- Public RPCs (anon): narrow, validated, no table access
-- ---------------------------------------------------------------------
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

create or replace function public.get_available_slots(
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

-- Days (within a range) that still have at least one free slot — for the calendar
create or replace function public.get_available_days(
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

create or replace function public.create_public_reservation(
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
-- Analytics (dashboard, CRM, floor, professionals)
-- ---------------------------------------------------------------------
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
