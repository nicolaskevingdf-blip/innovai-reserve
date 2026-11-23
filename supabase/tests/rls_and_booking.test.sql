-- =====================================================================
-- Database test suite: multi-tenant isolation, RLS, availability,
-- anti-double-booking, public flow, history and notifications.
-- Run with: npm run db:test
-- =====================================================================
\set ON_ERROR_STOP 1
set client_min_messages = notice;

create schema tests;
grant usage on schema tests to anon, authenticated;

create function tests.assert(cond boolean, msg text) returns void language plpgsql as $$
begin
  if cond is not true then raise exception 'ASSERT FAILED: %', msg; end if;
  raise notice 'ok - %', msg;
end $$;

create function tests.expect_error(stmt text, expected text, msg text) returns void language plpgsql as $$
declare v_msg text; v_hint text; v_state text;
begin
  begin
    execute stmt;
  exception when others then
    get stacked diagnostics v_msg = message_text, v_hint = pg_exception_hint, v_state = returned_sqlstate;
    if expected is null or v_hint = expected or v_state = expected or v_msg ilike '%' || expected || '%' then
      raise notice 'ok - % [% %]', msg, v_state, coalesce(nullif(v_hint, ''), v_msg);
      return;
    end if;
    raise exception 'FAILED - %: expected % but got [%] % / %', msg, expected, v_state, v_msg, v_hint;
  end;
  raise exception 'FAILED - %: expected error % but statement succeeded', msg, expected;
end $$;

create function tests.rows(stmt text) returns bigint language plpgsql as $$
declare n bigint;
begin
  execute 'with x as (' || stmt || ' returning 1) select count(*) from x' into n;
  return n;
end $$;
grant execute on all functions in schema tests to anon, authenticated;

insert into auth.users (id, email, raw_user_meta_data) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'ana@casa.test', '{"full_name": "Ana Dona"}'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'bruno@barba.test', '{"full_name": "Bruno Barbeiro"}'),
  ('cccccccc-0000-0000-0000-000000000003', 'carla@casa.test', '{"full_name": "Carla Staff"}');

select tests.assert((select count(*) from public.profiles) = 3, 'profiles auto-created for new auth users');

-- next Tuesday at least 2 days ahead, in the tenant's timezone
select d::date as tue, (d::date + 7) as tue2
from generate_series((now() at time zone 'America/Sao_Paulo')::date + 2,
                     (now() at time zone 'America/Sao_Paulo')::date + 9, interval '1 day') d
where extract(dow from d) = 2 limit 1 \gset
select ((:'tue'::date + time '12:00') at time zone 'America/Sao_Paulo') as slot_12,
       ((:'tue'::date + time '13:30') at time zone 'America/Sao_Paulo') as slot_1330,
       ((:'tue'::date + time '19:00') at time zone 'America/Sao_Paulo') as slot_19,
       ((:'tue'::date + time '12:15') at time zone 'America/Sao_Paulo') as slot_odd \gset

-- =====================================================================
\echo '== Onboarding (Ana: restaurant, Bruno: barbershop)'
set role authenticated;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000001', false);
select id as tenant_a from public.create_tenant('Casa da Ana', 'casa-ana', 'restaurant', 'America/Sao_Paulo', '11 3333-4444') \gset
select tests.assert((select count(*) from public.business_hours where tenant_id = :'tenant_a') = 11, 'restaurant default shifts created');
select tests.assert((select role from public.tenant_members where tenant_id = :'tenant_a') = 'owner', 'creator is owner');
select tests.assert((select status from public.subscriptions where tenant_id = :'tenant_a') = 'trialing', 'trial subscription created');
select tests.expect_error($$select public.create_tenant('Outra', 'casa-ana', 'restaurant')$$, 'SLUG_TAKEN', 'duplicate slug rejected');
select tests.expect_error($$select public.create_tenant('Outra', 'admin', 'restaurant')$$, 'SLUG_TAKEN', 'reserved slug rejected');
select tests.expect_error($$update public.tenants set status = 'suspended'$$, '42501', 'owner cannot change own commercial status');
select tests.expect_error($$insert into public.business_hours (tenant_id, weekday, opens_at, closes_at)
  select id, 2, '14:00', '16:00' from public.tenants$$, '23P01', 'overlapping shifts rejected');

