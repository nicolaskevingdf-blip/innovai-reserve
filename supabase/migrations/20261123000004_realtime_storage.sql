-- =====================================================================
-- INNOVAI RESERVE — Realtime + Storage (Supabase specific, guarded so the
-- migration also runs on plain Postgres for local tests)
-- =====================================================================

-- Realtime: agenda & notifications update live in the dashboard.
-- Realtime respects RLS, so each tenant only receives its own rows.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.reservations;
    alter publication supabase_realtime add table public.notifications;
    alter publication supabase_realtime add table public.schedule_blocks;
  end if;
end $$;

-- Storage: one public bucket for brand assets. Files must live under
-- "<tenant_id>/..." and only owners/managers of that tenant can write.
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('tenant-assets', 'tenant-assets', true, 5242880,
            array['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'])
    on conflict (id) do nothing;

    execute $p$
      create policy "tenant assets public read" on storage.objects for select
      using (bucket_id = 'tenant-assets')
    $p$;
    execute $p$
      create policy "tenant assets managers write" on storage.objects for insert to authenticated
      with check (bucket_id = 'tenant-assets'
                  and public.can_manage(((storage.foldername(name))[1])::uuid))
    $p$;
    execute $p$
      create policy "tenant assets managers update" on storage.objects for update to authenticated
      using (bucket_id = 'tenant-assets' and public.can_manage(((storage.foldername(name))[1])::uuid))
    $p$;
    execute $p$
      create policy "tenant assets managers delete" on storage.objects for delete to authenticated
      using (bucket_id = 'tenant-assets' and public.can_manage(((storage.foldername(name))[1])::uuid))
    $p$;
  end if;
end $$;
