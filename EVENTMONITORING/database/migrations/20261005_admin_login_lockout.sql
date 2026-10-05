-- Persistent Admin password-failure lockout. Apply after the Admin MFA boundary,
-- last-Super-Admin guard, and Admin inactivity setting migrations.
-- This migration never changes an existing Admin's role, status, Auth identity,
-- factor, or password. Keep the service-role RPCs off the browser.
begin;

alter table public.admins
  add column if not exists failed_login_attempts integer not null default 0,
  add column if not exists login_locked boolean not null default false,
  add column if not exists login_locked_at timestamptz,
  add column if not exists login_unlocked_at timestamptz,
  add column if not exists login_unlocked_by uuid;
alter table public.admins drop constraint if exists admins_failed_login_attempts_nonnegative;
alter table public.admins add constraint admins_failed_login_attempts_nonnegative
  check (failed_login_attempts >= 0);
alter table public.admins drop constraint if exists admins_login_lock_timestamp_consistent;
alter table public.admins add constraint admins_login_lock_timestamp_consistent
  check ((login_locked and login_locked_at is not null)
         or (not login_locked and login_locked_at is null));

-- The User Management page can read state, but no browser role may write it.
grant select (failed_login_attempts, login_locked, login_locked_at,
              login_unlocked_at, login_unlocked_by)
  on table public.admins to authenticated;
revoke update (failed_login_attempts, login_locked, login_locked_at,
               login_unlocked_at, login_unlocked_by)
  on table public.admins from public, anon, authenticated;

alter table public.system_settings
  drop constraint if exists admin_login_max_attempts_valid;
alter table public.system_settings
  add constraint admin_login_max_attempts_valid
  check (key <> 'admin_login_max_attempts' or value ~ '^[3-6]$');
insert into public.system_settings (key, value)
values ('admin_login_max_attempts', '3')
on conflict (key) do nothing;

-- Only signed-in AAL2 Admins see this security preference. Existing anonymous
-- legacy capability reads and the inactivity preference remain unchanged.
drop policy if exists "AAL2 admins read login attempt limit" on public.system_settings;
create policy "AAL2 admins read login attempt limit" on public.system_settings
  for select to authenticated
  using (key = 'admin_login_max_attempts'
         and (select app_private.is_active_admin_aal2()));

drop policy if exists "Super admins insert system capabilities" on public.system_settings;
drop policy if exists "Super admins update system capabilities" on public.system_settings;
drop policy if exists "System capability insert boundary" on public.system_settings;
drop policy if exists "System capability update boundary" on public.system_settings;

create policy "Super admins insert system capabilities" on public.system_settings
  for insert to authenticated with check (
    key in ('sms_enabled', 'anti_spoof_enabled', 'school_year_end_month_day',
            'admin_inactivity_timeout_minutes', 'admin_login_max_attempts')
    and (select app_private.is_active_super_admin()));
create policy "Super admins update system capabilities" on public.system_settings
  for update to authenticated
  using (key in ('sms_enabled', 'anti_spoof_enabled', 'school_year_end_month_day',
                'admin_inactivity_timeout_minutes', 'admin_login_max_attempts')
         and (select app_private.is_active_super_admin()))
  with check (key in ('sms_enabled', 'anti_spoof_enabled', 'school_year_end_month_day',
                     'admin_inactivity_timeout_minutes', 'admin_login_max_attempts')
              and (select app_private.is_active_super_admin()));
create policy "System capability insert boundary" on public.system_settings
  as restrictive for insert to authenticated with check (
    key in ('sms_enabled', 'anti_spoof_enabled', 'school_year_end_month_day',
            'admin_inactivity_timeout_minutes', 'admin_login_max_attempts')
    and (select app_private.is_active_super_admin()));
create policy "System capability update boundary" on public.system_settings
  as restrictive for update to authenticated
  using (key in ('sms_enabled', 'anti_spoof_enabled', 'school_year_end_month_day',
                'admin_inactivity_timeout_minutes', 'admin_login_max_attempts')
         and (select app_private.is_active_super_admin()))
  with check (key in ('sms_enabled', 'anti_spoof_enabled', 'school_year_end_month_day',
                     'admin_inactivity_timeout_minutes', 'admin_login_max_attempts')
              and (select app_private.is_active_super_admin()));

-- A user who obtains a Supabase Auth session directly still cannot use RLS-
-- protected Admin data or Super Admin settings while the profile is locked.
create or replace function app_private.is_active_admin_aal2()
returns boolean language sql stable security definer set search_path = '' as $$
  select (select auth.jwt()->>'aal') = 'aal2' and exists (
    select 1 from public.admins where admin_id = (select auth.uid())
      and admin_level in ('admin', 'super_admin')
      and status = 'active' and not login_locked);
