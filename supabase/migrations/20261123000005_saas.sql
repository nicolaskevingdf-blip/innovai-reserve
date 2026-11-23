-- =====================================================================
-- INNOVAI RESERVE — 05 · Commercial SaaS
--  * plan limits & feature flags enforced in the database
--  * subscription lifecycle (trial → past_due → suspended)
--  * Innovai admin panel RPCs, support tickets
-- =====================================================================

-- ---------------------------------------------------------------------
-- Effective plan: plan defaults + per-tenant overrides set by Innovai
-- ---------------------------------------------------------------------
create or replace function public.tenant_features(p_tenant uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(p.features, '{}'::jsonb) || coalesce(t.feature_overrides -> 'features', '{}'::jsonb)
  from public.tenants t left join public.plans p on p.id = t.plan_id
  where t.id = p_tenant
$$;

create or replace function public.tenant_limits(p_tenant uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(p.limits, '{}'::jsonb) || coalesce(t.feature_overrides -> 'limits', '{}'::jsonb)
  from public.tenants t left join public.plans p on p.id = t.plan_id
  where t.id = p_tenant
$$;

create or replace function public.has_feature(p_tenant uuid, p_feature text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((public.tenant_features(p_tenant) ->> p_feature)::boolean, false)
$$;

-- null limit = unlimited
create or replace function public._limit(p_tenant uuid, p_key text) returns integer
language sql stable security definer set search_path = public as $$
  select nullif(public.tenant_limits(p_tenant) ->> p_key, '')::integer
$$;

create or replace function public._usage(p_tenant uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'members', (select count(*) from public.tenant_members where tenant_id = p_tenant and is_active)
             + (select count(*) from public.tenant_invitations where tenant_id = p_tenant and accepted_at is null),
    'reservations_month', (select count(*) from public.reservations r, public.tenants t
                           where t.id = p_tenant and r.tenant_id = p_tenant
                             and r.created_at >= date_trunc('month', now() at time zone t.timezone) at time zone t.timezone),
    'resources', (select count(*) from public.dining_tables where tenant_id = p_tenant)
               + (select count(*) from public.staff where tenant_id = p_tenant))
$$;

create or replace function public.subscription_ok(p_tenant uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((
    select case s.status
             when 'active' then true
             when 'trialing' then coalesce(s.trial_ends_at, now()) > now()
             when 'past_due' then coalesce(s.current_period_end, now()) > now() - interval '7 days'
             else false end
    from public.subscriptions s where s.tenant_id = p_tenant), true)
$$;

create or replace function public.get_plan_usage(p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  if not public.is_member(p_tenant) then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;
  select jsonb_build_object(
    'plan', (select jsonb_build_object('id', p.id, 'code', p.code, 'name', p.name, 'price_cents', p.price_cents)
             from public.plans p join public.tenants t on t.plan_id = p.id where t.id = p_tenant),
    'subscription', (select to_jsonb(s) - 'provider_customer_id' - 'provider_subscription_id' from public.subscriptions s where s.tenant_id = p_tenant),
    'subscription_ok', public.subscription_ok(p_tenant),
    'features', public.tenant_features(p_tenant),
    'limits', public.tenant_limits(p_tenant),
    'usage', public._usage(p_tenant)
  ) into v;
  return v;
end $$;

-- ---------------------------------------------------------------------
-- Enforcement (bypassed by Innovai admins and by system jobs)
-- ---------------------------------------------------------------------
create or replace function public._plan_bypass() returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_platform_admin() or current_setting('app.plan_bypass', true) = 'on'
$$;

create or replace function public.plan_guard_members() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_limit int := public._limit(new.tenant_id, 'max_members');
begin
  if public._plan_bypass() or v_limit is null then return new; end if;
  if tg_op = 'UPDATE' then
    if old.is_active or not new.is_active then return new; end if; -- only re-activations count
  end if;
  -- accepting an existing invitation does not consume a new seat
  if exists (select 1 from public.tenant_invitations i join auth.users u on lower(u.email) = lower(i.email)
             where i.tenant_id = new.tenant_id and u.id = new.user_id and i.accepted_at is null) then
    return new;
  end if;
  if (public._usage(new.tenant_id) ->> 'members')::int >= v_limit then
    raise exception 'Limite de % usuário(s) do plano atingido. Faça upgrade para adicionar mais pessoas.', v_limit
      using errcode = 'P0001', hint = 'PLAN_LIMIT';
  end if;
  return new;
end $$;
create trigger plan_guard_members before insert or update of is_active on public.tenant_members
  for each row execute function public.plan_guard_members();

create or replace function public.plan_guard_invitations() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_limit int := public._limit(new.tenant_id, 'max_members');
begin
  if public._plan_bypass() or v_limit is null then return new; end if;
  if (public._usage(new.tenant_id) ->> 'members')::int >= v_limit then
    raise exception 'Limite de % usuário(s) do plano atingido. Faça upgrade para adicionar mais pessoas.', v_limit
      using errcode = 'P0001', hint = 'PLAN_LIMIT';
  end if;
  return new;
end $$;
create trigger plan_guard_invitations before insert on public.tenant_invitations
  for each row execute function public.plan_guard_invitations();

create or replace function public.plan_guard_resources() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_limit int := public._limit(new.tenant_id, 'max_resources');
begin
  if public._plan_bypass() or v_limit is null then return new; end if;
  if (public._usage(new.tenant_id) ->> 'resources')::int >= v_limit then
    raise exception 'Limite de % mesas/profissionais do plano atingido. Faça upgrade para cadastrar mais.', v_limit
      using errcode = 'P0001', hint = 'PLAN_LIMIT';
  end if;
  return new;
end $$;
create trigger plan_guard_tables before insert on public.dining_tables for each row execute function public.plan_guard_resources();
create trigger plan_guard_staff before insert on public.staff for each row execute function public.plan_guard_resources();

create or replace function public.plan_guard_reservations() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_limit int := public._limit(new.tenant_id, 'max_reservations_month');
begin
  if public._plan_bypass() then return new; end if;
  perform public._lock_tenant_agenda(new.tenant_id); -- count under the same lock as the agenda
  if new.source = 'online' and not public.subscription_ok(new.tenant_id) then
    raise exception 'Este estabelecimento não está aceitando reservas online no momento.' using errcode = 'P0001', hint = 'BOOKING_DISABLED';
  end if;
  if v_limit is not null and (public._usage(new.tenant_id) ->> 'reservations_month')::int >= v_limit then
    raise exception 'Limite mensal de % reservas do plano atingido. Fale com a Innovai para ampliar.', v_limit
      using errcode = 'P0001', hint = 'PLAN_LIMIT';
  end if;
  return new;
end $$;
-- "aa_" prefix: runs before reservations_before_write (BEFORE triggers fire alphabetically)
create trigger aa_plan_guard_reservations before insert on public.reservations
  for each row execute function public.plan_guard_reservations();

create or replace function public.plan_guard_settings() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if public._plan_bypass() then return new; end if;
  if new.allocation_mode is distinct from old.allocation_mode
     and new.allocation_mode in ('tables', 'staff') and not public.has_feature(new.tenant_id, 'tables_map') then
    raise exception 'Agenda por mesa ou por profissional está disponível a partir do plano Pro.' using errcode = 'P0001', hint = 'FEATURE_LOCKED';
  end if;
  return new;
end $$;
create trigger plan_guard_booking_settings before update on public.booking_settings
  for each row execute function public.plan_guard_settings();

create or replace function public.plan_guard_notifications() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if public._plan_bypass() then return new; end if;
  if new.whatsapp_enabled and not old.whatsapp_enabled and not public.has_feature(new.tenant_id, 'whatsapp') then
    raise exception 'Automação por WhatsApp está disponível a partir do plano Pro.' using errcode = 'P0001', hint = 'FEATURE_LOCKED';
  end if;
  return new;
end $$;
create trigger plan_guard_notification_settings before update on public.notification_settings
  for each row execute function public.plan_guard_notifications();

-- tenants.plan_id mirrors the subscription (changed by Innovai or the billing webhook)
create or replace function public.sync_tenant_plan() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_prev text := coalesce(current_setting('app.plan_bypass', true), '');
begin
  perform set_config('app.plan_bypass', 'on', true);
  update public.tenants set plan_id = new.plan_id where id = new.tenant_id and plan_id is distinct from new.plan_id;
  perform set_config('app.plan_bypass', v_prev, true);
  return null;
end $$;
create trigger subscriptions_sync_plan after insert or update of plan_id on public.subscriptions
  for each row execute function public.sync_tenant_plan();

-- ---------------------------------------------------------------------
-- Subscription lifecycle job (pg_cron, daily) — see README
-- ---------------------------------------------------------------------
create or replace function public.refresh_subscription_states() returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_expired int; v_suspended int;
begin
  perform set_config('app.plan_bypass', 'on', true);
  update public.subscriptions set status = 'past_due', current_period_end = coalesce(trial_ends_at, now())
   where status = 'trialing' and trial_ends_at < now();
  get diagnostics v_expired = row_count;
  with s as (
    update public.subscriptions set status = 'suspended'
     where status = 'past_due' and coalesce(current_period_end, now()) < now() - interval '7 days'
    returning tenant_id)
  update public.tenants t set status = 'suspended' from s where t.id = s.tenant_id and t.status = 'active';
  get diagnostics v_suspended = row_count;
  insert into public.audit_logs (entity, action, new_data)
  values ('subscriptions', 'lifecycle_job', jsonb_build_object('trials_expired', v_expired, 'suspended', v_suspended));
  return jsonb_build_object('trials_expired', v_expired, 'suspended', v_suspended);
end $$;

-- ---------------------------------------------------------------------
-- Support
-- ---------------------------------------------------------------------
-- membership without the admin shortcut (an admin who is also a member writes as customer)
create or replace function public.is_member_strict(p_tenant uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.tenant_role(p_tenant) is not null
$$;

-- only Innovai admins post as staff
create or replace function public.support_message_before() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.is_staff := public.is_platform_admin() and not public.is_member_strict((select tenant_id from public.support_tickets where id = new.ticket_id));
  return new;
end $$;
create trigger support_message_before before insert on public.support_messages
  for each row execute function public.support_message_before();

create or replace function public.support_message_after() returns trigger
language plpgsql security definer set search_path = public as $$
declare t public.support_tickets;
begin
  select * into t from public.support_tickets where id = new.ticket_id;
  update public.support_tickets
     set status = case when new.is_staff then 'answered' else 'open' end, updated_at = now()
   where id = new.ticket_id and status <> 'closed';
  if new.is_staff then
    insert into public.notifications (tenant_id, channel, template, audience, title, body, status, sent_at)
    values (t.tenant_id, 'in_app', 'support_reply', 'staff', 'Resposta do suporte Innovai', left(t.subject, 120), 'sent', now());
  end if;
  return null;
end $$;
create trigger support_message_after after insert on public.support_messages
  for each row execute function public.support_message_after();

-- ---------------------------------------------------------------------
-- Innovai admin RPCs (every action is audited)
-- ---------------------------------------------------------------------
create or replace function public._require_admin() returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then
    raise exception 'Acesso restrito à equipe Innovai.' using errcode = '42501';
  end if;
end $$;

create or replace function public.admin_overview() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  perform public._require_admin();
  select jsonb_build_object(
    'tenants', (select count(*) from public.tenants),
    'tenants_active', (select count(*) from public.tenants where status = 'active'),
    'tenants_suspended', (select count(*) from public.tenants where status <> 'active'),
    'new_tenants_30d', (select count(*) from public.tenants where created_at > now() - interval '30 days'),
    'mrr_cents', (select coalesce(sum(p.price_cents), 0) from public.subscriptions s join public.plans p on p.id = s.plan_id where s.status = 'active'),
    'by_status', (select coalesce(jsonb_object_agg(status, c), '{}') from (select status, count(*) c from public.subscriptions group by status) x),
    'by_plan', (select coalesce(jsonb_agg(jsonb_build_object('plan', p.name, 'count', (select count(*) from public.tenants t where t.plan_id = p.id)) order by p.sort_order), '[]') from public.plans p),
    'by_segment', (select coalesce(jsonb_object_agg(segment, c), '{}') from (select segment, count(*) c from public.tenants group by segment) x),
    'trials_ending_7d', (select count(*) from public.subscriptions where status = 'trialing' and trial_ends_at between now() and now() + interval '7 days'),
    'reservations_30d', (select count(*) from public.reservations where created_at > now() - interval '30 days'),
    'online_share_30d', (select case when count(*) = 0 then null else round(100.0 * count(*) filter (where source = 'online') / count(*), 1) end
                         from public.reservations where created_at > now() - interval '30 days'),
    'open_tickets', (select count(*) from public.support_tickets where status in ('open', 'waiting')),
    'signups_by_month', (select coalesce(jsonb_agg(jsonb_build_object('month', m, 'count', c) order by m), '[]') from (
        select to_char(date_trunc('month', created_at), 'YYYY-MM') m, count(*) c from public.tenants
        where created_at > now() - interval '12 months' group by 1) x)
  ) into v;
  return v;
end $$;

create or replace function public.admin_list_tenants(p_search text default null, p_status text default null)
returns table (
  id uuid, name text, slug text, segment public.segment_type, status public.tenant_status, city text, created_at timestamptz,
  plan_code text, plan_name text, subscription_status public.subscription_status, trial_ends_at timestamptz, current_period_end timestamptz,
  owner_email text, members bigint, reservations_30d bigint, last_reservation_at timestamptz, open_tickets bigint,
  feature_overrides jsonb, custom_domain text, internal_notes text
)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public._require_admin();
  return query
  select t.id, t.name, t.slug, t.segment, t.status, t.city, t.created_at,
         p.code, p.name, s.status, s.trial_ends_at, s.current_period_end,
         (select u.email::text from public.tenant_members m join auth.users u on u.id = m.user_id
          where m.tenant_id = t.id and m.role = 'owner' order by m.created_at limit 1),
         (select count(*) from public.tenant_members m where m.tenant_id = t.id and m.is_active),
         (select count(*) from public.reservations r where r.tenant_id = t.id and r.created_at > now() - interval '30 days'),
         (select max(r.created_at) from public.reservations r where r.tenant_id = t.id),
         (select count(*) from public.support_tickets k where k.tenant_id = t.id and k.status in ('open', 'waiting')),
         t.feature_overrides, t.custom_domain,
         (select n.notes from public.tenant_admin_notes n where n.tenant_id = t.id)
  from public.tenants t
  left join public.plans p on p.id = t.plan_id
  left join public.subscriptions s on s.tenant_id = t.id
  where (p_search is null or t.name ilike '%' || p_search || '%' or t.slug ilike '%' || p_search || '%')
    and (p_status is null or t.status::text = p_status or s.status::text = p_status)
  order by t.created_at desc;
end $$;

create or replace function public.admin_update_tenant(
  p_tenant uuid, p_status public.tenant_status default null, p_plan_code text default null,
  p_subscription_status public.subscription_status default null, p_trial_ends_at timestamptz default null,
  p_period_end timestamptz default null, p_feature_overrides jsonb default null, p_custom_domain text default null,
  p_internal_notes text default null
) returns void
language plpgsql security definer set search_path = public as $$
declare v_plan uuid;
begin
  perform public._require_admin();
  if p_plan_code is not null then
    select id into v_plan from public.plans where code = p_plan_code;
    if v_plan is null then raise exception 'Plano inexistente.' using errcode = 'P0001'; end if;
  end if;
  update public.tenants set
    status = coalesce(p_status, status),
    feature_overrides = coalesce(p_feature_overrides, feature_overrides),
    custom_domain = case when p_custom_domain is null then custom_domain else nullif(lower(btrim(p_custom_domain)), '') end
  where id = p_tenant;
  if p_internal_notes is not null then
    insert into public.tenant_admin_notes (tenant_id, notes) values (p_tenant, p_internal_notes)
    on conflict (tenant_id) do update set notes = excluded.notes, updated_at = now();
  end if;
  insert into public.subscriptions (tenant_id, plan_id, status)
  values (p_tenant, coalesce(v_plan, (select plan_id from public.tenants where id = p_tenant), (select id from public.plans where code = 'starter')), coalesce(p_subscription_status, 'active'))
  on conflict (tenant_id) do nothing;
  update public.subscriptions set
    plan_id = coalesce(v_plan, plan_id),
    status = coalesce(p_subscription_status, status),
    trial_ends_at = coalesce(p_trial_ends_at, trial_ends_at),
    current_period_start = case when p_subscription_status = 'active' and status <> 'active' then now() else current_period_start end,
    current_period_end = coalesce(p_period_end, current_period_end)
  where tenant_id = p_tenant;
  -- reactivating a subscription re-opens the establishment
  if p_subscription_status in ('active', 'trialing') and p_status is null then
    update public.tenants set status = 'active' where id = p_tenant and status = 'suspended';
  end if;
  insert into public.audit_logs (tenant_id, actor_id, entity, entity_id, action, new_data)
  values (p_tenant, auth.uid(), 'admin', p_tenant::text, 'admin_update_tenant',
          jsonb_strip_nulls(jsonb_build_object('status', p_status, 'plan', p_plan_code, 'subscription_status', p_subscription_status,
                                               'trial_ends_at', p_trial_ends_at, 'period_end', p_period_end,
                                               'feature_overrides', p_feature_overrides, 'custom_domain', p_custom_domain)));
end $$;

-- Innovai sells and sets up an establishment: the owner joins on first login
create or replace function public.admin_create_tenant(
  p_name text, p_slug text, p_segment public.segment_type, p_owner_email text,
  p_plan_code text default 'pro', p_trial_days integer default 14, p_timezone text default 'America/Sao_Paulo'
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  t public.tenants;
  v_plan uuid;
  v_user uuid;
  d int;
begin
  perform public._require_admin();
  if not public.slug_available(p_slug) then
    raise exception 'Este link já está em uso ou é inválido.' using errcode = 'P0001', hint = 'SLUG_TAKEN';
  end if;
  if p_owner_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'E-mail do proprietário inválido.' using errcode = 'P0001';
  end if;
  select id into v_plan from public.plans where code = p_plan_code;
  if v_plan is null then raise exception 'Plano inexistente.' using errcode = 'P0001'; end if;

  insert into public.tenants (name, slug, segment, timezone, plan_id)
  values (btrim(p_name), lower(p_slug), p_segment, p_timezone, v_plan) returning * into t;
  insert into public.subscriptions (tenant_id, plan_id, status, trial_ends_at, current_period_start, current_period_end)
  values (t.id, v_plan, case when p_trial_days > 0 then 'trialing' else 'active' end::public.subscription_status,
          case when p_trial_days > 0 then now() + make_interval(days => p_trial_days) end, now(),
          now() + make_interval(days => greatest(p_trial_days, 30)));
  insert into public.notification_settings (tenant_id) values (t.id);
  if p_segment = 'restaurant' then
    insert into public.booking_settings (tenant_id, slot_interval_min, default_duration_min, max_party_size, max_reservations_per_slot, max_guests_per_slot)
    values (t.id, 30, 90, 12, 10, 40);
    for d in 2..6 loop
      insert into public.business_hours (tenant_id, weekday, opens_at, closes_at, label) values
        (t.id, d, '12:00', '15:00', 'Almoço'), (t.id, d, '19:00', '23:00', 'Jantar');
    end loop;
  else
    insert into public.booking_settings (tenant_id, slot_interval_min, default_duration_min, min_advance_min, max_advance_days, max_party_size, max_reservations_per_slot)
    values (t.id, 30, case when p_segment = 'barbershop' then 30 else 60 end, 30, 30, 1, 1);
    for d in 1..6 loop
      insert into public.business_hours (tenant_id, weekday, opens_at, closes_at) values (t.id, d, '09:00', '19:00');
    end loop;
  end if;

  select id into v_user from auth.users where lower(email) = lower(btrim(p_owner_email));
  perform set_config('app.plan_bypass', 'on', true);
  if v_user is not null then
    insert into public.tenant_members (tenant_id, user_id, role) values (t.id, v_user, 'owner');
  else
    insert into public.tenant_invitations (tenant_id, email, role, invited_by) values (t.id, lower(btrim(p_owner_email)), 'owner', auth.uid());
  end if;
  insert into public.audit_logs (tenant_id, actor_id, entity, entity_id, action, new_data)
  values (t.id, auth.uid(), 'admin', t.id::text, 'admin_create_tenant', jsonb_build_object('owner_email', p_owner_email, 'plan', p_plan_code));
  return t.id;
end $$;

create or replace function public.admin_list_tickets(p_status text default null)
returns table (id uuid, tenant_id uuid, tenant_name text, subject text, category text, status text, priority text,
               created_at timestamptz, updated_at timestamptz, messages bigint, last_message text)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public._require_admin();
  return query
  select k.id, k.tenant_id, t.name, k.subject, k.category, k.status, k.priority, k.created_at, k.updated_at,
         (select count(*) from public.support_messages m where m.ticket_id = k.id),
         (select left(m.body, 200) from public.support_messages m where m.ticket_id = k.id order by m.created_at desc limit 1)
  from public.support_tickets k join public.tenants t on t.id = k.tenant_id
  where p_status is null or k.status = p_status
  order by case k.status when 'open' then 0 when 'waiting' then 1 when 'answered' then 2 else 3 end, k.updated_at desc;
end $$;
