-- Read-only access to the security log for active, unlocked AAL2 Super Admins.
-- The existing restrictive "Admin MFA boundary" policy remains in place.
-- Apply to Production only after separate approval and a renewed precheck.
begin;

drop policy if exists "AAL2 Super Admins read spoof attempts"
  on public.spoof_attempts;

create policy "AAL2 Super Admins read spoof attempts"
  on public.spoof_attempts as permissive
  for select to authenticated
  using ((select app_private.is_active_super_admin()));

commit;
