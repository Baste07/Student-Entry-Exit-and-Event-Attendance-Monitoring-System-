-- DEVELOPMENT PROJECT ONLY. Minimal student/academic tables matching the live
-- column types and constraints needed by the rollover migration and smoke test.
-- Never apply this fixture to production.
begin;

create table public.school_years (
    id uuid primary key default gen_random_uuid(),
    name varchar not null,
    start_date date not null,
    end_date date not null,
    is_active boolean default false,
    created_at timestamptz default now()
);
create table public.sections (
    section_id uuid primary key default gen_random_uuid(),
    grade_level varchar not null check (grade_level in
        ('Kinder','Grade 1','Grade 2','Grade 3','Grade 4','Grade 5',
         'Grade 6','Grade 7','Grade 8','Grade 9','Grade 10')),
    section_name varchar not null,
    school_year_id uuid references public.school_years(id),
    created_at timestamptz default now(),
    updated_at timestamptz default now()
);
create table public.students (
    student_id uuid primary key default gen_random_uuid(),
    stud_id varchar not null unique check (stud_id ~ '^([Kk]|[1-9]|10)-[0-9]{1,4}$'),
    first_name varchar not null,
    middle_name varchar,
    last_name varchar not null,
    birth_date date,
    gender varchar,
    section_id uuid references public.sections(section_id),
    school_year_id uuid references public.school_years(id),
    status public.account_status default 'active',
    email varchar,
    facial_dataset_path text,
    created_at timestamptz default now(),
    updated_at timestamptz default now()
);
create table public.system_audit_logs (
    id uuid primary key default gen_random_uuid(),
    user_id uuid,
    action text not null,
    module_name text,
    page_name text,
    target_table text,
    target_id text,
    details jsonb,
    created_at timestamptz default now()
);

-- Small relational fixtures prove the UUID link survives a display-ID change.
create table public.student_guardians (
    id uuid primary key default gen_random_uuid(),
    student_id uuid not null references public.students(student_id)
);
create table public.event_participants (
    id uuid primary key default gen_random_uuid(),
    student_id uuid not null references public.students(student_id)
);
create table public.event_attendance (
    id uuid primary key default gen_random_uuid(),
    student_id uuid not null references public.students(student_id)
);
create table public.entry_exit_logs (
    id uuid primary key default gen_random_uuid(),
    student_id uuid references public.students(student_id)
);

alter table public.school_years enable row level security;
alter table public.sections enable row level security;
alter table public.students enable row level security;
grant select on public.school_years, public.sections, public.students to authenticated;
create policy "Fixture read school years" on public.school_years for select to authenticated using (true);
create policy "Fixture read sections" on public.sections for select to authenticated using (true);
create policy "Fixture read students" on public.students for select to authenticated using (true);

commit;
