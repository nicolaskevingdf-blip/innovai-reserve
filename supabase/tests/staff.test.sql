-- =====================================================================
-- Phase 3 — professionals & services (run after the previous suites)
-- =====================================================================
\set ON_ERROR_STOP 1
\echo '== Barbershop: setup'

select d::date as day
from generate_series((now() at time zone 'America/Sao_Paulo')::date + 2,
                     (now() at time zone 'America/Sao_Paulo')::date + 9, interval '1 day') d
where extract(dow from d) = 2 limit 1 \gset
create function tests.at(p_day date, p_time text) returns timestamptz language sql immutable as
  $$ select (p_day + p_time::time) at time zone 'America/Sao_Paulo' $$;
grant execute on function tests.at(date, text) to anon, authenticated;

set role authenticated;
select set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-0000-0000-000000000002', false);
select id as bt from public.create_tenant('Barbearia Teste', 'barba-teste', 'barbershop') \gset
update public.booking_settings set allocation_mode = 'staff', max_reservations_per_slot = null, slot_interval_min = 30
 where tenant_id = :'bt';

insert into public.staff (tenant_id, name, specialty, sort_order) values
  (:'bt', 'Rafa', 'Degradê', 0), (:'bt', 'Léo', 'Barba', 0);
insert into public.staff (tenant_id, name, is_active) values (:'bt', 'Inativo', false);
select id as rafa from public.staff where tenant_id = :'bt' and name = 'Rafa' \gset
select id as leo from public.staff where tenant_id = :'bt' and name = 'Léo' \gset
select id as inativo from public.staff where tenant_id = :'bt' and name = 'Inativo' \gset

insert into public.services (tenant_id, name, duration_min, buffer_min, price_cents) values
  (:'bt', 'Corte', 30, 10, 5000), (:'bt', 'Barba', 20, 0, 3500), (:'bt', 'Sobrancelha', 15, 0, 2000);
select id as corte from public.services where tenant_id = :'bt' and name = 'Corte' \gset
select id as barba from public.services where tenant_id = :'bt' and name = 'Barba' \gset
select id as sobr from public.services where tenant_id = :'bt' and name = 'Sobrancelha' \gset

-- Rafa: Mon–Fri 09–12 and 13–19 (lunch break); Corte + Barba
select public.save_staff_profile(:'rafa',
  (select jsonb_agg(x) from (select jsonb_build_object('weekday', d, 'opens_at', '09:00', 'closes_at', '12:00') x from generate_series(1, 5) d
                             union all select jsonb_build_object('weekday', d, 'opens_at', '13:00', 'closes_at', '19:00') from generate_series(1, 5) d) q),
  array[:'corte', :'barba']::uuid[]);
-- Léo: no individual hours (= establishment hours); Corte + Sobrancelha
select public.save_staff_profile(:'leo', '[]', array[:'corte', :'sobr']::uuid[]);
select tests.assert((select count(*) from public.staff_hours where staff_id = :'rafa') = 10, 'individual hours saved (with lunch break)');
select tests.expect_error(format($$select public.save_staff_profile(%L, '[{"weekday":1,"opens_at":"09:00","closes_at":"12:00"},{"weekday":1,"opens_at":"11:00","closes_at":"14:00"}]', '{}')$$, :'rafa'),
  'HOURS_OVERLAP', 'overlapping shifts for a professional rejected');

-- =====================================================================
\echo '== Availability by service and professional'
reset role; set role anon; select set_config('request.jwt.claim.sub', '', false);
select tests.assert(jsonb_array_length(public.get_public_page('barba-teste') -> 'staff') = 2, 'public page lists active professionals only');
select tests.assert((public.get_public_page('barba-teste') -> 'staff' -> 0 -> 'service_ids') is not null, 'professionals expose the services they perform');
select tests.assert((select count(*) from public.get_available_slots('barba-teste', :'day', 1)) = 0, 'staff mode: service must be chosen first');
select tests.assert(exists (select 1 from public.get_available_slots('barba-teste', :'day', 1, :'corte', null, :'rafa') where slot_start = tests.at(:'day', '11:30')),
  'Rafa: 11:30 Corte fits before lunch');