select set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-0000-0000-000000000002', false);
select id as tenant_b from public.create_tenant('Barbearia do Bruno', 'barba-bruno', 'barbershop') \gset

-- =====================================================================
\echo '== Multi-tenant isolation (Bruno attacking Ana)'
select tests.assert((select count(*) from public.tenants) = 1, 'Bruno sees only his tenant');
select tests.assert((select count(*) from public.booking_settings) = 1, 'Bruno sees only his settings');
select tests.assert(tests.rows(format('update public.tenants set name = %L where id = %L', 'hacked', :'tenant_a')) = 0, 'Bruno cannot update Ana tenant');
select tests.assert(tests.rows(format('update public.booking_settings set max_party_size = 1 where tenant_id = %L', :'tenant_a')) = 0, 'Bruno cannot update Ana settings');
select tests.assert(tests.rows(format('delete from public.business_hours where tenant_id = %L', :'tenant_a')) = 0, 'Bruno cannot delete Ana hours');
select tests.expect_error(format($$insert into public.reservations (tenant_id, customer_name, customer_phone, starts_at, ends_at)
  values (%L, 'x', '11999990000', now() + interval '3 days', now() + interval '3 days 1 hour')$$, :'tenant_a'),
  '42501', 'Bruno cannot insert reservations into Ana tenant');
select tests.expect_error(format('select * from public.get_tenant_slots(%L, %L)', :'tenant_a', :'tue'), '42501', 'Bruno cannot read Ana availability');
select tests.expect_error(format('select public.dashboard_metrics(%L, current_date, current_date)', :'tenant_a'), '42501', 'Bruno cannot read Ana metrics');
select tests.assert((select count(*) from public.get_team(:'tenant_a')) = 0, 'Bruno cannot list Ana team');
select tests.expect_error($$select * from public._compute_slots(gen_random_uuid(), current_date, 1, 60)$$, '42501', 'internal helpers not executable by clients');
select tests.expect_error($$select public._enqueue_customer_message(null::public.reservations, 'x', 'x', 'x')$$, '42501', 'outbox writer not executable by clients');
select tests.expect_error($$insert into public.notifications (tenant_id, channel, template, audience) select id, 'email', 'x', 'staff' from public.tenants$$,
  '42501', 'clients cannot forge outbound notifications');

-- =====================================================================
\echo '== Anonymous visitor'
reset role;
set role anon;
select set_config('request.jwt.claim.sub', '', false);
select tests.expect_error('select * from public.reservations', '42501', 'anon has no table access to reservations');
select tests.expect_error('select * from public.customers', '42501', 'anon has no table access to customers');
select tests.expect_error('select * from public.tenants', '42501', 'anon has no table access to tenants');
select tests.expect_error($$select public.create_tenant('x', 'xyz-abc', 'other')$$, '42501', 'anon cannot create tenants');
select tests.assert((public.get_public_page('casa-ana') -> 'tenant' ->> 'name') = 'Casa da Ana', 'public page resolves by slug');
select tests.assert((public.get_public_page('casa-ana') -> 'tenant' ? 'plan_id') is false, 'public page does not leak internal fields');
select tests.expect_error($$select public.get_public_page('nao-existe')$$, 'NOT_FOUND', 'unknown slug → not found');

select tests.assert((select count(*) from public.get_available_slots('casa-ana', :'tue', 2)) = 10,
  'Tuesday: 4 lunch + 6 dinner slots (90 min, 30 min step)');
