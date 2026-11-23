-- =====================================================================
-- Phase 4 — commercial SaaS (run after the previous suites)
-- =====================================================================
\set ON_ERROR_STOP 1
\echo '== SaaS: setup'
insert into auth.users (id, email, raw_user_meta_data) values
  ('dddddddd-0000-0000-0000-000000000004', 'admin@innovai.test', '{"full_name": "Admin Innovai"}');
insert into public.platform_admins (user_id) values ('dddddddd-0000-0000-0000-000000000004');
grant usage on schema tests to service_role;
grant execute on all functions in schema tests to service_role;

set role authenticated;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000001', false);
select id as pt from public.create_tenant('Plano Teste', 'plano-teste', 'restaurant') \gset
select tests.assert((select p.code from public.subscriptions s join public.plans p on p.id = s.plan_id where s.tenant_id = :'pt') = 'pro', 'new establishments start on a Pro trial');
select tests.assert((select p.code from public.tenants t join public.plans p on p.id = t.plan_id where t.id = :'pt') = 'pro', 'tenant plan follows subscription');
select tests.assert((public.get_plan_usage(:'pt') -> 'features' ->> 'tables_map')::boolean, 'usage endpoint exposes effective features');
select tests.assert((public.get_plan_usage(:'pt') -> 'usage' ->> 'members')::int = 1, 'usage counts members');

\echo '== Non-admins cannot use the Innovai panel'
select tests.expect_error('select public.admin_overview()', '42501', 'owner cannot read platform metrics');
select tests.expect_error('select * from public.admin_list_tenants()', '42501', 'owner cannot list all establishments');
select tests.expect_error(format($$select public.admin_update_tenant(%L, p_plan_code => 'business')$$, :'pt'), '42501', 'owner cannot change own plan via RPC');
select tests.expect_error(format($$update public.tenants set feature_overrides = '{"features":{"ai_insights":true}}' where id = %L$$, :'pt'), '42501', 'owner cannot unlock features');
select tests.assert(tests.rows($$update public.plans set price_cents = 1$$) = 0, 'owner cannot edit plans');
select tests.expect_error(format($$insert into public.tenant_invitations (tenant_id, email, role) values (%L, 'x@y.com', 'owner')$$, :'pt'), '42501', 'owner invitations are Innovai-only');

\echo '== Admin manages plans & subscriptions'
select set_config('request.jwt.claim.sub', 'dddddddd-0000-0000-0000-000000000004', false);
select tests.assert((public.admin_overview() ->> 'tenants')::int >= 5, 'admin sees platform metrics');
select tests.assert((select count(*) from public.admin_list_tenants()) >= 5, 'admin lists every establishment');
select tests.assert((select owner_email from public.admin_list_tenants('plano-teste')) = 'ana@casa.test', 'admin sees owner contact');
select public.admin_update_tenant(:'pt', p_plan_code => 'starter', p_subscription_status => 'active');
select tests.assert((select p.code from public.tenants t join public.plans p on p.id = t.plan_id where t.id = :'pt') = 'starter', 'admin downgrades to Starter');
select tests.assert(tests.rows($$update public.plans set description = 'Para começar.' where code = 'starter'$$) = 1, 'admin edits plans');

\echo '== Plan limits & features enforced in the database'
select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000001', false);
select tests.expect_error(format($$update public.booking_settings set allocation_mode = 'tables' where tenant_id = %L$$, :'pt'), 'FEATURE_LOCKED', 'Starter: table map locked');
select tests.expect_error(format($$update public.notification_settings set whatsapp_enabled = true where tenant_id = %L$$, :'pt'), 'FEATURE_LOCKED', 'Starter: WhatsApp locked');
insert into public.tenant_invitations (tenant_id, email, role) values (:'pt', 'garcom@plano.test', 'staff');
select tests.expect_error(format($$insert into public.tenant_invitations (tenant_id, email, role) values (%L, 'outro@plano.test', 'staff')$$, :'pt'),
  'PLAN_LIMIT', 'Starter: max 2 users (owner + 1 invite)');