select tests.assert(not exists (select 1 from public.get_available_slots('barba-teste', :'day', 1, :'corte', null, :'rafa') where slot_start = tests.at(:'day', '12:00')),
  'Rafa: 12:00 blocked by lunch break');
select tests.assert(exists (select 1 from public.get_available_slots('barba-teste', :'day', 1, :'corte', null, :'leo') where slot_start = tests.at(:'day', '12:00')),
  'Léo (establishment hours) works at 12:00');
select tests.assert(not exists (select 1 from public.get_available_slots('barba-teste', :'day', 1, :'barba', null, :'leo')), 'Léo does not perform Barba → no slots');
select tests.assert((select count(*) from public.get_available_slots('barba-teste', :'day', 1, :'corte', null, :'inativo')) = 0, 'inactive professional has no slots');

-- =====================================================================
\echo '== Booking, clean-up interval, any professional'
select public.create_public_reservation('barba-teste', tests.at(:'day', '09:00'), 1, 'Cliente Rafa', '11950000001', null, null, :'corte', null, :'rafa') ->> 'code' as r1 \gset
reset role; set role authenticated; select set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-0000-0000-000000000002', false);
select tests.assert((select staff_id = :'rafa' and staff_requested and occupied_until = tests.at(:'day', '09:40') from public.reservations where code = :'r1'),
  'chosen professional kept; protected until 09:40 (30 min + 10 clean-up)');
reset role; set role anon; select set_config('request.jwt.claim.sub', '', false);
select tests.assert(not exists (select 1 from public.get_available_slots('barba-teste', :'day', 1, :'corte', null, :'rafa') where slot_start = tests.at(:'day', '09:30')),
  'clean-up interval respected (09:30 not offered for Rafa)');

select public.create_public_reservation('barba-teste', tests.at(:'day', '09:00'), 1, 'Qualquer Um', '11950000002', null, null, :'corte') ->> 'code' as r2 \gset
select tests.assert((public.get_public_reservation(:'r2', '11950000002') ->> 'staff_name') = 'Léo', '"any professional" → the free one (Léo)');
select tests.assert(not exists (select 1 from public.get_available_slots('barba-teste', :'day', 1, :'corte') where slot_start = tests.at(:'day', '09:00')),
  'both busy → 09:00 disappears for Corte');
select tests.expect_error(format('select public.create_public_reservation(%L, %L::timestamptz, 1, %L, %L, null, null, %L)', 'barba-teste', tests.at(:'day', '09:00'), 'Atrasado', '11950000003', :'corte'),
  'SLOT_UNAVAILABLE', 'no professional left → rejected at confirmation');

reset role; set role authenticated; select set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-0000-0000-000000000002', false);
insert into public.reservations (tenant_id, customer_name, customer_phone, starts_at, service_id, staff_id, staff_requested, status, source)
values (:'bt', 'Extra Rafa', '11950000004', tests.at(:'day', '14:00'), :'corte', :'rafa', true, 'confirmed', 'phone');
insert into public.reservations (tenant_id, customer_name, customer_phone, starts_at, service_id, status, source)
values (:'bt', 'Balanceado', '11950000005', tests.at(:'day', '11:00'), :'corte', 'confirmed', 'phone');
select tests.assert((select staff_id = :'leo' from public.reservations where customer_name = 'Balanceado'),
  'balanced agenda: "any" goes to who has fewer bookings that day (Léo 1 vs Rafa 2)');
select tests.expect_error(format($$insert into public.reservations (tenant_id, customer_name, customer_phone, starts_at, service_id, staff_id, status)
  values (%L, 'Choque', '11950000006', %L, %L, %L, 'confirmed')$$, :'bt', tests.at(:'day', '09:20'), :'corte', :'rafa'),
  'STAFF_BUSY', 'explicit busy professional rejected (overlaps clean-up)');
