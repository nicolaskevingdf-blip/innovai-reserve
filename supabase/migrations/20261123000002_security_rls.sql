-- =====================================================================
-- INNOVAI RESERVE — Authorization helpers + Row Level Security
-- Principle: the browser only ever talks to Postgres through RLS.
-- Anonymous visitors have NO table access; they use a narrow set of
-- SECURITY DEFINER RPCs (public booking) that validate everything.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Authorization helpers (SECURITY DEFINER so they can read membership
-- without recursive RLS evaluation). All pin search_path.
-- ---------------------------------------------------------------------
create or replace function public.is_platform_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.platform_admins where user_id = auth.uid())
$$;

create or replace function public.tenant_role(p_tenant uuid) returns public.member_role
language sql stable security definer set search_path = public as $$
  select m.role
  from public.tenant_members m
  where m.tenant_id = p_tenant and m.user_id = auth.uid() and m.is_active
$$;

create or replace function public.is_member(p_tenant uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.tenant_role(p_tenant) is not null or public.is_platform_admin()
$$;

create or replace function public.is_manager(p_tenant uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.tenant_role(p_tenant) in ('owner', 'manager') or public.is_platform_admin()
$$;

create or replace function public.is_owner(p_tenant uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.tenant_role(p_tenant) = 'owner' or public.is_platform_admin()
$$;

-- Writes are only allowed while the establishment is active (not suspended).
create or replace function public.can_write(p_tenant uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_platform_admin()
      or (public.tenant_role(p_tenant) is not null
          and exists (select 1 from public.tenants t where t.id = p_tenant and t.status = 'active'))
$$;

create or replace function public.can_manage(p_tenant uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.can_write(p_tenant) and public.is_manager(p_tenant)
$$;

create or replace function public.shares_tenant_with(p_user uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.tenant_members a
    join public.tenant_members b on a.tenant_id = b.tenant_id
    where a.user_id = auth.uid() and b.user_id = p_user and a.is_active
  )
$$;

-- ---------------------------------------------------------------------
-- Baseline grants: anon gets nothing on tables. RLS does the rest.
-- ---------------------------------------------------------------------
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
grant select on public.plans to anon;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;

-- Enable RLS everywhere
do $$
declare r record;
begin
  for r in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', r.tablename);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Policies
-- ---------------------------------------------------------------------
-- plans: public catalog; only platform admins write
create policy plans_read on public.plans for select to anon, authenticated using (is_active or public.is_platform_admin());
create policy plans_admin on public.plans for all to authenticated
  using (public.is_platform_admin()) with check (public.is_platform_admin());

-- platform_admins: you can see whether *you* are admin
create policy platform_admins_self on public.platform_admins for select to authenticated
  using (user_id = auth.uid() or public.is_platform_admin());

-- profiles
create policy profiles_read on public.profiles for select to authenticated
  using (id = auth.uid() or public.shares_tenant_with(id) or public.is_platform_admin());
create policy profiles_update on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- tenants (insert only via create_tenant RPC)
create policy tenants_read on public.tenants for select to authenticated
  using (public.is_member(id));
create policy tenants_update on public.tenants for update to authenticated
  using (public.can_manage(id)) with check (public.can_manage(id));
create policy tenants_admin_delete on public.tenants for delete to authenticated
  using (public.is_platform_admin());

-- subscriptions: tenants read, Innovai writes
create policy subscriptions_read on public.subscriptions for select to authenticated
  using (public.is_member(tenant_id));
create policy subscriptions_admin on public.subscriptions for all to authenticated
  using (public.is_platform_admin()) with check (public.is_platform_admin());

-- members
create policy members_read on public.tenant_members for select to authenticated
  using (public.is_member(tenant_id));
create policy members_insert on public.tenant_members for insert to authenticated
  with check (public.can_manage(tenant_id) and (role <> 'owner' or public.is_owner(tenant_id)));
create policy members_update on public.tenant_members for update to authenticated
  using (public.can_manage(tenant_id))
  with check (public.can_manage(tenant_id) and (role <> 'owner' or public.is_owner(tenant_id)));
create policy members_delete on public.tenant_members for delete to authenticated
  using (public.can_manage(tenant_id));

-- invitations
create policy invitations_manage on public.tenant_invitations for all to authenticated
  using (public.is_manager(tenant_id)) with check (public.can_manage(tenant_id));

-- configuration tables: members read, managers write
create policy booking_settings_read on public.booking_settings for select to authenticated using (public.is_member(tenant_id));
create policy booking_settings_write on public.booking_settings for update to authenticated
  using (public.can_manage(tenant_id)) with check (public.can_manage(tenant_id));

create policy notification_settings_read on public.notification_settings for select to authenticated using (public.is_member(tenant_id));
create policy notification_settings_write on public.notification_settings for update to authenticated
  using (public.can_manage(tenant_id)) with check (public.can_manage(tenant_id));

do $$
declare t text;
begin
  foreach t in array array['business_hours', 'areas', 'dining_tables', 'staff', 'staff_hours', 'services', 'service_staff'] loop
    execute format('create policy %1$s_read on public.%1$s for select to authenticated using (public.is_member(tenant_id))', t);
    execute format('create policy %1$s_insert on public.%1$s for insert to authenticated with check (public.can_manage(tenant_id))', t);
    execute format('create policy %1$s_update on public.%1$s for update to authenticated using (public.can_manage(tenant_id)) with check (public.can_manage(tenant_id))', t);
    execute format('create policy %1$s_delete on public.%1$s for delete to authenticated using (public.can_manage(tenant_id))', t);
  end loop;
end $$;

-- operational tables: every active member reads & writes, managers delete
do $$
declare t text;
begin
  foreach t in array array['customers', 'reservations', 'schedule_blocks', 'waitlist_entries'] loop
    execute format('create policy %1$s_read on public.%1$s for select to authenticated using (public.is_member(tenant_id))', t);
    execute format('create policy %1$s_insert on public.%1$s for insert to authenticated with check (public.can_write(tenant_id))', t);
    execute format('create policy %1$s_update on public.%1$s for update to authenticated using (public.can_write(tenant_id)) with check (public.can_write(tenant_id))', t);
    execute format('create policy %1$s_delete on public.%1$s for delete to authenticated using (public.can_manage(tenant_id))', t);
  end loop;
end $$;

-- history & logs: read-only for clients (written by triggers)
create policy reservation_events_read on public.reservation_events for select to authenticated using (public.is_member(tenant_id));
create policy audit_logs_read on public.audit_logs for select to authenticated using (public.is_manager(tenant_id));

-- notifications: members read and can mark in-app items as read
create policy notifications_read on public.notifications for select to authenticated using (public.is_member(tenant_id));
create policy notifications_mark_read on public.notifications for update to authenticated
  using (public.is_member(tenant_id) and channel = 'in_app')
  with check (public.is_member(tenant_id) and channel = 'in_app');

-- ---------------------------------------------------------------------
-- Column-level protection: tenants cannot change their own commercial
-- status / plan; only Innovai admins can.
-- ---------------------------------------------------------------------
create or replace function public.tenants_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.is_platform_admin() then
    if new.status is distinct from old.status or new.plan_id is distinct from old.plan_id then
      raise exception 'Somente a Innovai pode alterar status ou plano.' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
create trigger tenants_guard before update on public.tenants
  for each row execute function public.tenants_guard();

-- Never leave a tenant without an active owner
create or replace function public.members_keep_owner() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_tenant uuid := coalesce(old.tenant_id, new.tenant_id);
begin
  if not exists (select 1 from public.tenants where id = v_tenant) then
    return null; -- tenant itself being deleted
  end if;
  if not exists (
    select 1 from public.tenant_members
    where tenant_id = v_tenant and role = 'owner' and is_active
  ) then
    raise exception 'O estabelecimento precisa de ao menos um proprietário ativo.' using errcode = 'P0001';
  end if;
  return null;
end $$;
create constraint trigger members_keep_owner after update or delete on public.tenant_members
  deferrable initially deferred
  for each row execute function public.members_keep_owner();

-- Audit trail for configuration changes
create or replace function public.audit_row() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_tenant uuid;
begin
  if tg_table_name = 'tenants' then
    v_tenant := coalesce(to_jsonb(new) ->> 'id', to_jsonb(old) ->> 'id')::uuid;
  else
    v_tenant := coalesce(to_jsonb(new) ->> 'tenant_id', to_jsonb(old) ->> 'tenant_id')::uuid;
  end if;
  if tg_op = 'DELETE' and not exists (select 1 from public.tenants where id = v_tenant) then
    return null;
  end if;
  insert into public.audit_logs (tenant_id, actor_id, entity, entity_id, action, old_data, new_data)
  values (v_tenant, auth.uid(), tg_table_name,
          coalesce(to_jsonb(new) ->> 'id', to_jsonb(old) ->> 'id', v_tenant::text),
          lower(tg_op),
          case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end,
          case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end);
  return null;
end $$;

create trigger audit_tenants after update on public.tenants for each row execute function public.audit_row();
create trigger audit_booking_settings after update on public.booking_settings for each row execute function public.audit_row();
create trigger audit_members after insert or update or delete on public.tenant_members for each row execute function public.audit_row();
create trigger audit_business_hours after insert or update or delete on public.business_hours for each row execute function public.audit_row();
create trigger audit_customers_delete after delete on public.customers for each row execute function public.audit_row();

-- Profile row for every new auth user
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name, phone)
  values (new.id, new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'phone')
  on conflict (id) do nothing;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();
