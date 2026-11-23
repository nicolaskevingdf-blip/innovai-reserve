-- Atomic replacement of the weekly schedule (validates overlaps in one transaction)
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

revoke execute on function public.save_business_hours(uuid, jsonb) from public, anon;
grant execute on function public.save_business_hours(uuid, jsonb) to authenticated;
