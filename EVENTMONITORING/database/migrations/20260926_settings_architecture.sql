-- System capabilities and module preferences. Apply after the 20260924 SMS migration.
-- Existing values are preserved on repeat application.
create table if not exists public.system_settings (
    key text primary key,
    value text not null
);

alter table public.system_settings drop constraint if exists system_settings_sms_only;
alter table public.system_settings drop constraint if exists system_settings_supported_values;
alter table public.system_settings add constraint system_settings_supported_values
    check (key not in ('sms_enabled', 'anti_spoof_enabled') or value in ('true', 'false'));

create table if not exists public.gate_settings (
    key text primary key,
    value text not null
);

create table if not exists public.event_settings (
    key text primary key,
    value text not null,
    constraint event_settings_supported_values check (
        (key = 'sms_enabled' and value in ('true', 'false'))
        or (key = 'late_grace_minutes' and value ~ '^(0|[1-9][0-9]?)$')
    )
);

alter table public.system_settings enable row level security;
alter table public.gate_settings enable row level security;
alter table public.event_settings enable row level security;

revoke all on public.system_settings, public.gate_settings, public.event_settings from public, anon, authenticated;
grant select on public.system_settings, public.gate_settings, public.event_settings to anon, authenticated, service_role;
grant insert, update on public.system_settings, public.gate_settings, public.event_settings to authenticated, service_role;

drop policy if exists "Read attendance SMS setting" on public.system_settings;
drop policy if exists "Super admins insert attendance SMS setting" on public.system_settings;
drop policy if exists "Super admins update attendance SMS setting" on public.system_settings;
drop policy if exists "Read system capabilities" on public.system_settings;
drop policy if exists "Super admins insert system capabilities" on public.system_settings;
drop policy if exists "Super admins update system capabilities" on public.system_settings;
create policy "Read system capabilities" on public.system_settings for select
    to anon, authenticated using (key in ('sms_enabled', 'anti_spoof_enabled'));
create policy "Super admins insert system capabilities" on public.system_settings for insert
    to authenticated with check (
        key in ('sms_enabled', 'anti_spoof_enabled')
        and exists (select 1 from public.admins where admin_id = (select auth.uid())
                and admin_level = 'super_admin' and status = 'active')
    );
create policy "Super admins update system capabilities" on public.system_settings for update
    to authenticated using (
        key in ('sms_enabled', 'anti_spoof_enabled')
        and exists (select 1 from public.admins where admin_id = (select auth.uid())
                and admin_level = 'super_admin' and status = 'active')
    ) with check (
        key in ('sms_enabled', 'anti_spoof_enabled')
        and exists (select 1 from public.admins where admin_id = (select auth.uid())
                and admin_level = 'super_admin' and status = 'active')
    );
-- Restrictive policies also protect writes if an older permissive policy exists.
drop policy if exists "System capability insert boundary" on public.system_settings;
drop policy if exists "System capability update boundary" on public.system_settings;
create policy "System capability insert boundary" on public.system_settings as restrictive for insert
    to authenticated with check (key in ('sms_enabled', 'anti_spoof_enabled') and exists (
        select 1 from public.admins where admin_id = (select auth.uid())
            and admin_level = 'super_admin' and status = 'active'));
create policy "System capability update boundary" on public.system_settings as restrictive for update
    to authenticated using (key in ('sms_enabled', 'anti_spoof_enabled') and exists (
        select 1 from public.admins where admin_id = (select auth.uid())
            and admin_level = 'super_admin' and status = 'active'))
    with check (key in ('sms_enabled', 'anti_spoof_enabled') and exists (
        select 1 from public.admins where admin_id = (select auth.uid())
            and admin_level = 'super_admin' and status = 'active'));

drop policy if exists "Read gate preferences" on public.gate_settings;
drop policy if exists "Admins insert gate preferences" on public.gate_settings;
drop policy if exists "Admins update gate preferences" on public.gate_settings;
create policy "Read gate preferences" on public.gate_settings for select to anon, authenticated using (true);
create policy "Admins insert gate preferences" on public.gate_settings for insert to authenticated
    with check (exists (select 1 from public.admins where admin_id = (select auth.uid()) and status = 'active'));
create policy "Admins update gate preferences" on public.gate_settings for update to authenticated
    using (exists (select 1 from public.admins where admin_id = (select auth.uid()) and status = 'active'))
    with check (exists (select 1 from public.admins where admin_id = (select auth.uid()) and status = 'active'));
drop policy if exists "Gate preference insert boundary" on public.gate_settings;
drop policy if exists "Gate preference update boundary" on public.gate_settings;
create policy "Gate preference insert boundary" on public.gate_settings as restrictive for insert to authenticated
    with check (exists (select 1 from public.admins where admin_id = (select auth.uid()) and status = 'active'));
create policy "Gate preference update boundary" on public.gate_settings as restrictive for update to authenticated
    using (exists (select 1 from public.admins where admin_id = (select auth.uid()) and status = 'active'))
    with check (exists (select 1 from public.admins where admin_id = (select auth.uid()) and status = 'active'));

drop policy if exists "Read event preferences" on public.event_settings;
drop policy if exists "Admins insert event preferences" on public.event_settings;
drop policy if exists "Admins update event preferences" on public.event_settings;
create policy "Read event preferences" on public.event_settings for select to anon, authenticated using (true);
create policy "Admins insert event preferences" on public.event_settings for insert to authenticated
    with check (exists (select 1 from public.admins where admin_id = (select auth.uid()) and status = 'active'));
create policy "Admins update event preferences" on public.event_settings for update to authenticated
    using (exists (select 1 from public.admins where admin_id = (select auth.uid()) and status = 'active'))
    with check (exists (select 1 from public.admins where admin_id = (select auth.uid()) and status = 'active'));
drop policy if exists "Event preference insert boundary" on public.event_settings;
drop policy if exists "Event preference update boundary" on public.event_settings;
create policy "Event preference insert boundary" on public.event_settings as restrictive for insert to authenticated
    with check (exists (select 1 from public.admins where admin_id = (select auth.uid()) and status = 'active'));
create policy "Event preference update boundary" on public.event_settings as restrictive for update to authenticated
    using (exists (select 1 from public.admins where admin_id = (select auth.uid()) and status = 'active'))
    with check (exists (select 1 from public.admins where admin_id = (select auth.uid()) and status = 'active'));

insert into public.system_settings (key, value) values
    ('sms_enabled', 'true'), ('anti_spoof_enabled', 'true')
on conflict (key) do nothing;
insert into public.gate_settings (key, value) values ('sms_enabled', 'true')
on conflict (key) do nothing;
insert into public.event_settings (key, value) values
    ('sms_enabled', 'true'), ('late_grace_minutes', '15')
on conflict (key) do nothing;
