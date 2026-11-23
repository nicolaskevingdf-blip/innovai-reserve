-- =====================================================================
-- INNOVAI RESERVE — 09 · Intelligence & automation (Phase 5)
--  * advanced reports (heatmap, no-show/lead time, tables, customers)
--  * rule-based insights computed only from real data (no AI involved)
--  * relationship automations (win-back, birthday) through the outbox,
--    only for customers who opted in (LGPD)
--  * read-only data tools for the AI assistant Edge Function
-- =====================================================================

-- New plan features: automations (Pro+), AI assistant stays Business
update public.plans set features = features || jsonb_build_object('automations', code <> 'starter');

-- Platform-wide settings managed by Innovai (used to build links in messages)
create table public.platform_settings (
  id boolean primary key default true check (id),
  public_base_url text not null default 'https://innovaireserve.com' check (public_base_url ~ '^https?://'),
  updated_at timestamptz not null default now()
);
insert into public.platform_settings default values;

-- Who a customer message was for (dedupe of automations)
alter table public.notifications add column customer_id uuid references public.customers (id) on delete cascade;
create index notifications_customer_template_idx on public.notifications (customer_id, template, created_at desc) where customer_id is not null;

create table public.automation_rules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  kind text not null check (kind in ('win_back', 'birthday')),
  enabled boolean not null default false,
  channel public.notification_channel not null default 'whatsapp' check (channel in ('whatsapp', 'email')),
  days integer not null default 60 check (days between 14 and 365), -- win_back: days without a visit
  message text not null check (char_length(message) between 10 and 600),
  last_run_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, kind)
);
create trigger automation_rules_updated_at before update on public.automation_rules
  for each row execute function public.set_updated_at();

alter table public.automation_rules enable row level security;
alter table public.platform_settings enable row level security;
revoke all on public.automation_rules, public.platform_settings from anon;
grant select, insert, update, delete on public.automation_rules to authenticated;
grant select on public.platform_settings to authenticated;
create policy automation_rules_read on public.automation_rules for select to authenticated using (public.is_member(tenant_id));
create policy automation_rules_write on public.automation_rules for all to authenticated
  using (public.can_manage(tenant_id)) with check (public.can_manage(tenant_id));
create policy platform_settings_read on public.platform_settings for select to authenticated using (true);
create policy platform_settings_admin on public.platform_settings for update to authenticated
  using (public.is_platform_admin()) with check (public.is_platform_admin());

create or replace function public.plan_guard_automations() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.enabled and not public._plan_bypass() and not public.has_feature(new.tenant_id, 'automations') then
    raise exception 'Automações estão disponíveis a partir do plano Pro.' using errcode = 'P0001', hint = 'FEATURE_LOCKED';
  end if;
  return new;
end $$;
create trigger plan_guard_automations before insert or update on public.automation_rules
  for each row execute function public.plan_guard_automations();

-- ---------------------------------------------------------------------
-- Automations
-- ---------------------------------------------------------------------
create or replace function public._public_link(p_tenant uuid) returns text
language sql stable security definer set search_path = public as $$
  select ps.public_base_url || '/' ||
         case t.segment when 'restaurant' then 'restaurante' when 'barbershop' then 'barbearia' when 'salon' then 'salao'
                        when 'clinic' then 'clinica' else 'estabelecimento' end || '/' || t.slug
  from public.tenants t, public.platform_settings ps where t.id = p_tenant
$$;

-- Opted-in customers a rule would message today. Dedupe: win-back at most
-- every 90 days, birthday once a year.
create or replace function public._automation_audience(p_tenant uuid, p_kind text, p_days integer, p_channel public.notification_channel)
returns table (customer_id uuid, name text, phone text, email text)
language sql stable security definer set search_path = public as $$
  with tz as (select timezone from public.tenants where id = p_tenant),
  visits as (
    select c.id, max(r.starts_at) filter (where r.status in ('completed', 'in_progress') or (r.status = 'confirmed' and r.ends_at < now())) as last_visit,
           bool_or(r.status in ('pending', 'confirmed') and r.starts_at > now()) as has_future
    from public.customers c left join public.reservations r on r.customer_id = c.id
    where c.tenant_id = p_tenant group by c.id
  )
  select c.id, c.name, c.phone_normalized, c.email
  from public.customers c join visits v on v.id = c.id, tz
  where c.tenant_id = p_tenant and c.marketing_opt_in
    and (p_channel <> 'email' or c.email is not null)
    and case p_kind
      when 'win_back' then v.last_visit < now() - make_interval(days => p_days) and not coalesce(v.has_future, false)
      when 'birthday' then c.birthday is not null
        and to_char(c.birthday, 'MM-DD') = to_char(now() at time zone tz.timezone, 'MM-DD')
      else false end
    and not exists (
      select 1 from public.notifications n
      where n.customer_id = c.id and n.template = 'automation_' || p_kind
        and n.created_at > now() - case p_kind when 'birthday' then interval '300 days' else interval '90 days' end)
