#!/usr/bin/env bash
# 15 visitors race for the last place in the same slot. Exactly one must win.
set -euo pipefail
PSQL="psql -h $WORK -p $PORT -U postgres -d postgres -qtAX"
SLOT=$($PSQL -c "select ((d::date + time '19:00') at time zone 'America/Sao_Paulo') from generate_series(current_date + 10, current_date + 17, interval '1 day') d where extract(dow from d) = 3 limit 1")
# self-contained setup: Wednesday dinner shift with capacity 1
$PSQL -c "delete from public.business_hours h using public.tenants t where t.id = h.tenant_id and t.slug = 'casa-ana' and h.weekday = 3"
$PSQL -c "insert into public.business_hours (tenant_id, weekday, opens_at, closes_at) select id, 3, '19:00', '23:00' from public.tenants where slug = 'casa-ana'"
$PSQL -c "update public.booking_settings s set max_reservations_per_slot = 1, max_guests_per_slot = null from public.tenants t where t.id = s.tenant_id and t.slug = 'casa-ana'"
RESULTS="$WORK/race"; mkdir -p "$RESULTS"
for i in $(seq 1 15); do
  ( $PSQL -c "set role anon; select public.create_public_reservation('casa-ana', '$SLOT', 2, 'Cliente $i', '1191234$(printf %04d $i)') ->> 'code'" \
      > "$RESULTS/$i.out" 2> "$RESULTS/$i.err" || true ) &
done
wait
OK=$( (grep -l . "$RESULTS"/*.out 2>/dev/null || true) | wc -l)
FULL=$( (grep -l "indispon" "$RESULTS"/*.err 2>/dev/null || true) | wc -l)
IN_DB=$($PSQL -c "select count(*) from public.reservations where starts_at = '$SLOT' and status <> 'cancelled'")
echo "winners=$OK rejected=$FULL rows_in_db=$IN_DB"
[ "$OK" = 1 ] && [ "$IN_DB" = 1 ] && [ "$FULL" = 14 ] || { echo "CONCURRENCY TEST FAILED"; cat "$RESULTS"/*.err | head; exit 1; }
echo "ok - 15 concurrent requests, exactly 1 reservation created"

# ---- table mode: 15 groups of 6 race for the only 6-seat table (V2) ----
SLOT2=$($PSQL -c "select ((d::date + time '12:00') at time zone 'America/Sao_Paulo') from generate_series(current_date + 10, current_date + 17, interval '1 day') d where extract(dow from d) = 4 limit 1")
R2="$WORK/race2"; mkdir -p "$R2"
for i in $(seq 1 15); do
  ( $PSQL -c "set role anon; select public.create_public_reservation('salao-teste', '$SLOT2', 6, 'Grupo $i', '1192345$(printf %04d $i)') ->> 'code'" \
      > "$R2/$i.out" 2> "$R2/$i.err" || true ) &
done
wait
OK2=$( (grep -l . "$R2"/*.out 2>/dev/null || true) | wc -l)
IN_DB2=$($PSQL -c "select count(*) from public.reservations r join public.tenants t on t.id = r.tenant_id where t.slug = 'salao-teste' and r.starts_at = '$SLOT2' and r.status <> 'cancelled'")
echo "table race: winners=$OK2 rows_in_db=$IN_DB2"
[ "$OK2" = 1 ] && [ "$IN_DB2" = 1 ] || { echo "TABLE CONCURRENCY TEST FAILED"; head "$R2"/*.err; exit 1; }
echo "ok - 15 concurrent groups, exactly 1 got the 6-seat table"

# ---- staff mode: 15 customers race for the only professional doing "Sobrancelha" ----
SLOT3=$($PSQL -c "select ((d::date + time '10:00') at time zone 'America/Sao_Paulo') from generate_series(current_date + 10, current_date + 17, interval '1 day') d where extract(dow from d) = 4 limit 1")
SOBR=$($PSQL -c "select s.id from public.services s join public.tenants t on t.id = s.tenant_id where t.slug = 'barba-teste' and s.name = 'Sobrancelha'")
R3="$WORK/race3"; mkdir -p "$R3"
for i in $(seq 1 15); do
  ( $PSQL -c "set role anon; select public.create_public_reservation('barba-teste', '$SLOT3', 1, 'Cliente $i', '1193456$(printf %04d $i)', null, null, '$SOBR') ->> 'code'" \
      > "$R3/$i.out" 2> "$R3/$i.err" || true ) &
done
wait
OK3=$( (grep -l . "$R3"/*.out 2>/dev/null || true) | wc -l)
IN_DB3=$($PSQL -c "select count(*) from public.reservations r join public.tenants t on t.id = r.tenant_id where t.slug = 'barba-teste' and r.starts_at = '$SLOT3' and r.status <> 'cancelled'")
echo "staff race: winners=$OK3 rows_in_db=$IN_DB3"
[ "$OK3" = 1 ] && [ "$IN_DB3" = 1 ] || { echo "STAFF CONCURRENCY TEST FAILED"; head "$R3"/*.err; exit 1; }
echo "ok - 15 concurrent customers, exactly 1 got the only qualified professional"
