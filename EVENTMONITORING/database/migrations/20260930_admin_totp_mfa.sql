-- Mandatory AAL2 for administrator Data API access. Deploy only together with
-- the browser MFA flow and AAL2 checks in privileged PHP endpoints.
-- AAL1 retains only the caller's admins profile SELECT for enrollment routing.
begin;

create schema if not exists app_private;
revoke all on schema app_private from public, anon;
grant usage on schema app_private to authenticated;

create or replace function app_private.is_active_admin_aal2()
returns boolean language sql stable security definer set search_path = '' as $$
  select (select auth.jwt()->>'aal') = 'aal2' and exists (
    select 1 from public.admins where admin_id = (select auth.uid())
      and admin_level in ('admin', 'super_admin') and status = 'active');
$$;
alter function app_private.is_active_admin_aal2() owner to postgres;
revoke all on function app_private.is_active_admin_aal2() from public, anon, authenticated;
grant execute on function app_private.is_active_admin_aal2() to authenticated;

-- Existing settings/student policies call this helper, so replacing it closes
-- their AAL1 path while keeping service-role and scheduled database work intact.
create or replace function app_private.is_active_super_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select (select auth.jwt()->>'aal') = 'aal2' and exists (
    select 1 from public.admins where admin_id = (select auth.uid())
      and admin_level = 'super_admin' and status = 'active');
$$;
alter function app_private.is_active_super_admin() owner to postgres;
revoke all on function app_private.is_active_super_admin() from public, anon, authenticated;
grant execute on function app_private.is_active_super_admin() to authenticated;

-- admins: keep the hardened SELECT policy. It exposes only one's own profile
-- at AAL1; its Super Admin branch now requires AAL2 through the helper above.
-- The UPDATE policy also calls that helper. No browser INSERT/DELETE grants.

-- The development fixture revealed legacy anon grants and RLS-disabled tables.
-- Restrict anonymous data access first; otherwise an AAL1 browser could drop
-- its Authorization header and bypass an authenticated-only MFA policy.
do $$
declare t record;
begin
  for t in select c.oid, c.relname, c.relrowsecurity
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p')
      and c.relname = any (array[
        'students','sections','school_years','semesters','subjects',
        'employees','teachers','guardians','student_guardians',
        'events','event_participants','event_attendance',
        'laboratory_rooms','lab_schedules','schedule_enrollments',
        'lab_sessions','lab_attendance','las_reports',
        'entry_exit_logs','daily_attendance','attendance_reports',
        'system_settings','gate_settings','event_settings',
        'system_audit_logs','spoof_attempts','sms_notifications',
        'student_id_rollovers','student_id_rollover_changes',
        'student_id_rollover_qr_queue'
      ])
  loop
    if t.relname in ('system_settings', 'gate_settings', 'event_settings',
                     'school_years', 'sections') then
      execute format('revoke insert, update, delete, truncate, references, trigger on table public.%I from public, anon', t.relname);
    else
      execute format('revoke all on table public.%I from public, anon', t.relname);
    end if;
    if not t.relrowsecurity then
      execute format('alter table public.%I enable row level security', t.relname);
      -- On formerly RLS-disabled tables, preserve authenticated access at
      -- AAL2; existing SQL grants still determine which commands are possible.
      execute format('create policy "Authenticated access after MFA" on public.%I for all to authenticated using (true) with check (true)', t.relname);
    end if;
    execute format('drop policy if exists "Admin MFA boundary" on public.%I', t.relname);
    execute format('create policy "Admin MFA boundary" on public.%I as restrictive for all to authenticated using ((select app_private.is_active_admin_aal2())) with check ((select app_private.is_active_admin_aal2()))', t.relname);
  end loop;
end;
$$;

-- Remove the temporary helper if an earlier development draft installed it.
drop function if exists app_private.is_admin_identity();

-- Audit history must not be editable or erasable from the browser. Existing
-- application audit inserts use the signed-in administrator's own UUID.
do $$ begin
  if to_regclass('public.system_audit_logs') is not null then
    revoke all on table public.system_audit_logs from public, anon, authenticated;
    grant select, insert on table public.system_audit_logs to authenticated;
    -- Legacy permissive policies would OR with the own-user policy below.
    drop policy if exists "Allow inserts for authenticated users" on public.system_audit_logs;
    drop policy if exists "Allow reads for authenticated users" on public.system_audit_logs;
    drop policy if exists "Authenticated access after MFA" on public.system_audit_logs;
    drop policy if exists "AAL2 admins read audit" on public.system_audit_logs;
    drop policy if exists "AAL2 admins append own audit" on public.system_audit_logs;
    create policy "AAL2 admins read audit" on public.system_audit_logs
      for select to authenticated
      using ((select app_private.is_active_admin_aal2()));
    create policy "AAL2 admins append own audit" on public.system_audit_logs
      for insert to authenticated
      with check ((select app_private.is_active_admin_aal2())
                  and user_id = (select auth.uid()));
  end if;
end;
$$;

-- The three rollover RPCs are SECURITY DEFINER and bypass table RLS. Require
-- AAL2 inside those functions as well; the scheduled private runner is untouched.
create or replace function public.mark_student_rollover_qr_reissued(p_school_year_id uuid, p_student_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_updated integer;
begin
    if (select auth.role()) is distinct from 'authenticated'
       or (select auth.jwt()->>'aal') is distinct from 'aal2'
       or not exists (select 1 from public.admins
                       where admin_id = (select auth.uid())
                         and admin_level = 'super_admin' and status = 'active') then
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
       or (select auth.jwt()->>'aal') is distinct from 'aal2'
       or not exists (select 1 from public.admins
                       where admin_id = (select auth.uid())
                         and admin_level = 'super_admin' and status = 'active') then
        raise exception 'Active AAL2 Super Admin required' using errcode = '42501';
    end if;
    return student_rollover_private.summary(p_school_year_id);
end;
$$;

create or replace function public.run_student_id_rollover(p_school_year_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
    if (select auth.role()) is distinct from 'authenticated'
       or (select auth.jwt()->>'aal') is distinct from 'aal2'
       or not exists (select 1 from public.admins
                       where admin_id = (select auth.uid())
                         and admin_level = 'super_admin' and status = 'active') then
        raise exception 'Active AAL2 Super Admin required' using errcode = '42501';
    end if;
    return student_rollover_private.perform(p_school_year_id, 'manual', (select auth.uid()));
end;
$$;

commit;