select tests.assert((select count(*) from public.get_available_slots('casa-ana', :'tue', 50)) = 0, 'party above max → no slots');
select tests.assert((select count(*) from public.get_available_slots('casa-ana', current_date - 1, 2)) = 0, 'past dates → no slots');
select tests.assert((select count(*) from public.get_available_slots('casa-ana', current_date + 400, 2)) = 0, 'beyond max advance → no slots');
select tests.assert((select count(*) from public.get_available_days('casa-ana', :'tue', :'tue2', 2)) >= 2, 'calendar exposes available days');

select (public.create_public_reservation('casa-ana', :'slot_12', 2, 'João Silva', '(11) 98888-7777', 'joao@x.com', 'Aniversário')) ->> 'code' as code1 \gset
select tests.assert(length(:'code1') = 7, 'public booking returns a 7-char code');
select tests.expect_error(format('select public.create_public_reservation(%L, %L::timestamptz, 2, %L, %L)', 'casa-ana', :'slot_12', 'João', '11988887777'),
  'DUPLICATE', 'same customer cannot double book the same time');
select tests.expect_error(format('select public.create_public_reservation(%L, %L::timestamptz, 2, %L, %L)', 'casa-ana', :'slot_odd', 'Maria', '11977776666'),
  'SLOT_UNAVAILABLE', 'off-grid time rejected');
select tests.expect_error(format('select public.create_public_reservation(%L, %L::timestamptz, 2, %L, %L)', 'casa-ana', :'slot_19', 'M', '11977776666'),
  'INVALID_NAME', 'name validated');
select tests.expect_error(format('select public.create_public_reservation(%L, %L::timestamptz, 2, %L, %L)', 'casa-ana', :'slot_19', 'Maria', '123'),
  'INVALID_PHONE', 'phone validated');
select tests.expect_error(format('select public.create_public_reservation(%L, %L::timestamptz, 99, %L, %L)', 'casa-ana', :'slot_19', 'Maria', '11977776666'),
  'INVALID_PARTY', 'party size validated');

select tests.assert((public.get_public_reservation(:'code1', '11988887777') ->> 'status') = 'confirmed', 'lookup by code + phone (auto-confirm)');
select tests.assert((public.get_public_reservation(lower(:'code1'), '+55 (11) 98888-7777') ->> 'code') = :'code1', 'lookup tolerant to formatting');
select tests.expect_error(format('select public.get_public_reservation(%L, %L)', :'code1', '11900000000'), 'NOT_FOUND', 'wrong phone cannot see reservation');

-- =====================================================================
\echo '== Capacity rules & manual bookings (Ana)'
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000001', false);
select tests.assert((select count(*) from public.customers) = 1, 'online booking created CRM customer');
select id as cust_a from public.customers limit 1 \gset
select tests.assert((select count(*) from public.reservation_events where action = 'created' and actor_type = 'customer') = 1, 'history logged as customer');
select tests.assert((select count(*) from public.notifications where channel = 'in_app' and template = 'staff_new_reservation') = 1, 'owner notified in-app');

update public.booking_settings set max_reservations_per_slot = 1, max_guests_per_slot = null;
select tests.assert((select count(*) from public.get_tenant_slots(:'tenant_a', :'tue', 2)) = 7,
  'capacity 1: overlapping lunch slots disappear (1 lunch + 6 dinner)');

reset role; set role anon; select set_config('request.jwt.claim.sub', '', false);
select tests.expect_error(format('select public.create_public_reservation(%L, %L::timestamptz, 2, %L, %L)', 'casa-ana', :'slot_12', 'Maria', '11977776666'),
  'SLOT_UNAVAILABLE', 'full slot rejected at confirmation time (revalidation)');

reset role; set role authenticated; select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000001', false);
select tests.expect_error(format($$insert into public.reservations (tenant_id, customer_name, customer_phone, starts_at, source)
  values (%L, 'Pedro', '11966665555', %L, 'phone')$$, :'tenant_a', :'slot_12'), 'SLOT_FULL', 'manual booking also respects capacity');
