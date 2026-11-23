-- =====================================================================
-- Phase 2 — restaurant module tests (run after rls_and_booking.test.sql)
-- =====================================================================
\set ON_ERROR_STOP 1
\echo '== Restaurant: setup'

select d::date as tue
from generate_series((now() at time zone 'America/Sao_Paulo')::date + 2,
                     (now() at time zone 'America/Sao_Paulo')::date + 9, interval '1 day') d
where extract(dow from d) = 3 limit 1 \gset
select ((:'tue'::date + time '12:00') at time zone 'America/Sao_Paulo') as t12,
       ((:'tue'::date + time '13:30') at time zone 'America/Sao_Paulo') as t1330,
       ((:'tue'::date + time '19:00') at time zone 'America/Sao_Paulo') as t19,
       ((:'tue'::date + time '20:30') at time zone 'America/Sao_Paulo') as t2030 \gset

set role authenticated;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000001', false);
select id as rt from public.create_tenant('Salão Teste', 'salao-teste', 'restaurant') \gset
update public.booking_settings set allocation_mode = 'tables', max_reservations_per_slot = null, max_guests_per_slot = null
 where tenant_id = :'rt';

insert into public.areas (tenant_id, name, sort_order) values (:'rt', 'Salão', 1), (:'rt', 'Varanda', 2);
select id as salao from public.areas where tenant_id = :'rt' and name = 'Salão' \gset
select id as varanda from public.areas where tenant_id = :'rt' and name = 'Varanda' \gset
insert into public.dining_tables (tenant_id, area_id, name, min_capacity, max_capacity) values
  (:'rt', :'salao', 'T1', 1, 2), (:'rt', :'salao', 'T2', 1, 2), (:'rt', :'salao', 'T3', 1, 4),
  (:'rt', :'varanda', 'V1', 1, 4), (:'rt', :'varanda', 'V2', 3, 6);
select id as t1 from public.dining_tables where tenant_id = :'rt' and name = 'T1' \gset
select id as t2 from public.dining_tables where tenant_id = :'rt' and name = 'T2' \gset
select id as t3 from public.dining_tables where tenant_id = :'rt' and name = 'T3' \gset
select id as v1 from public.dining_tables where tenant_id = :'rt' and name = 'V1' \gset
select id as v2 from public.dining_tables where tenant_id = :'rt' and name = 'V2' \gset

-- =====================================================================
\echo '== Best-fit allocation'
reset role; set role anon; select set_config('request.jwt.claim.sub', '', false);
select tests.assert(jsonb_array_length(public.get_public_page('salao-teste') -> 'areas') = 2, 'public page lists ambientes in table mode');
select tests.assert((select count(*) from public.get_available_slots('salao-teste', :'tue', 2)) = 10, 'slots available when tables are free');
select tests.assert((select count(*) from public.get_available_slots('salao-teste', :'tue', 7)) = 0, 'no table/combination for 7 → no slots');

select public.create_public_reservation('salao-teste', :'t12', 6, 'Grupo Seis', '11910000006') ->> 'code' as c6 \gset
select public.create_public_reservation('salao-teste', :'t12', 2, 'Casal Um', '11910000001') ->> 'code' as c1 \gset
select public.create_public_reservation('salao-teste', :'t12', 2, 'Casal Dois', '11910000002') ->> 'code' as c2 \gset
select public.create_public_reservation('salao-teste', :'t12', 3, 'Trio', '11910000003') ->> 'code' as c3 \gset
select public.create_public_reservation('salao-teste', :'t12', 4, 'Quarteto', '11910000004', null, null, null, :'varanda') ->> 'code' as c4 \gset

reset role; set role authenticated; select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000001', false);
select tests.assert((select table_ids = array[:'v2'::uuid] from public.reservations where code = :'c6'), 'party 6 → V2 (only table seating 6)');
select tests.assert((select table_ids = array[:'t1'::uuid] from public.reservations where code = :'c1'), 'party 2 → smallest table T1');
select tests.assert((select table_ids = array[:'t2'::uuid] from public.reservations where code = :'c2'), 'next party 2 → T2');
select tests.assert((select table_ids = array[:'t3'::uuid] from public.reservations where code = :'c3'), 'party 3 → T3 (4 seats)');
select tests.assert((select table_ids = array[:'v1'::uuid] and area_id = :'varanda' from public.reservations where code = :'c4'), 'preferred Varanda → V1');
select tests.assert((select count(*) from public.reservation_tables where tenant_id = :'rt' and active) = 5, 'table occupancy mirrored');