select tests.expect_error(format($$insert into public.reservations (tenant_id, customer_name, customer_phone, starts_at, service_id, status)
  values (%L, 'Sem Ninguém', '11950000007', %L, %L, 'confirmed')$$, :'bt', tests.at(:'day', '09:10'), :'corte'),
  'NO_STAFF', 'nobody free → manual booking rejected');

-- day off / block for one professional only
insert into public.schedule_blocks (tenant_id, staff_id, starts_at, ends_at, reason)
values (:'bt', :'leo', tests.at(:'day', '15:00'), tests.at(:'day', '16:00'), 'Médico');
reset role; set role anon; select set_config('request.jwt.claim.sub', '', false);
select tests.assert(not exists (select 1 from public.get_available_slots('barba-teste', :'day', 1, :'sobr') where slot_start = tests.at(:'day', '15:00')),
  'professional block removes their services (Sobrancelha only Léo)');
select tests.assert(exists (select 1 from public.get_available_slots('barba-teste', :'day', 1, :'corte') where slot_start = tests.at(:'day', '15:00')),
  'other professionals keep the slot (Rafa at 15:00)');

-- =====================================================================
\echo '== Reschedule keeps the chosen professional'
select tests.assert(not exists (select 1 from public.get_reschedule_slots(:'r1', '11950000001', :'day') where slot_start = tests.at(:'day', '12:00')),
  'requested professional: reschedule only offers Rafa''s hours (no 12:00)');
select tests.assert(exists (select 1 from public.get_reschedule_slots(:'r2', '11950000002', :'day') where slot_start = tests.at(:'day', '12:00')),
  '"any professional": reschedule offers everyone''s hours');
select tests.assert((public.reschedule_public_reservation(:'r1', '11950000001', tests.at(:'day', '16:00')) ->> 'staff_name') = 'Rafa', 'rescheduled with Rafa');

-- =====================================================================
\echo '== Metrics, tools, isolation'
reset role; set role authenticated; select set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-0000-0000-000000000002', false);
select tests.assert(jsonb_array_length(public.staff_service_metrics(:'bt', :'day', :'day') -> 'by_staff') = 3, 'metrics per professional');
select tests.assert((public.staff_service_metrics(:'bt', :'day', :'day') -> 'by_service' -> 0 ->> 'name') = 'Corte', 'most booked service = Corte');
select tests.assert((public.staff_service_metrics(:'bt', :'day', :'day') ->> 'occupancy')::numeric > 0, 'agenda occupancy computed from working hours');
select tests.assert((select array_agg(staff_id) filter (where is_free) from public.get_free_staff(:'bt', tests.at(:'day', '09:00'), tests.at(:'day', '09:30'), :'corte')) = array[:'rafa'::uuid],
  'free-staff tool: after the reschedule only Rafa is free at 09:00');
select tests.assert((select bool_and(is_working) from public.get_free_staff(:'bt', tests.at(:'day', '10:00'), tests.at(:'day', '10:30'), :'corte')), 'free-staff tool reports working hours');
select tests.assert((select count(*) from public.reservation_events e join public.reservations r on r.id = e.reservation_id where r.code = :'r1') >= 2, 'history kept');

select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000001', false);
select tests.assert((select count(*) from public.staff where tenant_id = :'bt') = 0, 'other tenant cannot see professionals');
select tests.assert((select count(*) from public.services where tenant_id = :'bt') = 0, 'other tenant cannot see services');
select tests.expect_error(format('select * from public.get_free_staff(%L, now(), now())', :'bt'), '42501', 'other tenant cannot query free professionals');
select tests.expect_error(format($$select public.save_staff_profile(%L, '[]', '{}')$$, :'rafa'), '42501', 'other tenant cannot edit a professional');
select tests.expect_error(format('select public.staff_service_metrics(%L, current_date, current_date)', :'bt'), '42501', 'other tenant cannot read staff metrics');
select tests.assert(tests.rows(format('update public.staff set name = %L where id = %L', 'x', :'rafa')) = 0, 'other tenant cannot update a professional');
select tests.expect_error($$select public._find_staff(gen_random_uuid(), null, now(), now(), now())$$, '42501', 'staff allocation helper not callable from the API');

reset role;
\echo 'STAFF SUITE PASSED'
