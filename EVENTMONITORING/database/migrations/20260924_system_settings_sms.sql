-- Shared switch for guardian SMS from event attendance and school gate scans.
create table public.system_settings (
    key text primary key,
    value text not null,
    constraint system_settings_sms_only check (key = 'sms_enabled' and value in ('true', 'false'))
);

alter table public.system_settings enable row level security;

-- The attendance engine may use an anon or service-role key; only the switch is readable.
revoke all on table public.system_settings from public, anon, authenticated, service_role;
grant select on table public.system_settings to anon, authenticated, service_role;
grant insert, update on table public.system_settings to authenticated;

create policy "Read attendance SMS setting"
on public.system_settings for select
to anon, authenticated
using (key = 'sms_enabled');

create policy "Super admins insert attendance SMS setting"
on public.system_settings for insert
to authenticated
with check (
    key = 'sms_enabled'
    and exists (
        select 1 from public.admins
        where admin_id = (select auth.uid())
          and admin_level = 'super_admin'
          and status = 'active'
    )
);

create policy "Super admins update attendance SMS setting"
on public.system_settings for update
to authenticated
using (
    key = 'sms_enabled'
    and exists (
        select 1 from public.admins
        where admin_id = (select auth.uid())
          and admin_level = 'super_admin'
          and status = 'active'
    )
)
with check (
    key = 'sms_enabled'
    and exists (
        select 1 from public.admins
        where admin_id = (select auth.uid())
          and admin_level = 'super_admin'
          and status = 'active'
    )
);

insert into public.system_settings (key, value) values ('sms_enabled', 'true');
