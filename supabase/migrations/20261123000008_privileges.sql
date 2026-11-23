-- =====================================================================
-- INNOVAI RESERVE — 08 · Function privileges
-- Supabase grants EXECUTE to anon/authenticated by default. Everything is
-- revoked here and re-granted explicitly, so internal helpers (e.g.
-- _compute_slots, _find_staff, _enqueue_customer_message) can never be
-- called directly from the API.
-- =====================================================================
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
  end loop;
end $$;

-- Public booking (no login)
grant execute on function
  public.slug_available(text),
  public.get_public_page(text),
  public.get_available_slots(text, date, integer, uuid, uuid, uuid),
  public.get_available_days(text, date, date, integer, uuid, uuid, uuid),
  public.create_public_reservation(text, timestamptz, integer, text, text, text, text, uuid, uuid, uuid),
  public.join_waitlist(text, date, time, integer, text, text, text, text, uuid),
  public.get_public_reservation(text, text),
  public.cancel_public_reservation(text, text, text),
  public.get_reschedule_slots(text, text, date),
  public.reschedule_public_reservation(text, text, timestamptz)
to anon, authenticated;

-- Panel (each function checks membership / role itself)
grant execute on function
  public.create_tenant(text, text, public.segment_type, text, text),
  public.accept_invitations(),
  public.get_team(uuid),
  public.get_tenant_slots(uuid, date, integer, integer, uuid, uuid, uuid, uuid),
  public.get_free_tables(uuid, timestamptz, timestamptz, uuid),
  public.get_free_staff(uuid, timestamptz, timestamptz, uuid, uuid),
  public.save_business_hours(uuid, jsonb),
  public.save_floor_layout(uuid, jsonb),
  public.save_staff_profile(uuid, jsonb, uuid[]),
  public.notify_waitlist_entry(uuid),
  public.dashboard_metrics(uuid, date, date),
  public.customer_insights(uuid),
  public.floor_occupancy(uuid, date, date),
  public.staff_service_metrics(uuid, date, date),
  public.get_plan_usage(uuid),
  -- Innovai admin panel (checks platform_admins)
  public.admin_overview(),
  public.admin_list_tenants(text, text),
  public.admin_update_tenant(uuid, public.tenant_status, text, public.subscription_status, timestamptz, timestamptz, jsonb, text, text),
  public.admin_create_tenant(text, text, public.segment_type, text, text, integer, text),
  public.admin_list_tickets(text),
  -- evaluated in RLS policies, checks, defaults and invoker triggers
  public.is_platform_admin(), public.tenant_role(uuid), public.is_member(uuid), public.is_manager(uuid),
  public.is_owner(uuid), public.can_write(uuid), public.can_manage(uuid), public.shares_tenant_with(uuid),
  public.normalize_phone(text), public.is_valid_timezone(text), public.gen_reservation_code()
to authenticated;

-- Server-side jobs (Edge Functions / pg_cron)
grant execute on function
  public.claim_due_notifications(integer),
  public.complete_notification(uuid, public.notification_status, text),
  public.refresh_subscription_states()
to service_role;

-- Tables written only by triggers stay read-only for clients
revoke insert, update, delete on public.reservation_events, public.reservation_tables, public.audit_logs from authenticated;
revoke update, delete on public.support_messages from authenticated;
revoke delete on public.support_tickets from authenticated;

-- Column-level write access where a policy only allows a narrow action
revoke update on public.notifications from authenticated;
grant update (read_at) on public.notifications to authenticated;        -- mark as read
revoke update on public.support_tickets from authenticated;
grant update (status, priority, updated_at) on public.support_tickets to authenticated;
