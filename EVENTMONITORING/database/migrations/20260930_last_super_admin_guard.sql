-- Prevent profile changes that remove the last independently recoverable
-- Super Admin. Install with the MFA application code, after the AAL2 migration.
begin;

create or replace function app_private.prevent_last_super_admin_loss()
returns trigger language plpgsql security definer set search_path = '' as $$
declare losing_access boolean;
begin
    if tg_op = 'DELETE' then
        losing_access := old.admin_level = 'super_admin' and old.status = 'active';
    else
        losing_access := old.admin_level = 'super_admin' and old.status = 'active'
            and (new.admin_level is distinct from 'super_admin'
                 or new.status is distinct from 'active');
    end if;
    if losing_access then
        -- Serialize concurrent suspensions/deletions so two transactions cannot
        -- each count the other as the remaining recovery administrator.
        perform pg_catalog.pg_advisory_xact_lock(20260930, 1);
        if not exists (
            select 1 from public.admins a
            join auth.users u on u.id = a.admin_id
            where a.admin_id <> old.admin_id
              and a.admin_level = 'super_admin' and a.status = 'active'
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
before update of admin_level, status or delete on public.admins
for each row execute function app_private.prevent_last_super_admin_loss();

-- Profile changes are only half of recovery safety. Auth can also remove or
-- invalidate a TOTP factor independently of the admins row. Serialize both
-- triggers on the same transaction lock so concurrent profile/factor changes
-- cannot each see the other account as the remaining recovery administrator.
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
          and a.status = 'active' and u.deleted_at is null
          and u.email_confirmed_at is not null
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
          and a.status = 'active' and u.deleted_at is null
          and u.email_confirmed_at is not null
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

drop trigger if exists protect_last_super_admin_factor on auth.mfa_factors;
create trigger protect_last_super_admin_factor
before update of user_id, factor_type, status or delete on auth.mfa_factors
for each row execute function app_private.prevent_last_super_admin_factor_loss();

commit;