reset role; set role anon; select set_config('request.jwt.claim.sub', '', false);
select tests.assert(not exists (select 1 from public.get_available_slots('salao-teste', :'tue', 2) where slot_start = :'t12'), 'every table taken → 12:00 disappears');
select tests.assert(exists (select 1 from public.get_available_slots('salao-teste', :'tue', 2) where slot_start = :'t1330'), '13:30 still free (tables released)');
select tests.expect_error(format('select public.create_public_reservation(%L, %L::timestamptz, 2, %L, %L)', 'salao-teste', :'t12', 'Atrasado', '11910000009'),
  'SLOT_UNAVAILABLE', 'no table left → rejected at confirmation');

-- =====================================================================
\echo '== Manual choice, joined tables, area'
reset role; set role authenticated; select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000001', false);
select tests.expect_error(format($$insert into public.reservations (tenant_id, customer_name, customer_phone, starts_at, party_size, table_ids)
  values (%L, 'Furão', '11920000000', %L, 2, array[%L]::uuid[])$$, :'rt', :'t12', :'t1'), 'TABLE_TAKEN', 'manual pick of an occupied table rejected');
select tests.expect_error(format($$insert into public.reservations (tenant_id, customer_name, customer_phone, starts_at, party_size)
  values (%L, 'Sem Mesa', '11920000001', %L, 2)$$, :'rt', :'t12'), 'NO_TABLE', 'manual booking without free table rejected');
select tests.expect_error($$insert into public.reservation_tables (reservation_id, tenant_id, table_id, period) values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), tstzrange(now(), now() + interval '1h'))$$,
  '42501', 'occupancy table is read-only for clients');

insert into public.table_combinations (tenant_id, name, table_ids, min_capacity, max_capacity)
values (:'rt', 'T1 + T2', array[:'t1', :'t2']::uuid[], 3, 4);
-- 19:00: staff occupies T3, V1, V2 explicitly; a party of 4 must get the joined T1+T2
insert into public.reservations (tenant_id, customer_name, customer_phone, starts_at, party_size, table_ids, status, source) values
  (:'rt', 'Mesa T3', '11930000003', :'t19', 4, array[:'t3']::uuid[], 'confirmed', 'phone'),
  (:'rt', 'Mesa V1', '11930000004', :'t19', 4, array[:'v1']::uuid[], 'confirmed', 'phone'),
  (:'rt', 'Mesa V2', '11930000005', :'t19', 5, array[:'v2']::uuid[], 'confirmed', 'phone');
insert into public.reservations (tenant_id, customer_name, customer_phone, starts_at, party_size, status, source)
values (:'rt', 'Família Junta', '11930000006', :'t19', 4, 'confirmed', 'phone');
select tests.assert((select table_ids @> array[:'t1', :'t2']::uuid[] and cardinality(table_ids) = 2 from public.reservations where customer_name = 'Família Junta'),
  'party 4 with all 4-seaters busy → joined tables T1+T2');
select tests.assert((select table_id = :'t1' from public.reservations where customer_name = 'Família Junta'), 'primary table set');
select tests.expect_error(format($$insert into public.reservations (tenant_id, customer_name, customer_phone, starts_at, party_size, table_ids)
  values (%L, 'Invasor', '11930000007', %L, 2, array[%L]::uuid[])$$, :'rt', :'t19', :'t2'), 'TABLE_TAKEN', 'a table inside a join is also blocked');

-- =====================================================================
\echo '== Reschedule & cancellation'
update public.reservations set starts_at = :'t1330' where code = :'c1';
select tests.assert((select table_ids = array[:'t1'::uuid] from public.reservations where code = :'c1'), 'reschedule keeps table when still free');
update public.reservations set starts_at = :'t1330' where code = :'c2';
select tests.expect_error(format($$update public.reservations set starts_at = %L where code = %L$$, :'t19', :'c3'),
  'NO_TABLE', 'reschedule into a full time is rejected');
update public.reservations set party_size = 4 where code = :'c1';
select tests.assert((select table_ids <> array[:'t1'::uuid] and table_ids is not null from public.reservations where code = :'c1'),
  'group grew beyond its table → reallocated');
select tests.assert((select count(*) from public.reservation_events e join public.reservations r on r.id = e.reservation_id
                     where r.code = :'c1' and e.action in ('rescheduled', 'updated')) >= 2, 'moves recorded in history');