$$;
alter function app_private.is_active_admin_aal2() owner to postgres;
revoke all on function app_private.is_active_admin_aal2() from public, anon, authenticated;
grant execute on function app_private.is_active_admin_aal2() to authenticated;

create or replace function app_private.is_active_super_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select (select auth.jwt()->>'aal') = 'aal2' and exists (
    select 1 from public.admins where admin_id = (select auth.uid())
      and admin_level = 'super_admin' and status = 'active' and not login_locked);
$$;
alter function app_private.is_active_super_admin() owner to postgres;
revoke all on function app_private.is_active_super_admin() from public, anon, authenticated;
grant execute on function app_private.is_active_super_admin() to authenticated;

-- SECURITY DEFINER rollover RPCs bypass RLS; close that path explicitly.
create or replace function public.mark_student_rollover_qr_reissued(p_school_year_id uuid, p_student_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_updated integer;
begin
    if (select auth.role()) is distinct from 'authenticated'
       or not (select app_private.is_active_super_admin()) then
        raise exception 'Active AAL2 Super Admin required' using errcode = '42501';
    end if;
    update public.student_id_rollover_qr_queue
       set qr_reissued_at = coalesce(qr_reissued_at, pg_catalog.now())
     where school_year_id = p_school_year_id and student_id = p_student_id;
    get diagnostics v_updated = row_count;
    return v_updated = 1;
end;
$$;

create or replace function public.preview_student_id_rollover(p_school_year_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
    if (select auth.role()) is distinct from 'authenticated'
       or not (select app_private.is_active_super_admin()) then
        raise exception 'Active AAL2 Super Admin required' using errcode = '42501';
    end if;
    return student_rollover_private.summary(p_school_year_id);
end;
$$;

create or replace function public.run_student_id_rollover(p_school_year_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
    if (select auth.role()) is distinct from 'authenticated'
       or not (select app_private.is_active_super_admin()) then
        raise exception 'Active AAL2 Super Admin required' using errcode = '42501';
    end if;
    return student_rollover_private.perform(p_school_year_id, 'manual', (select auth.uid()));
end;
$$;

-- Extend both existing recovery guards to treat a locked account as
-- unavailable. Their advisory lock remains the serialization boundary.
create or replace function app_private.prevent_last_super_admin_loss()
returns trigger language plpgsql security definer set search_path = '' as $$
declare losing_access boolean;
begin
    if tg_op = 'DELETE' then
        losing_access := old.admin_level = 'super_admin' and old.status = 'active'
            and not old.login_locked;
    else
        losing_access := old.admin_level = 'super_admin' and old.status = 'active'
            and not old.login_locked
            and (new.admin_level is distinct from 'super_admin'
                 or new.status is distinct from 'active'
                 or new.login_locked is distinct from false);
    end if;
    if losing_access then
        perform pg_catalog.pg_advisory_xact_lock(20260930, 1);
        if not exists (
            select 1 from public.admins a
            join auth.users u on u.id = a.admin_id
            where a.admin_id <> old.admin_id
              and a.admin_level = 'super_admin' and a.status = 'active'
              and not a.login_locked
              and u.deleted_at is null and u.email_confirmed_at is not null
              and u.encrypted_password is not null and u.encrypted_password <> ''
              and (u.banned_until is null or u.banned_until <= pg_catalog.now())
              and exists (
                  select 1 from auth.mfa_factors f
                  where f.user_id = u.id and f.factor_type = 'totp'
                    and f.status = 'verified'
              )
        ) then
            raise exception 'Cannot remove the last recoverable active Super Admin'
                using errcode = '23514';
        end if;
    end if;
    if tg_op = 'DELETE' then return old; end if;
    return new;
end;
$$;
alter function app_private.prevent_last_super_admin_loss() owner to postgres;
revoke all on function app_private.prevent_last_super_admin_loss() from public, anon, authenticated;
drop trigger if exists protect_last_super_admin on public.admins;
create trigger protect_last_super_admin
before update of admin_level, status, login_locked or delete on public.admins
for each row execute function app_private.prevent_last_super_admin_loss();

create or replace function app_private.prevent_last_super_admin_factor_loss()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_other_factor boolean;
begin
    if old.factor_type <> 'totp' or old.status <> 'verified' then
        if tg_op = 'DELETE' then return old; end if;
        return new;
    end if;
    if tg_op = 'UPDATE' then
        if new.user_id = old.user_id and new.factor_type = 'totp'
           and new.status = 'verified' then
            return new;
        end if;
    end if;
    if not exists (
        select 1 from public.admins a join auth.users u on u.id = a.admin_id
        where a.admin_id = old.user_id and a.admin_level = 'super_admin'
          and a.status = 'active' and not a.login_locked
          and u.deleted_at is null and u.email_confirmed_at is not null
          and u.encrypted_password is not null and u.encrypted_password <> ''
          and (u.banned_until is null or u.banned_until <= pg_catalog.now())
    ) then
        if tg_op = 'DELETE' then return old; end if;
        return new;
    end if;
    perform pg_catalog.pg_advisory_xact_lock(20260930, 1);
    select exists (
        select 1 from auth.mfa_factors f
        where f.user_id = old.user_id and f.id <> old.id
          and f.factor_type = 'totp' and f.status = 'verified'
    ) into v_other_factor;
    if not v_other_factor and not exists (
        select 1 from public.admins a join auth.users u on u.id = a.admin_id
        where a.admin_id <> old.user_id and a.admin_level = 'super_admin'
          and a.status = 'active' and not a.login_locked
          and u.deleted_at is null and u.email_confirmed_at is not null
          and u.encrypted_password is not null and u.encrypted_password <> ''
          and (u.banned_until is null or u.banned_until <= pg_catalog.now())
          and exists (
              select 1 from auth.mfa_factors f
              where f.user_id = a.admin_id and f.factor_type = 'totp'
                and f.status = 'verified'
          )
    ) then
        raise exception 'Cannot remove the last recoverable Super Admin authenticator'
            using errcode = '23514';
    end if;
    if tg_op = 'DELETE' then return old; end if;
    return new;
end;
$$;
alter function app_private.prevent_last_super_admin_factor_loss() owner to postgres;
revoke all on function app_private.prevent_last_super_admin_factor_loss() from public, anon, authenticated;

-- A password that Auth has accepted is not sufficient: the account must still
-- be active and unlocked before the backend releases the Auth session.
create or replace function public.record_admin_password_success(p_admin_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_admin public.admins%rowtype;
begin
    if (select auth.role()) is distinct from 'service_role' then
        raise exception 'Service role required' using errcode = '42501';
    end if;
    select * into v_admin from public.admins
      where admin_id = p_admin_id for update;
    if not found then return pg_catalog.jsonb_build_object('allowed', false, 'locked', false); end if;
    if v_admin.status <> 'active' or v_admin.login_locked then
        return pg_catalog.jsonb_build_object('allowed', false, 'locked', v_admin.login_locked);
    end if;
    if v_admin.failed_login_attempts > 0 then
        update public.admins set failed_login_attempts = 0 where admin_id = p_admin_id;
        insert into public.system_audit_logs
          (user_id, action, module_name, page_name, target_table, target_id, details)
        values (p_admin_id, 'ADMIN_PASSWORD_FAILURES_RESET', 'auth', 'login.html',
                'admins', p_admin_id::text,
                pg_catalog.jsonb_build_object('prior_failed_attempts', v_admin.failed_login_attempts));
    end if;
    return pg_catalog.jsonb_build_object('allowed', true, 'locked', false);
end;
$$;
alter function public.record_admin_password_success(uuid) owner to postgres;
revoke all on function public.record_admin_password_success(uuid) from public, anon, authenticated;
grant execute on function public.record_admin_password_success(uuid) to service_role;

-- Only a currently active, unlocked AAL2 Super Admin can clear a lock. The
-- actor UUID is taken from the verified JWT, never from client JSON.
create or replace function public.unlock_admin_login(p_admin_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor uuid;
v_admin public.admins%rowtype;
begin
    if (select auth.role()) is distinct from 'authenticated'
       or not (select app_private.is_active_super_admin()) then
        raise exception 'Active AAL2 Super Admin required' using errcode = '42501';
    end if;
    v_actor := (select auth.uid());
    select * into v_admin from public.admins where admin_id = p_admin_id for update;
    if not found then return pg_catalog.jsonb_build_object('success', false); end if;
    if not v_admin.login_locked then
        return pg_catalog.jsonb_build_object('success', false);
    end if;
    update public.admins
       set failed_login_attempts = 0, login_locked = false,
           login_locked_at = null, login_unlocked_at = pg_catalog.now(),
           login_unlocked_by = v_actor
     where admin_id = p_admin_id;
    insert into public.system_audit_logs
      (user_id, action, module_name, page_name, target_table, target_id, details)
    values (v_actor, 'ADMIN_LOGIN_UNLOCKED', 'admin', 'usermanagement.html',
            'admins', p_admin_id::text,
            pg_catalog.jsonb_build_object('previous_failed_attempts', v_admin.failed_login_attempts));
    return pg_catalog.jsonb_build_object('success', true);
end;
$$;
alter function public.unlock_admin_login(uuid) owner to postgres;
revoke all on function public.unlock_admin_login(uuid) from public, anon, authenticated;
grant execute on function public.unlock_admin_login(uuid) to authenticated;

-- Supabase Auth must have returned invalid_credentials before the server calls
-- this RPC. Locking the Admin row serializes simultaneous failed passwords
-- from browsers/devices. The existing recovery advisory lock also serializes
-- decisions that might affect the last usable Super Admin.
create or replace function public.record_admin_password_failure(p_email text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_admin public.admins%rowtype;
v_limit integer;
v_attempts integer;
v_lock boolean;
v_recovery_protected boolean := false;
begin
    if (select auth.role()) is distinct from 'service_role' then
        raise exception 'Service role required' using errcode = '42501';
    end if;
    if p_email is null or pg_catalog.length(p_email) > 254 then
        return pg_catalog.jsonb_build_object('known', false, 'attempts', 0,
            'remaining', 0, 'locked', false, 'recovery_protected', false);
    end if;

    select * into v_admin from public.admins
      where pg_catalog.lower(email) = pg_catalog.lower(pg_catalog.btrim(p_email))
      order by admin_id limit 1 for update;
    if not found then
        return pg_catalog.jsonb_build_object('known', false, 'attempts', 0,
            'remaining', 0, 'locked', false, 'recovery_protected', false);
    end if;
    select coalesce((select value::integer from public.system_settings
        where key = 'admin_login_max_attempts'), 3) into v_limit;
    v_attempts := case when v_admin.failed_login_attempts = 2147483647
        then 2147483647 else v_admin.failed_login_attempts + 1 end;
    v_lock := v_admin.login_locked or v_attempts >= v_limit;

    if v_lock and not v_admin.login_locked and
       v_admin.admin_level = 'super_admin' and v_admin.status = 'active' then
        perform pg_catalog.pg_advisory_xact_lock(20260930, 1);
        if not exists (
            select 1 from public.admins a
            join auth.users u on u.id = a.admin_id
            where a.admin_id <> v_admin.admin_id
              and a.admin_level = 'super_admin' and a.status = 'active'
              and not a.login_locked
              and u.deleted_at is null and u.email_confirmed_at is not null
              and u.encrypted_password is not null and u.encrypted_password <> ''
              and (u.banned_until is null or u.banned_until <= pg_catalog.now())
              and exists (
                  select 1 from auth.mfa_factors f
                  where f.user_id = u.id and f.factor_type = 'totp'
                    and f.status = 'verified'
              )
        ) then
            v_lock := false;
            v_recovery_protected := true;
        end if;
    end if;

    update public.admins
       set failed_login_attempts = v_attempts,
           login_locked = v_lock,
           login_locked_at = case when v_lock
               then coalesce(login_locked_at, pg_catalog.now()) else null end
     where admin_id = v_admin.admin_id;
    -- These are pre-authentication attempts. The target is not the actor.
    insert into public.system_audit_logs
      (user_id, action, module_name, page_name, target_table, target_id, details)
    values (null, 'ADMIN_PASSWORD_LOGIN_FAILED', 'auth', 'login.html',
            'admins', v_admin.admin_id::text,
            pg_catalog.jsonb_build_object('actor_type', 'pre_authentication',
                'failed_attempts', v_attempts, 'limit', v_limit,
                'recovery_protected', v_recovery_protected));
    if v_lock and not v_admin.login_locked then
        insert into public.system_audit_logs
          (user_id, action, module_name, page_name, target_table, target_id, details)
        values (null, 'ADMIN_LOGIN_LOCKED', 'auth', 'login.html',
                'admins', v_admin.admin_id::text,
                pg_catalog.jsonb_build_object('actor_type', 'system',
                    'failed_attempts', v_attempts, 'limit', v_limit));
    elsif v_recovery_protected and v_admin.failed_login_attempts < v_limit then
        insert into public.system_audit_logs
          (user_id, action, module_name, page_name, target_table, target_id, details)
        values (null, 'ADMIN_LOCKOUT_RECOVERY_PROTECTED', 'auth', 'login.html',
                'admins', v_admin.admin_id::text,
                pg_catalog.jsonb_build_object('actor_type', 'system',
                    'failed_attempts', v_attempts, 'limit', v_limit));
    end if;
    return pg_catalog.jsonb_build_object('known', true, 'attempts', v_attempts,
        'remaining', greatest(v_limit - v_attempts, 0),
        'locked', v_lock, 'recovery_protected', v_recovery_protected);
end;
$$;
alter function public.record_admin_password_failure(text) owner to postgres;
revoke all on function public.record_admin_password_failure(text) from public, anon, authenticated;
grant execute on function public.record_admin_password_failure(text) to service_role;

commit;
