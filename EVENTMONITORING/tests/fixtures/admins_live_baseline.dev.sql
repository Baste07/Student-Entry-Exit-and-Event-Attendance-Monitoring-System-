-- Development-project fixture only. Mirrors the live admins structure and
-- pre-hardening policies inspected on 2026-09-26; never apply to production.
begin;

create type public.account_status as enum ('active', 'inactive', 'suspended');

create table public.admins (
    admin_id uuid primary key references auth.users(id),
    email varchar not null unique,
    password text not null,
    admin_name varchar,
    admin_level varchar not null default 'admin'
        check (admin_level in ('admin', 'super_admin')),
    profile_picture text,
    status public.account_status default 'active',
    created_at timestamptz default now(),
    updated_at timestamptz default now(),
    faculty text
);

alter table public.admins enable row level security;
grant all on public.admins to anon, authenticated, service_role;

create policy "Enable read for authenticated users"
on public.admins for select to authenticated using (true);
create policy "Enable insert for authenticated users"
on public.admins for insert to authenticated with check (true);
create policy "Enable update for authenticated users"
on public.admins for update to authenticated using (true) with check (true);
create policy "Enable delete for authenticated users"
on public.admins for delete to authenticated using (true);

commit;
