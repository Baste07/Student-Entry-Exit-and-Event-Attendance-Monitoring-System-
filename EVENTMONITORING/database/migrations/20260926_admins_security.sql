-- Apply this migration before 20260926_settings_architecture.sql.
-- The browser may read its own admin profile; only an active Super Admin may
-- list or update other profiles. Account creation/deletion uses server-side
-- service-role endpoints after verifying the caller's Supabase Auth token.

begin;

create schema if not exists app_private;
revoke all on schema app_private from public, anon;

create or replace function app_private.is_active_super_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select exists (
        select 1
        from public.admins as a
        where a.admin_id = (select auth.uid())
          and a.admin_level = 'super_admin'
          and a.status = 'active'
    );
$$;

-- The definer must bypass admins RLS to avoid a recursive policy lookup.
alter function app_private.is_active_super_admin() owner to postgres;
revoke all on function app_private.is_active_super_admin() from public, anon, authenticated;
grant usage on schema app_private to authenticated;
grant execute on function app_private.is_active_super_admin() to authenticated;

alter table public.admins enable row level security;

-- Existing grants include TRUNCATE and access to the legacy plaintext password
-- column. RLS cannot protect TRUNCATE, so replace table grants completely.
revoke all on table public.admins from public, anon, authenticated;
grant select (admin_id, email, admin_name, admin_level, profile_picture,
              status, created_at, updated_at, faculty)
    on table public.admins to authenticated;
grant update (admin_name, faculty, admin_level, status, updated_at)
    on table public.admins to authenticated;

drop policy if exists "Enable read for authenticated users" on public.admins;
drop policy if exists "Enable insert for authenticated users" on public.admins;
drop policy if exists "Enable update for authenticated users" on public.admins;
drop policy if exists "Enable delete for authenticated users" on public.admins;
drop policy if exists "Read own admin profile or manage admins" on public.admins;
drop policy if exists "Active Super Admins update admin profiles" on public.admins;

create policy "Read own admin profile or manage admins"
on public.admins for select to authenticated
using (
    admin_id = (select auth.uid())
    or (select app_private.is_active_super_admin())
);

create policy "Active Super Admins update admin profiles"
on public.admins for update to authenticated
using ((select app_private.is_active_super_admin()))
with check ((select app_private.is_active_super_admin()));

-- No authenticated INSERT or DELETE grant/policy: creation and deletion go
-- through server-side service-role endpoints. Leave service_role grants intact
-- for those endpoints and Supabase Auth's foreign-key cleanup.

commit;
