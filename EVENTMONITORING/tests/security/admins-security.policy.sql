-- STAGING/LOCAL ONLY. Run with psql after 20260926_admins_security.sql.
-- Requires at least one active regular admin and one active Super Admin.
-- All profile changes below are rolled back. Never run this on production.
\set ON_ERROR_STOP on
begin;

do $$
declare
    normal_id uuid;
    super_id uuid;
    total_count integer;
begin
    select admin_id into normal_id from public.admins
    where admin_level = 'admin' and status = 'active' limit 1;
    select admin_id into super_id from public.admins
    where admin_level = 'super_admin' and status = 'active' limit 1;
    if normal_id is null or super_id is null then
        raise exception 'Seed an active normal Admin and Super Admin first';
    end if;
    select count(*) into total_count from public.admins;
    perform set_config('security_test.normal_id', normal_id::text, true);
    perform set_config('security_test.super_id', super_id::text, true);
    perform set_config('security_test.total_count', total_count::text, true);

    if has_table_privilege('authenticated', 'public.admins', 'INSERT')
        or has_table_privilege('authenticated', 'public.admins', 'DELETE')
        or has_table_privilege('authenticated', 'public.admins', 'TRUNCATE')
        or has_table_privilege('anon', 'public.admins', 'TRUNCATE')
        or has_table_privilege('anon', 'public.admins', 'SELECT')
        or has_column_privilege('authenticated', 'public.admins', 'password', 'SELECT')
        or has_column_privilege('authenticated', 'public.admins', 'password', 'UPDATE')
        or has_column_privilege('authenticated', 'public.admins', 'admin_id', 'UPDATE')
        or has_column_privilege('authenticated', 'public.admins', 'email', 'UPDATE') then
        raise exception 'Authenticated grants exceed the planned admin boundary';
    end if;
    if not has_table_privilege('service_role', 'public.admins', 'SELECT')
        or not has_table_privilege('service_role', 'public.admins', 'INSERT')
        or not has_table_privilege('service_role', 'public.admins', 'UPDATE')
        or not has_table_privilege('service_role', 'public.admins', 'DELETE') then
        raise exception 'Service-role account operations are not available';
    end if;
end $$;

set local role authenticated;
select set_config('request.jwt.claim.sub', current_setting('security_test.normal_id'), true);
do $$
declare
    changed integer;
begin
    if (select count(*) from public.admins) <> 1 then
        raise exception 'Normal Admin must see only their own profile';
    end if;
    if (select app_private.is_active_super_admin()) then
        raise exception 'Normal Admin passed the Super Admin predicate';
    end if;
    update public.admins set admin_level = 'super_admin'
    where admin_id = current_setting('security_test.normal_id')::uuid;
    get diagnostics changed = row_count;
    if changed <> 0 then raise exception 'Normal Admin promoted themselves'; end if;

    update public.admins set status = 'suspended'
    where admin_id = current_setting('security_test.normal_id')::uuid;
    get diagnostics changed = row_count;
    if changed <> 0 then raise exception 'Normal Admin changed their own status'; end if;

    update public.admins set status = 'active'
    where admin_id = current_setting('security_test.super_id')::uuid;
    get diagnostics changed = row_count;
    if changed <> 0 then raise exception 'Normal Admin changed another Admin'; end if;

    update public.admins set admin_name = 'unauthorized'
    where admin_id = current_setting('security_test.normal_id')::uuid;
    get diagnostics changed = row_count;
    if changed <> 0 then raise exception 'Normal Admin changed their own protected profile'; end if;

    begin
        perform password from public.admins limit 1;
        raise exception 'Normal Admin read the legacy password column';
    exception when insufficient_privilege then null;
    end;
    begin
        insert into public.admins (admin_id, email, password, admin_name, admin_level, status)
        values (current_setting('security_test.normal_id')::uuid,
                'not-created@example.invalid', 'unused', 'Not Created', 'super_admin', 'active');
        raise exception 'Normal Admin inserted an admin profile';
    exception when insufficient_privilege then null;
    end;
    begin
        delete from public.admins
        where admin_id = current_setting('security_test.normal_id')::uuid;
        raise exception 'Normal Admin deleted an admin profile';
    exception when insufficient_privilege then null;
    end;
end $$;

select set_config('request.jwt.claim.sub', current_setting('security_test.super_id'), true);
do $$
declare
    changed integer;
begin
    if (select count(*) from public.admins) <> current_setting('security_test.total_count')::integer then
        raise exception 'Super Admin cannot list all profiles';
    end if;
    if not (select app_private.is_active_super_admin()) then
        raise exception 'Super Admin failed the authorization predicate';
    end if;
    update public.admins set admin_level = 'super_admin', status = 'suspended'
    where admin_id = current_setting('security_test.normal_id')::uuid;
    get diagnostics changed = row_count;
    if changed <> 1 then raise exception 'Super Admin cannot manage a profile'; end if;
    begin
        insert into public.admins (admin_id, email, password, admin_name, admin_level, status)
        values (current_setting('security_test.normal_id')::uuid,
                'not-created@example.invalid', 'unused', 'Not Created', 'admin', 'active');
        raise exception 'Browser Super Admin unexpectedly has direct INSERT';
    exception when insufficient_privilege then null;
    end;
    begin
        delete from public.admins
        where admin_id = current_setting('security_test.normal_id')::uuid;
        raise exception 'Browser Super Admin unexpectedly has direct DELETE';
    exception when insufficient_privilege then null;
    end;
end $$;

rollback;
