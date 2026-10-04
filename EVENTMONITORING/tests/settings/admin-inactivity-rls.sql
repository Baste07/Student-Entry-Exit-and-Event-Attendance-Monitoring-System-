-- Non-persistent role checks for 20261005_admin_inactivity_timeout.sql.
-- Run only after explicitly verifying the intended target project.

begin;
set local role anon;
do $$ begin
  if (select count(*) from public.system_settings
      where key = 'admin_inactivity_timeout_minutes') <> 0 then
    raise exception 'Anonymous user could read Admin timeout';
  end if;
  if (select count(*) from public.system_settings
      where key = 'sms_enabled') <> 1 then
    raise exception 'Existing anonymous Master SMS read was broken';
  end if;
  if has_table_privilege(current_user, 'public.system_settings', 'UPDATE') then
    raise exception 'Anonymous user could update system settings';
  end if;
end $$;
rollback;

begin;
do $$ begin
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', (select admin_id::text from public.admins
            where admin_level = 'admin' and status = 'active' limit 1),
    'role', 'authenticated', 'aal', 'aal1')::text, true);
end $$;
set local role authenticated;
do $$ begin
  if (select count(*) from public.system_settings
      where key = 'admin_inactivity_timeout_minutes') <> 0 then
    raise exception 'AAL1 Admin could read Admin timeout';
  end if;
  update public.system_settings set value = '5'
    where key = 'admin_inactivity_timeout_minutes';
  if found then raise exception 'AAL1 Admin could edit Admin timeout'; end if;
end $$;
rollback;

begin;
do $$ begin
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', (select admin_id::text from public.admins
            where admin_level = 'admin' and status = 'active' limit 1),
    'role', 'authenticated', 'aal', 'aal2')::text, true);
end $$;
set local role authenticated;
do $$ begin
  if (select count(*) from public.system_settings
      where key = 'admin_inactivity_timeout_minutes') <> 1 then
    raise exception 'AAL2 Admin could not read Admin timeout';
  end if;
  update public.system_settings set value = '5'
    where key = 'admin_inactivity_timeout_minutes';
  if found then raise exception 'AAL2 normal Admin could edit Admin timeout'; end if;
end $$;
rollback;

begin;
do $$ begin
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', (select admin_id::text from public.admins
            where admin_level = 'super_admin' and status = 'active' limit 1),
    'role', 'authenticated', 'aal', 'aal1')::text, true);
end $$;
set local role authenticated;
do $$ begin
  if (select count(*) from public.system_settings
      where key = 'admin_inactivity_timeout_minutes') <> 0 then
    raise exception 'AAL1 Super Admin could read Admin timeout';
  end if;
  update public.system_settings set value = '5'
    where key = 'admin_inactivity_timeout_minutes';
  if found then raise exception 'AAL1 Super Admin could edit Admin timeout'; end if;
end $$;
rollback;

begin;
do $$ begin
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', (select admin_id::text from public.admins
            where admin_level = 'super_admin' and status = 'active' limit 1),
    'role', 'authenticated', 'aal', 'aal2')::text, true);
end $$;
set local role authenticated;
do $$ begin
  if (select count(*) from public.system_settings
      where key = 'admin_inactivity_timeout_minutes') <> 1 then
    raise exception 'AAL2 Super Admin could not read Admin timeout';
  end if;
  update public.system_settings set value = '3'
    where key = 'admin_inactivity_timeout_minutes';
  if not found then raise exception 'AAL2 Super Admin could not save 3'; end if;
  update public.system_settings set value = '15'
    where key = 'admin_inactivity_timeout_minutes';
  if not found then raise exception 'AAL2 Super Admin could not save 15'; end if;
  begin
    update public.system_settings set value = '2'
      where key = 'admin_inactivity_timeout_minutes';
    raise exception 'Database accepted 2 minutes';
  exception when check_violation then null;
  end;
end $$;
rollback;