insert into public.reservations (tenant_id, customer_name, customer_phone, starts_at, party_size, source, status)
values (:'tenant_a', 'Pedro', '11966665555', :'slot_19', 4, 'phone', 'confirmed');
select tests.assert((select ends_at - starts_at from public.reservations where customer_name = 'Pedro') = interval '90 minutes', 'default duration applied');
select tests.assert((select count(*) from public.customers) = 2, 'manual booking upserts CRM customer');

insert into public.schedule_blocks (tenant_id, starts_at, ends_at, reason)
values (:'tenant_a', :'slot_19'::timestamptz + interval '2 hours', :'slot_19'::timestamptz + interval '4 hours', 'Evento privado');
select tests.assert((select count(*) from public.get_tenant_slots(:'tenant_a', :'tue', 2)) = 1,
  'block + capacity: only 13:30 remains (19:00 taken, 20:30+ blocked)');
select tests.expect_error(format($$insert into public.reservations (tenant_id, customer_name, customer_phone, starts_at)
  values (%L, 'Lia', '11955554444', %L::timestamptz + interval '2 hours')$$, :'tenant_a', :'slot_19'), 'SLOT_BLOCKED', 'blocked time rejected');

-- =====================================================================
\echo '== Team & roles'
insert into public.tenant_invitations (tenant_id, email, role, invited_by)
values (:'tenant_a', 'carla@casa.test', 'staff', 'aaaaaaaa-0000-0000-0000-000000000001');
select set_config('request.jwt.claim.sub', 'cccccccc-0000-0000-0000-000000000003', false);
select tests.assert(public.accept_invitations() = 1, 'invited staff joins on login');
select tests.assert((select count(*) from public.reservations) = 2, 'staff sees tenant reservations');
select tests.assert(tests.rows('update public.booking_settings set max_party_size = 2') = 0, 'staff cannot change settings');
select tests.assert(tests.rows('delete from public.reservations') = 0, 'staff cannot delete reservations');
select tests.assert(tests.rows($$update public.reservations set status = 'in_progress' where customer_name = 'Pedro'$$) = 1, 'staff can operate the agenda');
select tests.assert((select checked_in_at is not null from public.reservations where customer_name = 'Pedro'), 'check-in timestamp recorded');
select tests.assert((select count(*) from public.audit_logs) = 0, 'staff cannot read audit logs');

select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000001', false);
begin;
set constraints all immediate;
select tests.expect_error($$delete from public.tenant_members where role = 'owner'$$, 'proprietário', 'cannot remove the last owner');
rollback;
select tests.assert((select count(*) from public.get_team(:'tenant_a')) = 2, 'owner lists team with emails');
select tests.assert((select count(*) from public.audit_logs) > 0, 'config changes audited');

-- =====================================================================
\echo '== Public reschedule & cancel'
reset role; set role anon; select set_config('request.jwt.claim.sub', '', false);
select tests.assert((select count(*) from public.get_reschedule_slots(:'code1', '11988887777', :'tue')) = 4,
  'reschedule slots ignore own reservation (12:00..13:30 lunch)');
select tests.assert((public.reschedule_public_reservation(:'code1', '11988887777', :'slot_1330') ->> 'starts_at')::timestamptz = :'slot_1330'::timestamptz,
  'customer reschedules online');
select tests.assert((public.cancel_public_reservation(:'code1', '11988887777', 'Imprevisto') ->> 'status') = 'cancelled', 'customer cancels online');
select tests.expect_error(format('select public.cancel_public_reservation(%L, %L)', :'code1', '11988887777'), 'NOT_CANCELLABLE', 'cannot cancel twice');

reset role; set role authenticated; select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000001', false);
select tests.assert((select count(*) from public.reservation_events e join public.reservations r on r.id = e.reservation_id
                     where r.code = :'code1') = 3, 'full history: created → rescheduled → cancelled');
select tests.assert((select count(*) from public.notifications where channel = 'in_app') = 3, 'owner notified of new/rescheduled/cancelled');
select tests.assert((select cancel_reason from public.reservations where code = :'code1') = 'Imprevisto', 'cancel reason stored');