-- waitlist for that day, then a cancellation hints the team
reset role; set role anon; select set_config('request.jwt.claim.sub', '', false);
select (public.join_waitlist('salao-teste', :'tue', '12:00', 6, 'Esperando Seis', '11940000006') ->> 'position')::int as pos \gset
select tests.assert(:pos = 1, 'customer joins waitlist (position 1)');
select tests.expect_error(format('select public.join_waitlist(%L, %L::date, %L::time, 2, %L, %L)', 'salao-teste', :'tue', '12:00', 'Esperando Seis', '(11) 94000-0006'),
  'ALREADY_WAITING', 'same phone cannot queue twice for the same day');
select tests.expect_error('select * from public.waitlist_entries', '42501', 'anon cannot read waitlist');

select public.cancel_public_reservation(:'c6', '11910000006') ->> 'status' as st \gset
select tests.assert(:'st' = 'cancelled', 'customer cancels the 6-seat reservation');
select tests.assert(exists (select 1 from public.get_available_slots('salao-teste', :'tue', 6) where slot_start = :'t12'), 'freed V2 is bookable again for 6');

reset role; set role authenticated; select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000001', false);
select tests.assert((select count(*) from public.reservation_tables rt join public.reservations r on r.id = rt.reservation_id
                     where r.code = :'c6' and rt.active) = 0, 'cancelled reservation releases its table');
select tests.assert(exists (select 1 from public.notifications where tenant_id = :'rt' and template = 'staff_waitlist_slot'), 'team told a slot opened for the waitlist');
select tests.assert(exists (select 1 from public.notifications where tenant_id = :'rt' and template = 'staff_waitlist_new'), 'team told about new waitlist entry');
select id as wid from public.waitlist_entries where tenant_id = :'rt' limit 1 \gset
select tests.assert((public.notify_waitlist_entry(:'wid') ->> 'message') like 'Olá, Esperando!%', 'staff notifies waitlist customer');
select tests.assert((select status from public.waitlist_entries where id = :'wid') = 'notified', 'waitlist entry marked notified');

-- =====================================================================
\echo '== Floor tools, metrics, guards'
select tests.assert((select count(*) from public.get_free_tables(:'rt', :'t19', :'t19'::timestamptz + interval '90 minutes')) = 5, 'free-table map returns every table');
select tests.assert((select count(*) filter (where is_free) from public.get_free_tables(:'rt', :'t19', :'t19'::timestamptz + interval '90 minutes')) = 0,
  'at 19:00 the whole floor is taken');
select tests.assert(public.floor_occupancy(:'rt', :'tue', :'tue') > 0, 'floor occupancy computed from table-minutes');
select tests.assert(public.save_floor_layout(:'rt', jsonb_build_array(jsonb_build_object('id', :'t1', 'pos_x', 120, 'pos_y', 80))) = 1, 'layout saved');
select tests.expect_error(format('delete from public.dining_tables where id = %L', :'t3'), 'TABLE_IN_USE', 'table with upcoming reservations cannot be deleted');

select set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-0000-0000-000000000002', false);
select tests.assert((select count(*) from public.dining_tables where tenant_id = :'rt') = 0, 'other tenant cannot see tables');
select tests.assert((select count(*) from public.table_combinations where tenant_id = :'rt') = 0, 'other tenant cannot see joined tables');
select tests.assert((select count(*) from public.reservation_tables where tenant_id = :'rt') = 0, 'other tenant cannot see occupancy');
select tests.expect_error(format('select * from public.get_free_tables(%L, now(), now() + interval %L)', :'rt', '1 hour'), '42501', 'other tenant cannot query free tables');
select tests.expect_error(format('select public.notify_waitlist_entry(%L)', :'wid'), '42501', 'other tenant cannot notify waitlist');
select tests.expect_error(format('select public.save_floor_layout(%L, %L::jsonb)', :'rt', '[]'), '42501', 'other tenant cannot edit layout');
select tests.expect_error(format($$insert into public.table_combinations (tenant_id, name, table_ids, max_capacity) values (%L, 'x', array[%L, %L]::uuid[], 4)$$,
  :'rt', :'t1', :'t2'), '42501', 'other tenant cannot create joins');
select tests.expect_error($$select public._find_tables(gen_random_uuid(), now(), now(), 2)$$, '42501', 'allocation helper not callable from the API');

reset role;
\echo 'RESTAURANT SUITE PASSED'
