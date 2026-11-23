-- =====================================================================
-- INNOVAI RESERVE — 06 · Notification dispatch
-- Used by the notification-dispatcher Edge Function with the service_role
-- key — never by browsers.
-- =====================================================================

-- Atomically claims due messages; SKIP LOCKED lets several workers run safely.
create or replace function public.claim_due_notifications(p_limit integer default 50)
returns setof public.notifications
language sql volatile security definer set search_path = public as $$
  update public.notifications n
     set attempts = n.attempts + 1
   where n.id in (
     select id from public.notifications
      where status = 'pending' and channel <> 'in_app' and scheduled_for <= now() and attempts < 5
      order by scheduled_for
      limit greatest(1, least(p_limit, 500))
      for update skip locked)
  returning n.*
$$;

create or replace function public.complete_notification(p_id uuid, p_status public.notification_status, p_error text default null)
returns void
language sql volatile security definer set search_path = public as $$
  update public.notifications
     set status = case when p_status = 'failed' and attempts < 5 then 'pending'::public.notification_status else p_status end,
         sent_at = case when p_status = 'sent' then now() else sent_at end,
         error = left(p_error, 1000),
         -- exponential backoff for retries
         scheduled_for = case when p_status = 'failed' then now() + make_interval(mins => power(2, attempts)::int) else scheduled_for end
   where id = p_id
$$;