-- outbound channels are queued only when enabled (dispatcher sends them)
update public.notification_settings set email_enabled = true, whatsapp_enabled = true;
insert into public.reservations (tenant_id, customer_name, customer_phone, customer_email, starts_at, status)
values (:'tenant_a', 'Rita', '11944443333', 'rita@x.com', :'slot_12'::timestamptz + interval '7 days', 'confirmed');
select tests.assert((select count(*) from public.notifications n join public.reservations r on r.id = n.reservation_id
                     where r.customer_name = 'Rita' and n.channel in ('email', 'whatsapp') and n.status = 'pending') = 4,
  'confirmation + reminder queued for email and WhatsApp');
update public.reservations set starts_at = starts_at + interval '30 minutes' where customer_name = 'Rita';
select tests.assert((select count(*) from public.notifications n join public.reservations r on r.id = n.reservation_id
                     where r.customer_name = 'Rita' and n.template = 'reminder' and n.status = 'pending') = 2,
  'reschedule replaces pending reminders (one per channel)');

-- =====================================================================
\echo '== Analytics'
select tests.assert((public.dashboard_metrics(:'tenant_a', :'tue', :'tue') -> 'totals' ->> 'reservations')::int = 2, 'dashboard counts reservations in period');
select tests.assert((public.dashboard_metrics(:'tenant_a', :'tue', :'tue') -> 'totals' ->> 'cancelled')::int = 1, 'dashboard counts cancellations');
select tests.assert((public.dashboard_metrics(:'tenant_a', :'tue', :'tue') ->> 'occupancy') is not null, 'occupancy computed when capacity set');
select tests.assert((public.customer_insights(:'tenant_a') ->> 'total')::int = 3, 'CRM insights');
select tests.assert((select count(*) from public.customer_stats) = 3, 'customer_stats visible to member');
delete from public.customers where name = 'Pedro';
select tests.assert((select count(*) from public.customers where name = 'Pedro') = 0, 'CRM deletion (LGPD) is not undone by reservation trigger');
select tests.assert((select customer_id is null from public.reservations where customer_name = 'Pedro'), 'reservation kept, unlinked from deleted customer');

select set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-0000-0000-000000000002', false);
select tests.assert((select count(*) from public.customer_stats) = 0, 'customer_stats isolated per tenant (security_invoker)');
select tests.assert((select count(*) from public.notifications) = 0, 'notifications isolated per tenant');
select tests.assert((select count(*) from public.reservation_events) = 0, 'history isolated per tenant');
select tests.expect_error(format($$insert into public.reservations (tenant_id, customer_id, customer_name, customer_phone, starts_at)
  values (%L, %L, 'x', '11933332222', now() + interval '2 days')$$, :'tenant_b', :'cust_a'),
  '23503', 'composite FK: cannot reference another tenant customer');

\echo '== Settings RPCs'
select tests.expect_error(format($$select public.save_business_hours(%L, '[{"weekday":1,"opens_at":"09:00","closes_at":"18:00"}]')$$, :'tenant_a'),
  '42501', 'Bruno cannot replace Ana hours');
select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000001', false);
select tests.expect_error(format($$select public.save_business_hours(%L, '[{"weekday":1,"opens_at":"09:00","closes_at":"18:00"},{"weekday":1,"opens_at":"17:00","closes_at":"20:00"}]')$$, :'tenant_a'),
  'HOURS_OVERLAP', 'overlapping shifts rejected atomically');
select tests.assert((select count(*) from public.business_hours) = 11, 'failed save leaves schedule untouched');
select tests.assert(public.save_business_hours(:'tenant_a', '[{"weekday":1,"opens_at":"09:00","closes_at":"18:00"},{"weekday":2,"opens_at":"09:00","closes_at":"18:00"}]') = 2,
  'owner replaces weekly schedule');

reset role;
\echo 'SQL SUITE PASSED'
