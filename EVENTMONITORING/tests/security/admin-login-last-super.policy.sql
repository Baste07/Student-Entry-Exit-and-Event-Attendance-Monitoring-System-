-- Development-only rollback test. It transiently exercises the last verified-
-- TOTP Super Admin account and must never be run against Production.
begin;
select pg_catalog.set_config('request.jwt.claim.role', 'service_role', true);
select pg_catalog.set_config('request.jwt.claims', '{"role":"service_role"}', true);

do $$
declare v_id uuid;
v_email text;
v_factor uuid;
v_result jsonb;
v_count integer;
begin
    select a.admin_id, a.email into v_id, v_email
    from public.admins a join auth.users u on u.id = a.admin_id
    where a.admin_level = 'super_admin' and a.status = 'active'
      and not a.login_locked and u.deleted_at is null
      and u.email_confirmed_at is not null
      and u.encrypted_password is not null and u.encrypted_password <> ''
      and (u.banned_until is null or u.banned_until <= pg_catalog.now())
      and exists (select 1 from auth.mfa_factors f where f.user_id = a.admin_id
                  and f.factor_type = 'totp' and f.status = 'verified');
    select count(*) into v_count
    from public.admins a join auth.users u on u.id = a.admin_id
    where a.admin_level = 'super_admin' and a.status = 'active'
      and not a.login_locked and u.deleted_at is null
      and u.email_confirmed_at is not null
      and u.encrypted_password is not null and u.encrypted_password <> ''
      and (u.banned_until is null or u.banned_until <= pg_catalog.now())
      and exists (select 1 from auth.mfa_factors f where f.user_id = a.admin_id
                  and f.factor_type = 'totp' and f.status = 'verified');
    if v_count <> 1 or v_id is null then
        raise exception 'Expected exactly one recoverable development Super Admin';
    end if;
    select f.id into v_factor from auth.mfa_factors f
      where f.user_id = v_id and f.factor_type = 'totp' and f.status = 'verified'
      limit 1;
    if (select count(*) from auth.mfa_factors f where f.user_id = v_id
        and f.factor_type = 'totp' and f.status = 'verified') <> 1 then
        raise exception 'Expected one verified development authenticator';
    end if;

    for v_count in 1..4 loop
        v_result := public.record_admin_password_failure(v_email);
        if (v_result->>'known')::boolean is distinct from true or
           (v_result->>'locked')::boolean is distinct from false or
           (v_result->>'recovery_protected')::boolean is distinct from (v_count >= 3) then
            raise exception 'Last recoverable Super Admin lockout policy failed';
        end if;
    end loop;
    if not exists (select 1 from public.admins where admin_id = v_id
        and not login_locked and failed_login_attempts = 4) then
        raise exception 'Protected Super Admin counter/lock state is wrong';
    end if;

    begin
        update public.admins set login_locked = true, login_locked_at = pg_catalog.now()
          where admin_id = v_id;
        raise exception 'Last-Super-Admin profile guard did not block locking';
    exception when check_violation then null;
    end;

    begin
        delete from auth.mfa_factors where id = v_factor;
        raise exception 'Last-Super-Admin factor guard did not block removal';
    exception when check_violation then null;
    end;

    v_result := public.record_admin_password_success(v_id);
    if (v_result->>'allowed')::boolean is distinct from true or
       not exists (select 1 from public.admins where admin_id = v_id
           and not login_locked and failed_login_attempts = 0) then
        raise exception 'Successful recovery password must reset failures';
    end if;
end;
$$;
rollback;
