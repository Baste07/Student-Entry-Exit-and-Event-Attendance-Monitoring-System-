-- Admin browser inactivity preference. Apply after 20260930_admin_totp_mfa.sql.
-- The database boundary is authoritative; browser timers are only a UX safeguard.
begin;

alter table public.system_settings
  drop constraint if exists admin_inactivity_timeout_minutes_valid;
alter table public.system_settings
  add constraint admin_inactivity_timeout_minutes_valid
  check (key <> 'admin_inactivity_timeout_minutes'
         or value ~ '^([3-9]|[1-9][0-9]+)$');

insert into public.system_settings (key, value)
values ('admin_inactivity_timeout_minutes', '3')
on conflict (key) do nothing;

-- Keep the existing anonymous visibility of legacy system capabilities only.
-- This new setting is readable by active AAL2 Admins and Super Admins.
drop policy if exists "Anonymous legacy system capability boundary" on public.system_settings;
create policy "Anonymous legacy system capability boundary" on public.system_settings
  as restrictive for select to anon
  using (key in ('sms_enabled', 'anti_spoof_enabled', 'school_year_end_month_day'));
drop policy if exists "AAL2 admins read inactivity timeout" on public.system_settings;
create policy "AAL2 admins read inactivity timeout" on public.system_settings
  for select to authenticated
  using (key = 'admin_inactivity_timeout_minutes'
         and (select app_private.is_active_admin_aal2()));

-- Replace only the system-settings write policies. Their key allowlist remains
-- restrictive even if an older permissive policy is present in the database.
drop policy if exists "Super admins insert system capabilities" on public.system_settings;
drop policy if exists "Super admins update system capabilities" on public.system_settings;
drop policy if exists "System capability insert boundary" on public.system_settings;
drop policy if exists "System capability update boundary" on public.system_settings;

create policy "Super admins insert system capabilities" on public.system_settings
  for insert to authenticated with check (
    key in ('sms_enabled', 'anti_spoof_enabled', 'school_year_end_month_day',
            'admin_inactivity_timeout_minutes')
    and (select app_private.is_active_super_admin()));
create policy "Super admins update system capabilities" on public.system_settings
  for update to authenticated
  using (key in ('sms_enabled', 'anti_spoof_enabled', 'school_year_end_month_day',
                'admin_inactivity_timeout_minutes')
         and (select app_private.is_active_super_admin()))
  with check (key in ('sms_enabled', 'anti_spoof_enabled', 'school_year_end_month_day',
                     'admin_inactivity_timeout_minutes')
              and (select app_private.is_active_super_admin()));
create policy "System capability insert boundary" on public.system_settings
  as restrictive for insert to authenticated with check (
    key in ('sms_enabled', 'anti_spoof_enabled', 'school_year_end_month_day',
            'admin_inactivity_timeout_minutes')
    and (select app_private.is_active_super_admin()));
create policy "System capability update boundary" on public.system_settings
  as restrictive for update to authenticated
  using (key in ('sms_enabled', 'anti_spoof_enabled', 'school_year_end_month_day',
                'admin_inactivity_timeout_minutes')
         and (select app_private.is_active_super_admin()))
  with check (key in ('sms_enabled', 'anti_spoof_enabled', 'school_year_end_month_day',
                     'admin_inactivity_timeout_minutes')
              and (select app_private.is_active_super_admin()));

commit;