insert into public.dining_tables (tenant_id, name, max_capacity) select :'pt', 'M' || g, 4 from generate_series(1, 5) g;
select tests.expect_error(format($$insert into public.dining_tables (tenant_id, name, max_capacity) values (%L, 'M6', 4)$$, :'pt'),
  'PLAN_LIMIT', 'Starter: max 5 tables/professionals');

select set_config('request.jwt.claim.sub', 'dddddddd-0000-0000-0000-000000000004', false);
select public.admin_update_tenant(:'pt', p_feature_overrides => '{"features": {"tables_map": true}, "limits": {"max_resources": 10, "max_reservations_month": 1}}');
select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000001', false);
update public.booking_settings set allocation_mode = 'tables' where tenant_id = :'pt';
select tests.assert((select allocation_mode from public.booking_settings where tenant_id = :'pt') = 'tables', 'per-tenant override unlocks a feature');
insert into public.dining_tables (tenant_id, name, max_capacity) values (:'pt', 'M6', 4);
select tests.assert((select count(*) from public.dining_tables where tenant_id = :'pt') = 6, 'per-tenant override raises a limit');
update public.booking_settings set allocation_mode = 'capacity', max_reservations_per_slot = null where tenant_id = :'pt';

select d::date as day from generate_series(current_date + 2, current_date + 9, interval '1 day') d where extract(dow from d) = 3 limit 1 \gset
insert into public.reservations (tenant_id, customer_name, customer_phone, starts_at, party_size, status)
values (:'pt', 'Primeiro', '11960000001', (:'day'::date + time '12:00') at time zone 'America/Sao_Paulo', 2, 'confirmed');
select tests.expect_error(format($$insert into public.reservations (tenant_id, customer_name, customer_phone, starts_at, party_size)
  values (%L, 'Segundo', '11960000002', (%L::date + time '19:00') at time zone 'America/Sao_Paulo', 2)$$, :'pt', :'day'),
  'PLAN_LIMIT', 'monthly reservation limit enforced');

\echo '== Subscription lifecycle'
select set_config('request.jwt.claim.sub', 'dddddddd-0000-0000-0000-000000000004', false);
select public.admin_update_tenant(:'pt', p_subscription_status => 'trialing', p_trial_ends_at => now() - interval '10 days',
                                  p_feature_overrides => '{}');
reset role; set role anon; select set_config('request.jwt.claim.sub', '', false);
select slot_start as slot from public.get_available_slots('plano-teste', :'day', 2) limit 1 \gset
select tests.expect_error(format('select public.create_public_reservation(%L, %L::timestamptz, 2, %L, %L)', 'plano-teste', :'slot', 'Online', '11960000003'),
  'BOOKING_DISABLED', 'expired trial stops online bookings');
reset role; set role service_role;
select tests.assert((public.refresh_subscription_states() ->> 'suspended')::int >= 1, 'lifecycle job suspends long-overdue accounts');
reset role; set role anon;
select tests.expect_error($$select public.get_public_page('plano-teste')$$, 'NOT_FOUND', 'suspended establishment leaves the public site');
reset role; set role authenticated; select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000001', false);
select tests.assert(not public.can_write(:'pt'), 'suspended establishment is read-only');
select tests.assert((select count(*) from public.reservations where tenant_id = :'pt') = 1, 'data stays readable while suspended');
select set_config('request.jwt.claim.sub', 'dddddddd-0000-0000-0000-000000000004', false);
select public.admin_update_tenant(:'pt', p_subscription_status => 'active', p_period_end => now() + interval '30 days');
select tests.assert((select status from public.tenants where id = :'pt') = 'active', 'reactivating the subscription reopens the establishment');

\echo '== Innovai sets up a customer'
select public.admin_create_tenant('Cliente Vendido', 'cliente-vendido', 'barbershop', 'novo@cliente.test', 'business', 30) as sold \gset
select tests.assert((select role from public.tenant_invitations where tenant_id = :'sold') = 'owner', 'owner invitation created for a new customer');
select tests.assert((select p.code from public.tenants t join public.plans p on p.id = t.plan_id where t.id = :'sold') = 'business', 'sold plan kept during trial');
reset role;
insert into auth.users (id, email) values ('eeeeeeee-0000-0000-0000-000000000005', 'novo@cliente.test');
set role authenticated; select set_config('request.jwt.claim.sub', 'eeeeeeee-0000-0000-0000-000000000005', false);
select tests.assert(public.accept_invitations() = 1, 'customer joins on first login');
select tests.assert(public.tenant_role(:'sold') = 'owner', 'customer becomes owner');