$$;

create or replace function public.preview_automation(p_tenant uuid, p_kind text, p_days integer, p_channel public.notification_channel)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_member(p_tenant) then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;
  return (select jsonb_build_object('count', count(*), 'sample', coalesce(jsonb_agg(a.name) filter (where a.rn <= 5), '[]'::jsonb))
          from (select name, row_number() over (order by name) rn
                from public._automation_audience(p_tenant, p_kind, p_days, p_channel)) a);
end $$;

-- Daily job (pg_cron): queue the messages; the notification-dispatcher sends them.
create or replace function public.run_automations() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  rule record;
  v_total int := 0;
  v_count int;
begin
  for rule in
    select ar.*, t.name as tenant_name
    from public.automation_rules ar
    join public.tenants t on t.id = ar.tenant_id and t.status = 'active'
    join public.notification_settings ns on ns.tenant_id = ar.tenant_id
    where ar.enabled
      and public.subscription_ok(ar.tenant_id)
      and public.has_feature(ar.tenant_id, 'automations')
      and ((ar.channel = 'whatsapp' and ns.whatsapp_enabled) or (ar.channel = 'email' and ns.email_enabled))
  loop
    insert into public.notifications (tenant_id, customer_id, channel, template, audience, recipient, title, body, payload)
    select rule.tenant_id, a.customer_id, rule.channel, 'automation_' || rule.kind, 'customer',
           case when rule.channel = 'email' then a.email else a.phone end,
           case rule.kind when 'birthday' then 'Feliz aniversário!' else 'Sentimos sua falta' end,
           replace(replace(replace(rule.message, '{nome}', split_part(a.name, ' ', 1)),
                           '{estabelecimento}', rule.tenant_name), '{link}', public._public_link(rule.tenant_id)),
           jsonb_build_object('automation', rule.kind, 'rule_id', rule.id)
    from public._automation_audience(rule.tenant_id, rule.kind, rule.days, rule.channel) a;
    get diagnostics v_count = row_count;
    v_total := v_total + v_count;
    update public.automation_rules set last_run_at = now() where id = rule.id;
  end loop;
  insert into public.audit_logs (entity, action, new_data) values ('automations', 'run', jsonb_build_object('queued', v_total));
  return jsonb_build_object('queued', v_total);
end $$;

