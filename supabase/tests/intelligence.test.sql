-- =====================================================================
-- Phase 5 — reports, insights, automations, AI data tools
-- =====================================================================
\set ON_ERROR_STOP 1
\echo '== Intelligence: setup (history inserted directly, as past data)'
set role authenticated;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000001', false);
select id as it from public.create_tenant('Intel Teste', 'intel-teste', 'restaurant') \gset
update public.booking_settings set max_reservations_per_slot = null, max_guests_per_slot = null where tenant_id = :'it';
reset role;
-- 20 reservations in the last 30 days (3 no-shows), Fridays 20h heavier; 12 in the previous 30 days
insert into public.reservations (tenant_id, customer_name, customer_phone, starts_at, party_size, status, source)
select :'it', 'Cliente ' || (g % 6), '1197000000' || (g % 6),
       date_trunc('hour', now() - make_interval(days => 1 + g)) - interval '1 hour' * (g % 3),
       2 + (g % 3), case when g in (2, 5, 8) then 'no_show' else 'completed' end::public.reservation_status,
       case when g % 2 = 0 then 'online' else 'phone' end::public.reservation_source
from generate_series(1, 20) g;
insert into public.reservations (tenant_id, customer_name, customer_phone, starts_at, party_size, status, source)
select :'it', 'Antigo ' || g, '1196000000' || g, now() - make_interval(days => 31 + g), 2, 'completed', 'phone'
from generate_series(1, 12) g;
-- a regular who stopped coming 90 days ago and accepted marketing; and one who did not accept
insert into public.reservations (tenant_id, customer_name, customer_phone, starts_at, party_size, status, source) values
  (:'it', 'Sumido Opt-in', '11950001111', now() - interval '90 days', 2, 'completed', 'phone'),
  (:'it', 'Sumido Sem Opt', '11950002222', now() - interval '95 days', 2, 'completed', 'phone');
update public.customers set marketing_opt_in = true where tenant_id = :'it' and name = 'Sumido Opt-in';
insert into public.customers (tenant_id, name, phone, marketing_opt_in, birthday, email)
values (:'it', 'Aniversariante', '11950003333', true, (now() at time zone 'America/Sao_Paulo')::date - interval '30 years', 'niver@x.com');

set role authenticated;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000001', false);

\echo '== Advanced report'
select public.report_data(:'it', current_date - 29, current_date) as rep \gset
select tests.assert((:'rep'::jsonb -> 'summary' ->> 'reservations')::int = 20, 'report counts reservations in period');
select tests.assert((:'rep'::jsonb -> 'summary' ->> 'no_show')::int = 3, 'report counts no-shows');
select tests.assert((:'rep'::jsonb -> 'summary' ->> 'no_show_rate')::numeric = 15.0, 'no-show rate = 3/20');
select tests.assert(jsonb_array_length(:'rep'::jsonb -> 'heatmap') > 0, 'weekday × hour heatmap');
select tests.assert(jsonb_array_length(:'rep'::jsonb -> 'customers' -> 'top') > 0, 'top customers');
select tests.assert((:'rep'::jsonb -> 'summary' ->> 'online_share')::numeric = 50.0, 'online share');

\echo '== Insights (only from real data)'
select public.tenant_insights(:'it') as ins \gset
select tests.assert(exists (select 1 from jsonb_array_elements(:'ins'::jsonb) e where e ->> 'key' = 'peak'), 'peak-hour insight');
select tests.assert(exists (select 1 from jsonb_array_elements(:'ins'::jsonb) e where e ->> 'key' = 'no_show' and (e ->> 'metric')::numeric = 15.0), 'no-show insight with real rate');
select tests.assert(exists (select 1 from jsonb_array_elements(:'ins'::jsonb) e where e ->> 'key' = 'trend'), 'trend vs previous 30 days');
select tests.assert(exists (select 1 from jsonb_array_elements(:'ins'::jsonb) e where e ->> 'key' = 'inactive'), 'customers who stopped coming');
select tests.assert((public.tenant_insights((select id from public.tenants where slug = 'plano-teste')) -> 0 ->> 'key') = 'not_enough_data', 'no invented insights without data');
select tests.assert((select count(*) from public.inactive_customers(:'it', 60, 10)) = 2, 'AI tool: inactive customers');

\echo '== Automations'
select tests.assert((public.preview_automation(:'it', 'win_back', 60, 'whatsapp') ->> 'count')::int = 1, 'win-back audience: only opted-in');
insert into public.automation_rules (tenant_id, kind, enabled, channel, days, message) values
  (:'it', 'win_back', true, 'whatsapp', 60, 'Oi {nome}! Sentimos sua falta no {estabelecimento}. Reserve: {link}'),
  (:'it', 'birthday', true, 'email', 60, 'Feliz aniversário, {nome}! Um presente te espera no {estabelecimento}.');
reset role; set role service_role;
select tests.assert((public.run_automations() ->> 'queued')::int = 0, 'nothing sent while the channels are off');
reset role; set role authenticated; select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000001', false);
update public.notification_settings set whatsapp_enabled = true, email_enabled = true where tenant_id = :'it';
reset role; set role service_role;
select tests.assert((public.run_automations() ->> 'queued')::int = 2, 'win-back + birthday queued');
select tests.assert((public.run_automations() ->> 'queued')::int = 0, 'no duplicates on the next run');
reset role; set role authenticated; select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000001', false);
select tests.assert((select body from public.notifications where tenant_id = :'it' and template = 'automation_win_back')
                    like 'Oi Sumido! Sentimos sua falta no Intel Teste. Reserve: https://innovaireserve.com/restaurante/intel-teste', 'placeholders filled');
select tests.assert(not exists (select 1 from public.notifications n join public.customers c on c.id = n.customer_id
                                where c.name = 'Sumido Sem Opt'), 'customers without consent never messaged');

\echo '== Plans & isolation'
select set_config('request.jwt.claim.sub', 'dddddddd-0000-0000-0000-000000000004', false);
select public.admin_update_tenant(:'it', p_plan_code => 'starter', p_subscription_status => 'active');
select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000001', false);
select tests.expect_error(format('select public.report_data(%L, current_date - 7, current_date)', :'it'), 'FEATURE_LOCKED', 'Starter: advanced reports locked');
select tests.expect_error(format($$update public.automation_rules set days = 30 where tenant_id = %L and kind = 'win_back'$$, :'it'), 'FEATURE_LOCKED', 'Starter: automations locked');
select tests.assert(jsonb_array_length(public.tenant_insights(:'it')) > 0, 'insights stay available on every plan');
select set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-0000-0000-000000000002', false);
select tests.expect_error(format('select public.tenant_insights(%L)', :'it'), '42501', 'other tenant cannot read insights');
select tests.expect_error(format('select * from public.inactive_customers(%L)', :'it'), '42501', 'other tenant cannot list inactive customers');
select tests.expect_error(format($$select public.preview_automation(%L, 'win_back', 60, 'whatsapp')$$, :'it'), '42501', 'other tenant cannot preview audiences');
select tests.assert((select count(*) from public.automation_rules where tenant_id = :'it') = 0, 'other tenant cannot see automations');
select tests.expect_error($$select * from public._automation_audience(gen_random_uuid(), 'win_back', 60, 'whatsapp')$$, '42501', 'audience helper not callable');
select tests.expect_error('select public.run_automations()', '42501', 'automation job is server-only');

reset role;
\echo 'INTELLIGENCE SUITE PASSED'