\echo '== Support'
select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000001', false);
insert into public.support_tickets (tenant_id, created_by, subject, category)
values (:'pt', 'aaaaaaaa-0000-0000-0000-000000000001', 'Quero o plano Pro', 'upgrade') returning id as tk \gset
insert into public.support_messages (ticket_id, author_id, body, is_staff)
values (:'tk', 'aaaaaaaa-0000-0000-0000-000000000001', 'Olá, como faço upgrade?', true);
select tests.assert((select bool_and(not is_staff) from public.support_messages where ticket_id = :'tk'), 'customers cannot post as Innovai staff');
select set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-0000-0000-000000000002', false);
select tests.assert((select count(*) from public.support_tickets where id = :'tk') = 0, 'other establishments cannot read tickets');
select tests.expect_error(format($$insert into public.support_messages (ticket_id, author_id, body) values (%L, 'bbbbbbbb-0000-0000-0000-000000000002', 'x')$$, :'tk'),
  '42501', 'other establishments cannot reply');
select set_config('request.jwt.claim.sub', 'dddddddd-0000-0000-0000-000000000004', false);
select tests.assert(exists (select 1 from public.admin_list_tickets('open') where id = :'tk'), 'Innovai support inbox lists the ticket');
insert into public.support_messages (ticket_id, author_id, body) values (:'tk', 'dddddddd-0000-0000-0000-000000000004', 'Liberado!');
select tests.assert((select status from public.support_tickets where id = :'tk') = 'answered', 'staff reply marks ticket answered');
select tests.assert(exists (select 1 from public.notifications where tenant_id = :'pt' and template = 'support_reply'), 'establishment notified of the reply');
select tests.assert((select is_staff from public.support_messages where ticket_id = :'tk' order by created_at desc limit 1), 'admin reply flagged as staff');

\echo '== Review fixes'
select public.admin_update_tenant(:'pt', p_internal_notes => 'Cliente negociando desconto');
select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000001', false);
select tests.assert((select count(*) from public.tenant_admin_notes) = 0, 'establishment cannot read Innovai internal notes');
select tests.assert((select to_jsonb(t) ? 'internal_notes' from public.tenants t where id = :'pt') is false, 'internal notes are not on the tenants row');
select tests.expect_error(format($$update public.notifications set title = 'x' where tenant_id = %L$$, :'pt'), '42501', 'notifications: only read_at is writable');
select tests.assert(tests.rows(format($$update public.notifications set read_at = now() where tenant_id = %L and channel = 'in_app'$$, :'pt')) >= 1, 'notifications can be marked read');
select tests.expect_error(format($$update public.support_tickets set subject = 'x' where id = %L$$, :'tk'), '42501', 'tickets: subject is immutable for customers');
-- a manager must not demote or remove the owner
reset role;
insert into auth.users (id, email) values ('ffffffff-0000-0000-0000-000000000006', 'gerente@casa.test');
insert into public.tenant_members (tenant_id, user_id, role)
select id, 'ffffffff-0000-0000-0000-000000000006', 'manager' from public.tenants where slug = 'casa-ana';
set role authenticated; select set_config('request.jwt.claim.sub', 'ffffffff-0000-0000-0000-000000000006', false);
select tests.assert(tests.rows($$update public.tenant_members set role = 'staff' where role = 'owner'$$) = 0, 'manager cannot demote the owner');
select tests.assert(tests.rows($$delete from public.tenant_members where role = 'owner'$$) = 0, 'manager cannot remove the owner');
select tests.assert(tests.rows($$update public.tenant_members set role = 'manager' where role = 'staff'$$) >= 1, 'manager still manages staff');

reset role;
\echo 'SAAS SUITE PASSED'