-- ---------------------------------------------------------------------
-- Advanced report
-- ---------------------------------------------------------------------
create or replace function public.report_data(p_tenant uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_tz text;
  v_start timestamptz;
  v_end timestamptz;
  v_open_min numeric;
  v jsonb;
begin
  if not public.is_member(p_tenant) then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;
  if p_to < p_from or p_to - p_from > 370 then
    raise exception 'Período inválido.' using errcode = '22023';
  end if;
  if not public.has_feature(p_tenant, 'reports_advanced') then
    raise exception 'Relatórios avançados estão disponíveis a partir do plano Pro.' using errcode = 'P0001', hint = 'FEATURE_LOCKED';
  end if;
  select timezone into v_tz from public.tenants where id = p_tenant;
  v_start := p_from::timestamp at time zone v_tz;
  v_end := (p_to + 1)::timestamp at time zone v_tz;
  select coalesce(sum(extract(epoch from (bh.closes_at - bh.opens_at)) / 60), 0) into v_open_min
  from generate_series(p_from, p_to, interval '1 day') d
  join public.business_hours bh on bh.tenant_id = p_tenant and bh.weekday = extract(dow from d)::int;

  with cur as (
    select r.*, (r.starts_at at time zone v_tz) as local_start
    from public.reservations r where r.tenant_id = p_tenant and r.starts_at >= v_start and r.starts_at < v_end
  ), done as (select * from cur where status <> 'cancelled')
  select jsonb_build_object(
    'period', jsonb_build_object('from', p_from, 'to', p_to, 'timezone', v_tz),
    'summary', jsonb_build_object(
      'reservations', (select count(*) from cur),
      'attended', (select count(*) from cur where status in ('completed', 'in_progress') or (status = 'confirmed' and ends_at < now())),
      'guests', (select coalesce(sum(party_size), 0) from done where status <> 'no_show'),
      'cancelled', (select count(*) from cur where status = 'cancelled'),
      'no_show', (select count(*) from cur where status = 'no_show'),
      'cancel_rate', (select case when count(*) = 0 then null else round(100.0 * count(*) filter (where status = 'cancelled') / count(*), 1) end from cur),
      'no_show_rate', (select case when count(*) = 0 then null else round(100.0 * count(*) filter (where status = 'no_show') / count(*), 1) end from done),
      'avg_party', (select round(avg(party_size), 1) from done),
      'lead_time_hours_median', (select round((percentile_cont(0.5) within group (order by extract(epoch from (starts_at - created_at)) / 3600))::numeric, 1) from cur where source = 'online' and created_at <= starts_at),
      'online_share', (select case when count(*) = 0 then null else round(100.0 * count(*) filter (where source = 'online') / count(*), 1) end from cur)),
    'heatmap', coalesce((select jsonb_agg(jsonb_build_object('weekday', w, 'hour', h, 'count', c))
                         from (select extract(dow from local_start)::int w, extract(hour from local_start)::int h, count(*) c
                               from done group by 1, 2) x), '[]'::jsonb),
    'by_source', coalesce((select jsonb_agg(jsonb_build_object('source', source, 'count', c) order by c desc)
                           from (select source, count(*) c from cur group by source) x), '[]'::jsonb),
    'no_show_by_weekday', coalesce((select jsonb_agg(jsonb_build_object('weekday', w, 'no_show', ns, 'total', t) order by w)
                           from (select extract(dow from local_start)::int w, count(*) filter (where status = 'no_show') ns, count(*) t
                                 from done group by 1) x), '[]'::jsonb),
    'cancel_reasons', coalesce((select jsonb_agg(jsonb_build_object('reason', cancel_reason, 'count', c) order by c desc)
                           from (select coalesce(nullif(btrim(cancel_reason), ''), 'Sem motivo') cancel_reason, count(*) c
                                 from cur where status = 'cancelled' group by 1 order by 2 desc limit 6) x), '[]'::jsonb),
    'tables', coalesce((select jsonb_agg(x order by x.minutes desc) from (
        select dt.id, dt.name, a.name as area,
               count(d.id) as reservations, coalesce(sum(d.party_size), 0) as guests,
               round(coalesce(sum(extract(epoch from (d.ends_at - d.starts_at)) / 60), 0)) as minutes,
               case when v_open_min = 0 then null
                    else round(100 * coalesce(sum(extract(epoch from (d.ends_at - d.starts_at)) / 60), 0) / v_open_min, 1) end as occupancy
        from public.dining_tables dt
        left join public.areas a on a.id = dt.area_id
        left join done d on dt.id = any (d.table_ids) and d.status <> 'no_show'
        where dt.tenant_id = p_tenant
        group by dt.id, a.name) x), '[]'::jsonb),
    'staff', public.staff_service_metrics(p_tenant, p_from, p_to),
    'customers', jsonb_build_object(
      'new', (select count(*) from public.customers where tenant_id = p_tenant and created_at >= v_start and created_at < v_end),
      'returning', (select count(distinct d.customer_id) from done d
                    where exists (select 1 from public.reservations p where p.customer_id = d.customer_id and p.starts_at < v_start
                                    and p.status in ('completed', 'in_progress', 'confirmed'))),
      'top', coalesce((select jsonb_agg(jsonb_build_object('name', c.name, 'visits', x.n) order by x.n desc)
                       from (select customer_id, count(*) n from done where customer_id is not null and status <> 'no_show'
                             group by 1 order by 2 desc limit 10) x join public.customers c on c.id = x.customer_id), '[]'::jsonb))
  ) into v;
  return v;
end $$;

-- pt-BR number formatting for insight texts (10.5 → "10,5")
create or replace function public._br(n numeric) returns text
language sql immutable as $$ select replace(trim(to_char(n, 'FM999999990.0')), '.', ',') $$;

-- ---------------------------------------------------------------------
-- Insights: deterministic recommendations from the last 30 days.
-- Every number comes from the database; nothing is estimated.
-- ---------------------------------------------------------------------
create or replace function public.tenant_insights(p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_tz text;
  v_out jsonb := '[]'::jsonb;
  n_cur int; n_prev int;
  r record;
  v_rate numeric; v_prev_rate numeric;
  s public.booking_settings;
  ns public.notification_settings;
  v_inactive int;
  v_noshow int;
  v_seated int;
  wd text[] := array['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
begin
  if not public.is_member(p_tenant) then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;
  select timezone into v_tz from public.tenants where id = p_tenant;
  select * into s from public.booking_settings where tenant_id = p_tenant;
  select * into ns from public.notification_settings where tenant_id = p_tenant;

  select count(*) filter (where starts_at >= now() - interval '30 days'),
         count(*) filter (where starts_at < now() - interval '30 days')
    into n_cur, n_prev
  from public.reservations
  where tenant_id = p_tenant and starts_at >= now() - interval '60 days' and starts_at < now() and status <> 'cancelled';

  if n_cur < 10 then
    return jsonb_build_array(jsonb_build_object(
      'key', 'not_enough_data', 'tone', 'info', 'title', 'Ainda coletando dados',
      'detail', format('São %s reserva(s) nos últimos 30 dias. As recomendações aparecem a partir de 10.', n_cur)));
  end if;

  -- 1. trend vs previous 30 days
  if n_prev >= 10 then
    v_out := v_out || jsonb_build_object('key', 'trend', 'tone', case when n_cur >= n_prev then 'positive' else 'warning' end,
      'title', case when n_cur >= n_prev then 'Movimento em alta' else 'Movimento em queda' end,
      'detail', format('%s reservas nos últimos 30 dias contra %s nos 30 anteriores (%s%s%%).', n_cur, n_prev,
                       case when n_cur >= n_prev then '+' else '' end, round(100.0 * (n_cur - n_prev) / n_prev)),
      'metric', n_cur);
  end if;

  -- 2. peak weekday + hour
  select extract(dow from starts_at at time zone v_tz)::int w, extract(hour from starts_at at time zone v_tz)::int h, count(*) c
    into r
  from public.reservations
  where tenant_id = p_tenant and starts_at >= now() - interval '30 days' and starts_at < now() and status <> 'cancelled'
  group by 1, 2 order by 3 desc limit 1;
  v_out := v_out || jsonb_build_object('key', 'peak', 'tone', 'info', 'title', 'Horário de pico',
    'detail', format('%s às %sh concentra %s reservas (%s%% do movimento). Reforce a equipe nesse horário.',
                     initcap(wd[r.w + 1]), r.h, r.c, round(100.0 * r.c / n_cur)),
    'metric', r.c);

  -- 3. weakest open weekday → promotion
  select bh.weekday w, count(res.id) c into r
  from (select distinct weekday from public.business_hours where tenant_id = p_tenant) bh
  left join public.reservations res on res.tenant_id = p_tenant and res.status <> 'cancelled'
       and res.starts_at >= now() - interval '30 days' and res.starts_at < now()
       and extract(dow from res.starts_at at time zone v_tz)::int = bh.weekday
  group by bh.weekday order by 2 asc limit 1;
  if r.w is not null then
    v_out := v_out || jsonb_build_object('key', 'weak_day', 'tone', 'info', 'title', format('%s é o dia mais vazio', initcap(wd[r.w + 1])),
      'detail', format('Só %s reserva(s) nos últimos 30 dias. Uma promoção ou combo nesse dia pode aumentar a ocupação.', r.c),
      'metric', r.c);
  end if;

  -- 4. no-shows
  select count(*) filter (where status = 'no_show'), count(*) into v_noshow, v_seated
  from public.reservations where tenant_id = p_tenant and starts_at >= now() - interval '30 days' and starts_at < now()
    and status not in ('cancelled', 'pending');
  v_rate := case when v_seated > 0 then round(100.0 * v_noshow / v_seated, 1) end;
  if v_rate >= 8 then
    v_out := v_out || jsonb_build_object('key', 'no_show', 'tone', 'warning', 'title', 'Faltas acima do ideal',
      'detail', format('%s%% dos clientes não compareceram (%s de %s). %s', public._br(v_rate), v_noshow, v_seated,
                       case when not ns.reminder_enabled then 'Ative o lembrete automático antes da reserva.'
                            when not s.require_confirmation then 'Considere exigir confirmação das reservas online.'
                            else 'Entre em contato com clientes que faltam com frequência.' end),
      'metric', v_rate, 'action', jsonb_build_object('label', 'Configurar', 'to', '/app/configuracoes?tab=notificacoes'));
  end if;

  -- 5. cancellations trend
  select round(100.0 * count(*) filter (where status = 'cancelled' and starts_at >= now() - interval '30 days')
               / nullif(count(*) filter (where starts_at >= now() - interval '30 days'), 0), 1),
         round(100.0 * count(*) filter (where status = 'cancelled' and starts_at < now() - interval '30 days')
               / nullif(count(*) filter (where starts_at < now() - interval '30 days'), 0), 1)
    into v_rate, v_prev_rate
  from public.reservations where tenant_id = p_tenant and starts_at >= now() - interval '60 days' and starts_at < now();
  if v_rate is not null and v_prev_rate is not null and v_rate - v_prev_rate >= 5 then
    v_out := v_out || jsonb_build_object('key', 'cancellations', 'tone', 'warning', 'title', 'Cancelamentos aumentaram',
      'detail', format('Taxa de cancelamento subiu de %s%% para %s%%. Veja os motivos em Relatórios.', public._br(v_prev_rate), public._br(v_rate)),
      'metric', v_rate, 'action', jsonb_build_object('label', 'Ver relatórios', 'to', '/app/relatorios'));
  end if;

  -- 6. customers who stopped coming
  select count(*) into v_inactive from public.customer_stats
  where tenant_id = p_tenant and visits >= 1 and last_visit_at < now() - interval '60 days' and next_reservation_at is null;
  if v_inactive > 0 then
    v_out := v_out || jsonb_build_object('key', 'inactive', 'tone', 'info', 'title', format('%s cliente(s) sem voltar há 60 dias', v_inactive),
      'detail', case when exists (select 1 from public.automation_rules where tenant_id = p_tenant and kind = 'win_back' and enabled)
                     then 'A automação de reconquista já está ativa para quem aceitou receber mensagens.'
                     else 'Ative a automação de reconquista para convidá-los a voltar (apenas quem aceitou receber mensagens).' end,
      'metric', v_inactive, 'action', jsonb_build_object('label', 'Automações', 'to', '/app/automacoes'));
  end if;

  -- 7. online share
  select round(100.0 * count(*) filter (where source = 'online') / count(*), 1) into v_rate
  from public.reservations where tenant_id = p_tenant and created_at >= now() - interval '30 days';
  if v_rate is not null and v_rate < 30 then
    v_out := v_out || jsonb_build_object('key', 'online', 'tone', 'info', 'title', 'Poucas reservas online',
      'detail', format('Só %s%% das reservas vieram do link. Divulgue-o no Instagram, Google Maps e WhatsApp.', public._br(v_rate)),
      'metric', v_rate, 'action', jsonb_build_object('label', 'Copiar link', 'to', '/app/configuracoes'));
  end if;

  return v_out;
end $$;

-- ---------------------------------------------------------------------
-- Read-only data tools for the AI assistant (called with the user's JWT)
-- ---------------------------------------------------------------------
create or replace function public.inactive_customers(p_tenant uuid, p_days integer default 60, p_limit integer default 20)
returns table (name text, visits bigint, last_visit_at timestamptz, marketing_opt_in boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_member(p_tenant) then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;
  return query
  select cs.name, cs.visits, cs.last_visit_at, cs.marketing_opt_in
  from public.customer_stats cs
  where cs.tenant_id = p_tenant and cs.visits >= 1 and cs.next_reservation_at is null
    and cs.last_visit_at < now() - make_interval(days => greatest(p_days, 1))
  order by cs.visits desc, cs.last_visit_at desc
  limit least(greatest(p_limit, 1), 100);
end $$;

-- ---------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------
revoke execute on function public.plan_guard_automations(), public._public_link(uuid), public._br(numeric),
  public._automation_audience(uuid, text, integer, public.notification_channel),
  public.preview_automation(uuid, text, integer, public.notification_channel), public.run_automations(),
  public.report_data(uuid, date, date), public.tenant_insights(uuid), public.inactive_customers(uuid, integer, integer)
from public, anon, authenticated;
grant execute on function
  public.preview_automation(uuid, text, integer, public.notification_channel),
  public.report_data(uuid, date, date), public.tenant_insights(uuid), public.inactive_customers(uuid, integer, integer)
to authenticated;
grant execute on function public.run_automations() to service_role;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.automation_rules;
  end if;
end $$;
